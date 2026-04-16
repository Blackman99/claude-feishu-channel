import { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./util/logger.js";
import { StateStore, type State } from "./persistence/state-store.js";
import { AccessControl } from "./access.js";
import { FeishuClient } from "./feishu/client.js";
import { FeishuGateway } from "./feishu/gateway.js";
import { checkClaudeCli } from "./claude/preflight.js";
import { createSdkQueryFn } from "./claude/sdk-query.js";
import { ClaudeSessionManager } from "./claude/session-manager.js";
import { checkCodexCli } from "./codex/preflight.js";
import { checkCodexSdkInstalled, createCodexQueryFn } from "./codex/sdk-run.js";
import { InterruptedError } from "./claude/session.js";
import { FeishuPermissionBroker } from "./claude/feishu-permission-broker.js";
import { FeishuQuestionBroker } from "./claude/feishu-question-broker.js";
import { RealClock } from "./util/clock.js";
import { parseInput } from "./commands/router.js";
import { CommandDispatcher } from "./commands/dispatcher.js";
import type { RenderEvent } from "./claude/render-event.js";
import {
  buildAnswerCard,
  buildIntermediateRepliesCard,
  buildStatusCard,
  buildThinkingCard,
  buildToolActivityCard,
  prepareInline,
  renderToolActivityBody,
  STATUS_ELEMENT_ID,
  THINKING_ELEMENT_ID,
  TOOL_ACTIVITY_ELEMENT_ID,
  type ToolActivityEntry,
} from "./feishu/cards.js";
import { formatToolParams } from "./feishu/tool-formatters.js";
import {
  formatResultTip,
  formatErrorText,
  formatQueuedTip,
  formatInterruptDropAck,
  formatStopAck,
} from "./feishu/messages.js";
import type { IncomingMessage } from "./types.js";
import { detectLocale, t } from "./util/i18n.js";

function resolveConfigPath(override?: string): string {
  if (override) return override;
  const envOverride = process.env["CLAUDE_FEISHU_CONFIG"];
  if (envOverride) return envOverride;
  return join(homedir(), ".claude-feishu-channel", "config.toml");
}

export async function main(configPathOverride?: string): Promise<void> {
  const configPath = resolveConfigPath(configPathOverride);

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      console.error(
        `[config] Expected at: ${configPath}\n` +
          `[config] See config.example.toml for a template.`,
      );
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({
    level: config.logging.level,
    pretty: process.stdout.isTTY ?? false,
  });

  logger.info({ configPath }, "Config loaded");

  const defaultProvider = config.agent.defaultProvider;
  let preflight;
  if (defaultProvider === "codex") {
    preflight = await checkCodexCli(config.codex.cliPath);
    if (!preflight.ok) {
      console.error(`[preflight] ${preflight.reason}`);
      process.exit(1);
    }
    try {
      await checkCodexSdkInstalled();
    } catch (err) {
      console.error(
        `[preflight] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  } else {
    preflight = await checkClaudeCli(config.claude.cliPath);
    if (!preflight.ok) {
      console.error(`[preflight] ${preflight.reason}`);
      process.exit(1);
    }
  }
  logger.info(
    {
      provider: defaultProvider,
      cliPath: defaultProvider === "codex" ? config.codex.cliPath : config.claude.cliPath,
      version: preflight.version,
    },
    `${defaultProvider === "codex" ? "Codex" : "Claude"} CLI preflight ok`,
  );

  const stateStore = new StateStore(config.persistence.stateFile);
  const state = await stateStore.load();
  const wasCleanShutdown = state.lastCleanShutdown;
  logger.info(
    { lastCleanShutdown: wasCleanShutdown },
    "State store loaded",
  );
  await stateStore.markUncleanAtStartup(state);

  const access = new AccessControl({
    allowedOpenIds: config.access.allowedOpenIds,
    unauthorizedBehavior: config.access.unauthorizedBehavior,
  });

  const lark = new LarkClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  });
  const feishuClient = new FeishuClient(lark);

  const providerQueryFns = {
    claude: createSdkQueryFn({
      cliPath: config.claude.cliPath,
      logger,
    }),
    codex: createCodexQueryFn({
      cliPath: config.codex.cliPath,
      logger,
    }),
  } as const;

  const clock = new RealClock();

  const permissionBroker = new FeishuPermissionBroker({
    feishu: feishuClient,
    clock,
    logger,
    config: {
      timeoutMs: config.claude.permissionTimeoutMs,
      warnBeforeMs: config.claude.permissionWarnBeforeMs,
    },
  });

  // `ask_user` MCP shim uses the same timeout knobs as the permission
  // broker — question timeouts live in the same order of magnitude and
  // the plan intentionally reuses the existing config rather than
  // introducing yet another tuning surface.
  const questionBroker = new FeishuQuestionBroker({
    feishu: feishuClient,
    clock,
    logger,
    config: {
      timeoutMs: config.claude.permissionTimeoutMs,
      warnBeforeMs: config.claude.permissionWarnBeforeMs,
    },
  });

  const sessionManager = new ClaudeSessionManager({
    config: config.claude,
    mcpServers: config.mcp,
    queryFn: providerQueryFns.claude,
    providerQueryFns,
    defaultProvider,
    providerConfigs: {
      claude: config.claude,
      codex: config.codex,
    },
    clock,
    permissionBroker,
    questionBroker,
    logger,
    stateStore,
    feishuClient,
    sessionTtlDays: config.persistence.sessionTtlDays,
  });

  const commandDispatcher = new CommandDispatcher({
    sessionManager,
    feishu: feishuClient,
    config,
    configPath,
    permissionBroker,
    questionBroker,
    clock,
    logger,
  });

  const onMessage = async (msg: IncomingMessage): Promise<void> => {
    logger.info({ chat_id: msg.chatId, len: msg.text.length }, "Message received");
    const locale = detectLocale(msg.text);
    const session = sessionManager.getOrCreate(msg.chatId);

    // Per-turn render state. The user sees at most one status card,
    // one thinking card, one tool activity card, and one final answer
    // card per turn — plus an optional stats line at the end.
    //
    // Status card is the "live cursor" that mirrors Claude CLI's
    // single-line progress indicator. It's the first thing we send
    // (replacing the old "⏳ 收到" text ACK) and we stream short
    // status lines into it on every render event — "💭 思考中...",
    // "🔧 Bash: npm test", "✅ 完成" — so the user always sees what
    // the agent is doing without expanding the full cards below it.
    //
    // Thinking card and tool activity card both default-collapsed:
    // they accumulate the full history as an on-demand audit trail,
    // but the live view is the status card. Both use CardKit
    // streaming — on the first relevant event we `sendCard` + convert
    // `message_id` to `card_id`, and every subsequent block is pushed
    // via `streamElementContent` targeting a stable element_id. The
    // per-card sequence counters are the monotonic integers CardKit
    // requires for update ordering.
    //
    // Final assistant text and the turn_end stat line stay as
    // separate messages.
    //
    // `thinkingDisabled` / `toolDisabled` are sticky latches: once we
    // hit any send / stream / patch error for a given card type, we
    // stop touching it for the rest of the turn. This bounds the blast
    // radius — a persistently broken chat (e.g. bot removed but event
    // still delivered, or a 230099 render failure) should not kill the
    // final answer card or the status cursor.
    const turnState: {
      statusCardMessageId: string | null;
      statusCardId: string | null;
      statusSequence: number;
      thinkingMessageId: string | null;
      thinkingCardId: string | null;
      thinkingSequence: number;
      thinkingText: string;
      thinkingDisabled: boolean;
      toolCardMessageId: string | null;
      toolCardId: string | null;
      toolSequence: number;
      toolEntries: ToolActivityEntry[];
      toolDisabled: boolean;
      /** All assistant text blocks emitted during this turn, in order. */
      textBlocks: string[];
    } = {
      statusCardMessageId: null,
      statusCardId: null,
      statusSequence: 0,
      thinkingMessageId: null,
      thinkingCardId: null,
      thinkingSequence: 0,
      thinkingText: "",
      thinkingDisabled: false,
      toolCardMessageId: null,
      toolCardId: null,
      toolSequence: 0,
      toolEntries: [],
      toolDisabled: false,
      textBlocks: [],
    };

    // Send the status card up front so the user has an immediate
    // acknowledgement even before the CLI subprocess yields its
    // first stream-json message. Any failure here is non-fatal:
    // we log and carry on without a status card, and the turn
    // still delivers its thinking / tool / answer cards normally.
    //
    // Only emit the card for inputs that will *start a new turn on
    // this message* — `run` (when idle) and `interrupt_and_run`. We
    // don't know yet whether a `run` will actually start vs. queue,
    // so the gate is finer-grained: caller invokes this after
    // `session.submit` returns `started`. For `/stop` and queued
    // `run`s the card is suppressed entirely so the user doesn't see
    // a flashing empty "⏳ 正在处理..." card.
    const sendStatusCard = async (): Promise<void> => {
      try {
        const { messageId } = await feishuClient.replyCard(
          msg.messageId,
          buildStatusCard(""),
        );
        turnState.statusCardMessageId = messageId;
        try {
          turnState.statusCardId =
            await feishuClient.convertMessageIdToCardId(messageId);
        } catch (err) {
          logger.warn(
            { err, chat_id: msg.chatId, message_id: messageId },
            "idConvert failed; status card will fall back to patchCard",
          );
        }
      } catch (err) {
        logger.warn({ err, chat_id: msg.chatId }, "Failed to send status card");
      }
    };

    // Push a new line into the status card. Swallows errors — the
    // status line is a cosmetic cursor, so a transient 502 / network
    // hiccup must not abort the turn.
    const updateStatus = async (line: string): Promise<void> => {
      if (turnState.statusCardId !== null) {
        turnState.statusSequence += 1;
        try {
          await feishuClient.streamElementContent({
            cardId: turnState.statusCardId,
            elementId: STATUS_ELEMENT_ID,
            content: line,
            sequence: turnState.statusSequence,
          });
          return;
        } catch (err) {
          // Feishu closes the streaming session after enough updates
          // (code=300309 "streaming mode is closed"). Clear statusCardId
          // so all future calls fall through to the patchCard branch below,
          // and attempt patchCard for this update too.
          logger.warn(
            { err, chat_id: msg.chatId, line },
            "status stream failed; falling back to patchCard for remainder of turn",
          );
          turnState.statusCardId = null;
        }
      }
      if (turnState.statusCardMessageId !== null) {
        // Fallback path: idConvert failed on card creation, OR streaming
        // session was closed mid-turn (e.g. code=300309 after many updates).
        // Patch the whole card instead.
        try {
          await feishuClient.patchCard(
            turnState.statusCardMessageId,
            buildStatusCard(line),
          );
        } catch (err) {
          logger.warn(
            { err, chat_id: msg.chatId, line },
            "status patchCard failed",
          );
        }
      }
    };

    // Format a compact single-line summary for a tool invocation —
    // the tool name plus a trimmed version of its parameters (e.g.
    // "🔧 Bash: $ npm test", "📖 Read: src/a.ts:1-10"). Newlines are
    // flattened so the status line never wraps.
    const STATUS_LINE_MAX = 60;
    const toolStatusLine = (name: string, input: unknown): string => {
      const params = formatToolParams(name, input).replace(/\s+/g, " ").trim();
      const head = params.length > STATUS_LINE_MAX
        ? params.slice(0, STATUS_LINE_MAX - 1) + "…"
        : params;
      return head.length > 0 ? `🔧 ${name}: ${head}` : `🔧 ${name}`;
    };

    const emit = async (event: RenderEvent): Promise<void> => {
      switch (event.type) {
        case "text":
          // Accumulate text blocks rather than sending each one
          // immediately. Claude can emit multiple text blocks in a
          // single turn (brief narration before each tool call, then
          // a final answer after). Sending every block as its own card
          // floods the chat with intermediate messages. We buffer here
          // and flush at turn_end: N-1 blocks go into a collapsed
          // "intermediate replies" card; the last block becomes the
          // visible answer card.
          await updateStatus(t(locale).statusDone);
          turnState.textBlocks.push(event.text);
          return;
        case "thinking": {
          if (config.render.hideThinking) return;
          if (turnState.thinkingDisabled) return;
          await updateStatus(t(locale).statusThinking);
          turnState.thinkingText =
            turnState.thinkingText.length === 0
              ? event.text
              : `${turnState.thinkingText}\n\n${event.text}`;
          if (turnState.thinkingMessageId === null) {
            // First thinking block of the turn: send the card, then
            // convert its message_id to a CardKit card_id so every
            // subsequent block can stream into it. idConvert failing
            // is not fatal — fall back to patchCard semantics for
            // the rest of the turn so the user still sees updates.
            // sendCard failure IS fatal to the thinking card for this
            // turn (we latch `thinkingDisabled`), but must not kill
            // the whole turn — a broken chat or 230099 render failure
            // should still let the final answer card go through.
            const card = buildThinkingCard(turnState.thinkingText, {
              inlineMaxBytes: config.render.inlineMaxBytes,
            });
            let messageId: string;
            try {
              const res = await feishuClient.replyCard(msg.messageId, card);
              messageId = res.messageId;
            } catch (err) {
              logger.warn(
                { err, chat_id: msg.chatId },
                "thinking replyCard failed; disabling thinking card for this turn",
              );
              turnState.thinkingDisabled = true;
              return;
            }
            turnState.thinkingMessageId = messageId;
            try {
              turnState.thinkingCardId =
                await feishuClient.convertMessageIdToCardId(messageId);
            } catch (err) {
              logger.warn(
                { err, chat_id: msg.chatId, message_id: messageId },
                "idConvert failed; thinking card will fall back to patchCard",
              );
            }
          } else {
            if (turnState.thinkingCardId !== null) {
              turnState.thinkingSequence += 1;
              const streamed = prepareInline(
                turnState.thinkingText,
                config.render.inlineMaxBytes,
              );
              try {
                await feishuClient.streamElementContent({
                  cardId: turnState.thinkingCardId,
                  elementId: THINKING_ELEMENT_ID,
                  content: streamed,
                  sequence: turnState.thinkingSequence,
                });
                return;
              } catch (err) {
                logger.warn(
                  { err, chat_id: msg.chatId },
                  "thinking stream failed; falling back to patchCard for remainder of turn",
                );
                turnState.thinkingCardId = null;
              }
            }
            const card = buildThinkingCard(turnState.thinkingText, {
              inlineMaxBytes: config.render.inlineMaxBytes,
            });
            try {
              await feishuClient.patchCard(turnState.thinkingMessageId!, card);
            } catch (err) {
              logger.warn(
                { err, chat_id: msg.chatId },
                "thinking patchCard failed; disabling thinking card for this turn",
              );
              turnState.thinkingDisabled = true;
            }
          }
          return;
        }
        case "tool_use": {
          await updateStatus(toolStatusLine(event.name, event.input));
          turnState.toolEntries.push({
            toolUseId: event.id,
            name: event.name,
            input: event.input,
          });
          await sendOrPatchToolCard();
          return;
        }
        case "tool_result": {
          const entry = turnState.toolEntries.find(
            (e) => e.toolUseId === event.toolUseId,
          );
          if (entry) {
            entry.result = { text: event.text, isError: event.isError };
            // Briefly flash a done marker so the user sees the tool
            // finished even if the next thinking block takes a
            // moment to arrive. The next render event will overwrite
            // this line; on the turn's last tool call it stays until
            // the final `text` event promotes it to "✅ 完成".
            await updateStatus(
              event.isError ? `❌ ${entry.name} 失败` : `✅ ${entry.name}`,
            );
          } else {
            // Result arrived for a tool_use we never saw (shouldn't
            // happen in normal stream order, but log and synthesize
            // a best-effort entry so the card still shows it).
            logger.warn(
              { chat_id: msg.chatId, tool_use_id: event.toolUseId },
              "tool_result for unknown tool_use — appending synthetic entry",
            );
            turnState.toolEntries.push({
              toolUseId: event.toolUseId,
              name: "(unknown)",
              input: null,
              result: { text: event.text, isError: event.isError },
            });
          }
          await sendOrPatchToolCard();
          return;
        }
        case "turn_end":
          await flushTextBlocks();
          if (!config.render.showTurnStats) return;
          await feishuClient.replyText(
            msg.messageId,
              formatResultTip({
                durationMs: event.durationMs,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
              }, locale),
            );
          return;
        case "queued":
          // Out-of-band notice from the session: the user's input landed in
          // a non-empty queue. Rendered as a plain text reply so it
          // threads under the user message that just got queued.
          try {
            await feishuClient.replyText(
              msg.messageId,
              formatQueuedTip(event.position, locale),
            );
          } catch (err) {
            logger.warn(
              { err, chat_id: msg.chatId },
              "queued notice send failed",
            );
          }
          return;
        case "interrupted":
          // The session is telling us this input was dropped before it ran.
          // Only the "bang_prefix" branch actually needs a user notice —
          // "stop" already goes through the /stop ack path in the
          // dispatcher. Keep both in the switch so the enum is exhaustive
          // and the ack is explicit.
          if (event.reason === "bang_prefix") {
            try {
              await feishuClient.replyText(
                msg.messageId,
                formatInterruptDropAck(locale),
              );
            } catch (err) {
              logger.warn(
                { err, chat_id: msg.chatId },
                "interrupted notice send failed",
              );
            }
          }
          return;
        case "stop_ack":
          // Dedicated /stop ack. Sent as a plain-text reply so it
          // threads under the /stop message itself, doesn't get
          // promoted to "✅ 完成" on the status card, and isn't wrapped
          // in `buildAnswerCard` — stopping is not completing.
          try {
            await feishuClient.replyText(msg.messageId, formatStopAck(locale));
          } catch (err) {
            logger.warn(
              { err, chat_id: msg.chatId },
              "stop ack send failed",
            );
          }
          return;
        case "context_warning":
          try {
            await feishuClient.replyText(
              msg.messageId,
              t(locale).contextWarningRuntime,
            );
          } catch (err) {
            logger.warn(
              { err, chat_id: msg.chatId },
              "context_warning notice send failed",
            );
          }
          return;
        case "context_compacting":
          try {
            await feishuClient.replyText(
              msg.messageId,
              t(locale).contextCompacting,
            );
          } catch (err) {
            logger.warn(
              { err, chat_id: msg.chatId },
              "context_compacting notice send failed",
            );
          }
          return;
        case "context_summarized_reset":
          try {
            await feishuClient.replyText(
              msg.messageId,
              t(locale).contextSummarizedReset,
            );
          } catch (err) {
            logger.warn(
              { err, chat_id: msg.chatId },
              "context_summarized_reset notice send failed",
            );
          }
          return;
        case "context_reset":
          // Session auto-reset due to "Request too large" (>20 MB).
          // Notify the user that context was dropped and the message
          // is being retried in a fresh session.
          try {
            await feishuClient.replyText(
              msg.messageId,
              t(locale).contextReset,
            );
          } catch (err) {
            logger.warn(
              { err, chat_id: msg.chatId },
              "context_reset notice send failed",
            );
          }
          return;
        default: {
          // Exhaustiveness check — a future RenderEvent variant will make
          // this line fail to compile, forcing the dispatcher to be updated.
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    };

    const sendOrPatchToolCard = async (): Promise<void> => {
      if (turnState.toolDisabled) return;
      if (turnState.toolCardMessageId === null) {
        // First tool event of the turn: send the initial card, then
        // hand it off to CardKit streaming for subsequent updates.
        // Symmetric with the thinking card: idConvert failing is
        // not fatal — the card stays on the patchCard path instead.
        // sendCard failure latches `toolDisabled` for the rest of
        // the turn so a persistently broken chat can still deliver
        // its final answer card.
        const card = buildToolActivityCard(turnState.toolEntries, {
          inlineMaxBytes: config.render.inlineMaxBytes,
        });
        let messageId: string;
        try {
          const res = await feishuClient.replyCard(msg.messageId, card);
          messageId = res.messageId;
        } catch (err) {
          logger.warn(
            { err, chat_id: msg.chatId },
            "tool activity replyCard failed; disabling tool card for this turn",
          );
          turnState.toolDisabled = true;
          return;
        }
        turnState.toolCardMessageId = messageId;
        try {
          turnState.toolCardId =
            await feishuClient.convertMessageIdToCardId(messageId);
        } catch (err) {
          logger.warn(
            { err, chat_id: msg.chatId, message_id: messageId },
            "idConvert failed; tool activity card will fall back to patchCard",
          );
        }
        return;
      }
      if (turnState.toolCardId !== null) {
        // Subsequent events: stream the freshly-rendered body text
        // into the card's streamable element. New entries tacked on
        // at the end render with a typewriter effect (prefix
        // extension); mid-text changes (pending ⏳ → ✅ result) fall
        // through to a snap, which is fine.
        turnState.toolSequence += 1;
        // `renderToolActivityBody` already runs every per-entry
        // chunk through `prepareInline`, so the result is already
        // sanitized (image refs demoted) and each entry is bounded
        // at `inlineMaxBytes`. No need for a second pass here —
        // wrapping it would risk cutting through the middle of an
        // entry boundary.
        const body = renderToolActivityBody(
          turnState.toolEntries,
          config.render.inlineMaxBytes,
        );
        try {
          await feishuClient.streamElementContent({
            cardId: turnState.toolCardId,
            elementId: TOOL_ACTIVITY_ELEMENT_ID,
            content: body,
            sequence: turnState.toolSequence,
          });
          return;
        } catch (err) {
          // Transient errors (502) or session expiry (300309) both fall
          // back to patchCard for this and subsequent updates — mirrors
          // the same pattern used by updateStatus.
          logger.warn(
            { err, chat_id: msg.chatId },
            "tool activity stream failed; falling back to patchCard for remainder of turn",
          );
          turnState.toolCardId = null;
          // fall through to patchCard below
        }
      }
      // Fallback: streaming never came up (idConvert failed on first
      // send), OR streaming failed mid-turn (e.g. 502 / 300309).
      // Keep pushing full-card replacements via patchCard.
      const card = buildToolActivityCard(turnState.toolEntries, {
        inlineMaxBytes: config.render.inlineMaxBytes,
      });
      try {
        await feishuClient.patchCard(turnState.toolCardMessageId, card);
      } catch (err) {
        logger.warn(
          { err, chat_id: msg.chatId },
          "tool activity patchCard failed; disabling tool card for this turn",
        );
        turnState.toolDisabled = true;
      }
    };

    // Flush accumulated text blocks at turn end. If Claude emitted N
    // text blocks (narration between tool calls + final answer), we:
    //   • Send blocks 0..N-2 as a single default-collapsed card so the
    //     chat timeline doesn't flood with intermediate messages.
    //   • Send block N-1 as the visible final answer card.
    // If there is only one block (the common case: no inter-tool
    // narration) we skip the intermediate card entirely and just send
    // the answer. If there are zero blocks (tool-only turn with no text
    // output) we send nothing — the tool activity card already captured
    // everything the user needs to see.
    const flushTextBlocks = async (): Promise<void> => {
      const blocks = turnState.textBlocks;
      if (blocks.length === 0) return;
      if (blocks.length > 1) {
        try {
          await feishuClient.replyCard(
            msg.messageId,
            buildIntermediateRepliesCard(
              blocks.slice(0, -1),
              locale,
              config.render.inlineMaxBytes,
            ),
          );
        } catch (err) {
          logger.warn(
            { err, chat_id: msg.chatId },
            "intermediate replies card failed — sending them inline instead",
          );
          // Best-effort fallback: send each intermediate block as its
          // own plain answer card so no content is lost.
          for (const block of blocks.slice(0, -1)) {
            try {
              await feishuClient.replyCard(
                msg.messageId,
                buildAnswerCard(block),
              );
            } catch (innerErr) {
              logger.warn(
                { err: innerErr, chat_id: msg.chatId },
                "fallback intermediate card failed — dropping block",
              );
            }
          }
        }
      }
      await feishuClient.replyCard(
        msg.messageId,
        buildAnswerCard(blocks[blocks.length - 1]!),
      );
    };

    try {
      const parsed = parseInput(msg.text);
      if (parsed.kind === "stop") {
        // /stop never gets a status card — there's nothing to cursor
        // through, and flashing an empty "⏳ 正在处理..." then
        // immediately replacing it with "🛑 已停止" is visually noisy.
        await session.stop(emit);
        return;
      }
      if (parsed.kind === "command") {
        await commandDispatcher.dispatch(parsed.cmd, {
          chatId: msg.chatId,
          senderOpenId: msg.senderOpenId,
          parentMessageId: msg.messageId,
          locale,
        });
        return;
      }
      if (parsed.kind === "unknown_command") {
        await commandDispatcher.dispatchUnknown(parsed.raw, {
          chatId: msg.chatId,
          senderOpenId: msg.senderOpenId,
          parentMessageId: msg.messageId,
          locale,
        });
        return;
      }
      const outcome = await session.submit(
        {
          ...parsed,
          senderOpenId: msg.senderOpenId,
          parentMessageId: msg.messageId,
          locale,
        },
        emit,
      );
      // Only the input that actually starts a turn on this message
      // gets a status card. Queued `run`s get the "📥 已加入队列" text
      // reply instead (emitted from inside `session.submit`), so a
      // second card here would be an orphan — it would never receive
      // status updates because the turn will run under the emit
      // callback of whichever *earlier* message started it.
      //
      // `interrupt_and_run` always comes back as `started`, so the
      // two started-paths collapse into one.
      if (outcome.kind === "started") {
        // Fire the status card in the background so it races with
        // `session.submit`'s processLoop kickoff — the CLI spawn +
        // first stream-json line is orders of magnitude slower than a
        // card send, so the card lands first in practice. Awaiting
        // here would serialize us against a single card round-trip
        // before any events can flow.
        await sendStatusCard();
      }
      if (outcome.kind === "started" || outcome.kind === "queued") {
        try {
          await outcome.done;
        } catch (err) {
          if (err instanceof InterruptedError) {
            // The session already emitted the appropriate
            // "interrupted" notice on the same emit channel — just
            // log and swallow so the outer catch doesn't surface a
            // generic error reply.
            logger.info(
              { chat_id: msg.chatId, reason: err.reason },
              "turn interrupted by user",
            );
            return;
          }
          throw err;
        }
      }
      // kind === "rejected" (stop synthesized via submit) → nothing to do.
    } catch (err) {
      logger.error({ err, chat_id: msg.chatId }, "Claude turn failed");
      const errorText = err instanceof Error ? err.message : String(err);
      try {
        await feishuClient.replyText(
          msg.messageId,
          formatErrorText(errorText, locale),
        );
      } catch (sendErr) {
        logger.error({ err: sendErr }, "Failed to deliver error reply");
      }
    }
  };

  const onCardAction = async ({
    senderOpenId,
    value,
  }: {
    senderOpenId: string;
    value: Record<string, unknown>;
  }): Promise<import("./feishu/gateway.js").CardActionResult> => {
    const kind = value.kind;
    if (kind === "permission") {
      const requestId = value.request_id;
      const choice = value.choice;
      if (typeof requestId !== "string") {
        logger.warn({ value }, "Permission card action missing request_id");
        return;
      }
      if (
        choice !== "allow" &&
        choice !== "deny" &&
        choice !== "allow_turn" &&
        choice !== "allow_session"
      ) {
        logger.warn({ value }, "Permission card action has invalid choice");
        return;
      }
      const result = await permissionBroker.resolveByCard({
        requestId,
        senderOpenId,
        choice,
      });
      if (result.kind === "forbidden") {
        logger.warn(
          {
            request_id: requestId,
            clicker: senderOpenId,
            owner: result.ownerOpenId,
          },
          "Non-owner permission card click — ignored",
        );
        return;
      }
      if (result.kind === "not_found") {
        logger.info(
          { request_id: requestId },
          "Permission card action for unknown request — likely already resolved",
        );
        return;
      }
      // Forward the resolved card in the callback response so Feishu
      // updates the card immediately on click — same mechanism used by
      // the question broker.
      return { card: result.card };
    }
    if (kind === "question") {
      const requestId = value.request_id;
      const questionIndex = value.question_index;
      const optionIndex = value.option_index;
      if (typeof requestId !== "string") {
        logger.warn({ value }, "Question card action missing request_id");
        return;
      }
      if (typeof questionIndex !== "number" || !Number.isInteger(questionIndex)) {
        logger.warn({ value }, "Question card action has invalid question_index");
        return;
      }
      if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex)) {
        logger.warn({ value }, "Question card action has invalid option_index");
        return;
      }
      const result = await questionBroker.resolveByCard({
        requestId,
        senderOpenId,
        choice: { questionIndex, optionIndex },
      });
      if (result.kind === "forbidden") {
        logger.warn(
          {
            request_id: requestId,
            clicker: senderOpenId,
            owner: result.ownerOpenId,
          },
          "Non-owner question card click — ignored",
        );
        return;
      }
      if (result.kind === "not_found") {
        logger.info(
          { request_id: requestId },
          "Question card action for unknown request — likely already resolved",
        );
        return;
      }
      // Forward the broker's updated card (partial-answered state or
      // fully-resolved compact variant) so the gateway can replay it
      // in the callback response body — see CardActionResult for why.
      if (result.card) {
        return { card: result.card };
      }
      return;
    }
    if (kind === "cd_confirm") {
      const requestId = value.request_id;
      const accepted = value.accepted;
      if (typeof requestId !== "string") {
        logger.warn({ value }, "cd_confirm action missing request_id");
        return;
      }
      if (typeof accepted !== "boolean") {
        logger.warn({ value }, "cd_confirm action has invalid accepted");
        return;
      }
      const result = await commandDispatcher.resolveCdConfirm({
        requestId,
        senderOpenId,
        accepted,
      });
      if (result.kind === "forbidden") {
        logger.warn(
          { request_id: requestId, clicker: senderOpenId, owner: result.ownerOpenId },
          "Non-owner cd_confirm click — ignored",
        );
        return;
      }
      if (result.kind === "not_found") {
        logger.info({ request_id: requestId }, "cd_confirm for unknown request — likely already resolved");
        return;
      }
      if (result.card) {
        return { card: result.card };
      }
      return;
    }
    logger.warn({ value }, "Card action with unknown kind, ignoring");
  };

  const gateway = new FeishuGateway({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    logger,
    lark,
    feishuClient,
    access,
    onMessage,
    onCardAction,
  });

  await sessionManager.startupLoad();
  await sessionManager.crashRecovery(wasCleanShutdown);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    try {
      await sessionManager.flushPendingSave();
      const finalState: State = {
        version: 2,
        lastCleanShutdown: true,
        sessions: sessionManager.buildSessionsSnapshot(),
        activeProjects: sessionManager.getActiveProjectsSnapshot(),
      };
      await stateStore.save(finalState);
    } catch (err) {
      logger.error({ err }, "Failed to save state on shutdown");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Fatal-error handlers intentionally do not call markCleanShutdown — after an
  // uncaught error the process state is unknown, so recording "clean" would be
  // misleading.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled promise rejection");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });

  await gateway.start();

  logger.info(
    {
      allowed_count: config.access.allowedOpenIds.length,
      unauthorized_behavior: config.access.unauthorizedBehavior,
      cli_path: config.claude.cliPath,
      default_cwd: config.claude.defaultCwd,
      default_model: config.claude.defaultModel,
      permission_mode: config.claude.defaultPermissionMode,
      permission_timeout_ms: config.claude.permissionTimeoutMs,
      inline_max_bytes: config.render.inlineMaxBytes,
      hide_thinking: config.render.hideThinking,
      show_turn_stats: config.render.showTurnStats,
    },
    "claude-feishu-channel Phase 8 ready",
  );

  if (config.claude.defaultPermissionMode === "bypassPermissions") {
    logger.warn(
      { permission_mode: "bypassPermissions" },
      "Phase 5 shipped — permission brokering is ACTIVE only when default_permission_mode != 'bypassPermissions'. Your current config bypasses the broker; tool calls will not prompt for approval.",
    );
  }
}

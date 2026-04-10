import { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./util/logger.js";
import { StateStore } from "./persistence/state-store.js";
import { AccessControl } from "./access.js";
import { FeishuClient } from "./feishu/client.js";
import { FeishuGateway } from "./feishu/gateway.js";
import { checkClaudeCli } from "./claude/preflight.js";
import { createCliQueryFn } from "./claude/cli-query.js";
import { ClaudeSessionManager } from "./claude/session-manager.js";
import type { RenderEvent } from "./claude/render-event.js";
import {
  buildAnswerCard,
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
import { formatResultTip, formatErrorText } from "./feishu/messages.js";
import type { IncomingMessage } from "./types.js";

function resolveConfigPath(): string {
  const envOverride = process.env["CLAUDE_FEISHU_CONFIG"];
  if (envOverride) return envOverride;
  return join(homedir(), ".claude-feishu-channel", "config.toml");
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath();

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

  const preflight = await checkClaudeCli(config.claude.cliPath);
  if (!preflight.ok) {
    console.error(`[preflight] ${preflight.reason}`);
    process.exit(1);
  }
  logger.info(
    { cliPath: config.claude.cliPath, version: preflight.version },
    "Claude CLI preflight ok",
  );

  const stateStore = new StateStore(config.persistence.stateFile);
  const state = await stateStore.load();
  logger.info(
    { lastCleanShutdown: state.lastCleanShutdown },
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

  // Phase 3 (CLI transport): spawn the local `claude` CLI in
  // non-interactive stream-json mode per turn, instead of using the
  // in-process SDK. The CLI handles OAuth / keychain credentials on
  // its own, which is more robust than direct HTTP from undici.
  const queryFn = createCliQueryFn({
    cliPath: config.claude.cliPath,
    logger,
  });

  const sessionManager = new ClaudeSessionManager({
    config: config.claude,
    queryFn,
    logger,
  });

  const onMessage = async (msg: IncomingMessage): Promise<void> => {
    logger.info({ chat_id: msg.chatId, len: msg.text.length }, "Message received");
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
    const turnState: {
      statusCardMessageId: string | null;
      statusCardId: string | null;
      statusSequence: number;
      thinkingMessageId: string | null;
      thinkingCardId: string | null;
      thinkingSequence: number;
      thinkingText: string;
      toolCardMessageId: string | null;
      toolCardId: string | null;
      toolSequence: number;
      toolEntries: ToolActivityEntry[];
    } = {
      statusCardMessageId: null,
      statusCardId: null,
      statusSequence: 0,
      thinkingMessageId: null,
      thinkingCardId: null,
      thinkingSequence: 0,
      thinkingText: "",
      toolCardMessageId: null,
      toolCardId: null,
      toolSequence: 0,
      toolEntries: [],
    };

    // Send the status card up front so the user has an immediate
    // acknowledgement even before the CLI subprocess yields its
    // first stream-json message. Any failure here is non-fatal:
    // we log and carry on without a status card, and the turn
    // still delivers its thinking / tool / answer cards normally.
    try {
      const { messageId } = await feishuClient.sendCard(
        msg.chatId,
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
        } catch (err) {
          logger.warn(
            { err, chat_id: msg.chatId, line },
            "status stream failed",
          );
        }
        return;
      }
      if (turnState.statusCardMessageId !== null) {
        // Fallback path: idConvert failed, so we can't stream —
        // patch the whole card instead.
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
          // Final assistant text routinely contains markdown (code
          // fences, bold, lists). Sending as msg_type:"text" would
          // show the markup literally — use a card instead so Feishu
          // renders it.
          await updateStatus("✅ 完成");
          await feishuClient.sendCard(msg.chatId, buildAnswerCard(event.text));
          return;
        case "thinking": {
          if (config.render.hideThinking) return;
          await updateStatus("💭 思考中...");
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
            const card = buildThinkingCard(turnState.thinkingText, {
              inlineMaxBytes: config.render.inlineMaxBytes,
            });
            const { messageId } = await feishuClient.sendCard(msg.chatId, card);
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
          } else if (turnState.thinkingCardId !== null) {
            // Subsequent blocks: push the full accumulated text into
            // the streamable element. CardKit diffs against the
            // previous content and renders the delta with a typing
            // cursor. Sequence is a monotonic per-card counter; we
            // increment BEFORE the call so the first streamed update
            // uses sequence=1.
            turnState.thinkingSequence += 1;
            const streamed = prepareInline(
              turnState.thinkingText,
              config.render.inlineMaxBytes,
            );
            await feishuClient.streamElementContent({
              cardId: turnState.thinkingCardId,
              elementId: THINKING_ELEMENT_ID,
              content: streamed,
              sequence: turnState.thinkingSequence,
            });
          } else {
            // Fallback path: idConvert failed on the first block, so
            // we can't stream — revert to full-card patch for the
            // rest of the turn.
            const card = buildThinkingCard(turnState.thinkingText, {
              inlineMaxBytes: config.render.inlineMaxBytes,
            });
            await feishuClient.patchCard(turnState.thinkingMessageId, card);
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
          if (!config.render.showTurnStats) return;
          await feishuClient.sendText(
            msg.chatId,
            formatResultTip({
              durationMs: event.durationMs,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
            }),
          );
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
      if (turnState.toolCardMessageId === null) {
        // First tool event of the turn: send the initial card, then
        // hand it off to CardKit streaming for subsequent updates.
        // Symmetric with the thinking card: idConvert failing is
        // not fatal — the card stays on the patchCard path instead.
        const card = buildToolActivityCard(turnState.toolEntries, {
          inlineMaxBytes: config.render.inlineMaxBytes,
        });
        const { messageId } = await feishuClient.sendCard(msg.chatId, card);
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
        await feishuClient.streamElementContent({
          cardId: turnState.toolCardId,
          elementId: TOOL_ACTIVITY_ELEMENT_ID,
          content: body,
          sequence: turnState.toolSequence,
        });
        return;
      }
      // Fallback: streaming never came up (idConvert failed on first
      // send). Keep pushing full-card replacements via patchCard.
      const card = buildToolActivityCard(turnState.toolEntries, {
        inlineMaxBytes: config.render.inlineMaxBytes,
      });
      await feishuClient.patchCard(turnState.toolCardMessageId, card);
    };
    try {
      await session.handleMessage(msg.text, emit);
    } catch (err) {
      logger.error({ err, chat_id: msg.chatId }, "Claude turn failed");
      const errorText = err instanceof Error ? err.message : String(err);
      try {
        await feishuClient.sendText(msg.chatId, formatErrorText(errorText));
      } catch (sendErr) {
        logger.error({ err: sendErr }, "Failed to deliver error reply");
      }
    }
  };

  const gateway = new FeishuGateway({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    logger,
    lark,
    access,
    onMessage,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    try {
      await stateStore.markCleanShutdown(state);
    } catch (err) {
      logger.error({ err }, "Failed to mark clean shutdown");
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
      inline_max_bytes: config.render.inlineMaxBytes,
      hide_thinking: config.render.hideThinking,
      show_turn_stats: config.render.showTurnStats,
    },
    "claude-feishu-channel Phase 3 ready",
  );
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

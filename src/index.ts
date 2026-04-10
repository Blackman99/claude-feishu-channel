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
import { buildToolUseCard, buildToolResultCard } from "./feishu/cards.js";
import {
  formatThinkingText,
  formatResultTip,
  formatErrorText,
} from "./feishu/messages.js";
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
    // Immediate ACK so the user sees the bot is alive before the CLI
    // subprocess yields its first stream-json message (cold start +
    // first-token latency can easily be several seconds). A failing
    // ACK must not block the turn itself.
    try {
      await feishuClient.sendText(msg.chatId, "⏳ 收到，正在思考...");
    } catch (err) {
      logger.warn({ err, chat_id: msg.chatId }, "Failed to send ack message");
    }
    const session = sessionManager.getOrCreate(msg.chatId);
    const emit = async (event: RenderEvent): Promise<void> => {
      switch (event.type) {
        case "text":
          await feishuClient.sendText(msg.chatId, event.text);
          return;
        case "thinking":
          if (config.render.hideThinking) return;
          await feishuClient.sendText(msg.chatId, formatThinkingText(event.text));
          return;
        case "tool_use":
          await feishuClient.sendCard(
            msg.chatId,
            buildToolUseCard(
              { id: event.id, name: event.name, input: event.input },
              { inlineMaxBytes: config.render.inlineMaxBytes },
            ),
          );
          return;
        case "tool_result":
          await feishuClient.sendCard(
            msg.chatId,
            buildToolResultCard({
              toolUseId: event.toolUseId,
              isError: event.isError,
              text: event.text,
              inlineMaxBytes: config.render.inlineMaxBytes,
            }),
          );
          return;
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

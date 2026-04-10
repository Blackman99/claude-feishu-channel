import { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./util/logger.js";
import { StateStore } from "./persistence/state-store.js";
import { AccessControl } from "./access.js";
import { FeishuClient } from "./feishu/client.js";
import { FeishuGateway } from "./feishu/gateway.js";
import { checkCredentials } from "./claude/preflight.js";
import { ClaudeSessionManager } from "./claude/session-manager.js";
import type { QueryFn, SDKMessageLike } from "./claude/session.js";
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

  const preflight = checkCredentials(process.env);
  if (!preflight.ok) {
    console.error(`[preflight] ${preflight.reason}`);
    process.exit(1);
  }

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

  // Wrap the real SDK `query` into our structural QueryFn interface.
  // The SDK's return type (`Query extends AsyncGenerator<SDKMessage, void>`)
  // is assignable to `AsyncIterable<SDKMessageLike>` because SDKMessage is
  // a superset of our shallow SDKMessageLike.
  const queryFn: QueryFn = (params) =>
    query({
      prompt: params.prompt,
      options: {
        cwd: params.options.cwd,
        model: params.options.model,
        permissionMode: params.options.permissionMode,
        settingSources: params.options.settingSources as ("project" | "user" | "local")[],
      },
    }) as unknown as AsyncIterable<SDKMessageLike>;

  const sessionManager = new ClaudeSessionManager({
    config: config.claude,
    queryFn,
    logger,
  });

  const onMessage = async (msg: IncomingMessage): Promise<void> => {
    logger.info({ chat_id: msg.chatId, len: msg.text.length }, "Message received");
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

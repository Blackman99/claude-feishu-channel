export interface McpServerConfig {
  name: string;
  type: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export type AgentProvider = "claude" | "codex";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export interface ProviderConfig {
  defaultModel: string;
  /** Path to the CLI binary. Usually a bare command resolved via $PATH. */
  cliPath: string;
}

export interface AgentConfig {
  defaultProvider: AgentProvider;
  defaultCwd: string;
  defaultPermissionMode: PermissionMode;
  /** Max time the broker waits for a user decision before auto-denying. */
  permissionTimeoutMs: number;
  /** How far BEFORE the timeout to post the "⏰ 60s" warning reminder. */
  permissionWarnBeforeMs: number;
  /** 0.0–1.0 fill fraction at which auto-compact triggers. */
  autoCompactThreshold?: number;
}

export interface LoadedAppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    encryptKey: string;
    verificationToken: string;
  };
  access: {
    allowedOpenIds: readonly string[];
    unauthorizedBehavior: "ignore" | "reject";
  };
  agent: AgentConfig;
  claude: ProviderConfig & {
    defaultCwd: string;
    defaultPermissionMode: PermissionMode;
    permissionTimeoutMs: number;
    permissionWarnBeforeMs: number;
    autoCompactThreshold?: number;
  };
  codex: ProviderConfig;
  render: {
    /** Max bytes (UTF-8) of inline content in a card before truncation. */
    inlineMaxBytes: number;
    /** If true, skip thinking blocks entirely. */
    hideThinking: boolean;
    /** If true, send a stats tip ("✅ 12.3s · 1.2k in / 3.4k out") at turn end. */
    showTurnStats: boolean;
  };
  persistence: {
    stateFile: string;
    logDir: string;
    sessionTtlDays: number;
  };
  logging: {
    level: "trace" | "debug" | "info" | "warn" | "error";
  };
  /** Project aliases — map of alias → absolute cwd path. */
  projects: Record<string, string>;
  /** User-configured MCP servers registered alongside built-in shims. */
  mcp: McpServerConfig[];
}

/**
 * A user message received from Feishu after the gateway has translated the
 * raw event into our internal representation.
 */
export interface IncomingMessage {
  /** Feishu unique message id, used for dedup. */
  messageId: string;
  /** Feishu chat id (p2p or group). */
  chatId: string;
  /** Sender's open_id. */
  senderOpenId: string;
  /** Plain text content. Rich content is flattened to text in Phase 1. */
  text: string;
  /** Attached image as a data URI when the source message is an image. */
  imageDataUri?: string;
  /** Receive timestamp (ms). */
  receivedAt: number;
}

/**
 * A plain-text reply the gateway will send back to a specific chat.
 */
export interface OutgoingTextMessage {
  chatId: string;
  text: string;
}

/**
 * Loaded, validated application config (produced by src/config.ts).
 * Later phases will extend this with more sections.
 */
export type AppConfig = LoadedAppConfig;

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
export interface AppConfig {
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
  persistence: {
    stateFile: string;
    logDir: string;
  };
  logging: {
    level: "trace" | "debug" | "info" | "warn" | "error";
  };
}

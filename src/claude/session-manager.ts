import type { Logger } from "pino";
import { ClaudeSession, type QueryFn } from "./session.js";
import type { AppConfig } from "../types.js";

export interface ClaudeSessionManagerOptions {
  config: AppConfig["claude"];
  queryFn: QueryFn;
  logger: Logger;
}

/**
 * Lazy `chat_id → ClaudeSession` map. Phase 2 keeps sessions in memory
 * only; there is no cleanup and no persistence. Phase 7 will wire this
 * into `StateStore` so sessions survive restarts.
 */
export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly opts: ClaudeSessionManagerOptions;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  getOrCreate(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (session === undefined) {
      session = new ClaudeSession({
        chatId,
        config: this.opts.config,
        queryFn: this.opts.queryFn,
        logger: this.opts.logger,
      });
      this.sessions.set(chatId, session);
    }
    return session;
  }
}

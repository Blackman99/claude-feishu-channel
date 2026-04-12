import type { Logger } from "pino";
import { ClaudeSession, type QueryFn } from "./session.js";
import type { Clock } from "../util/clock.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { QuestionBroker } from "./question-broker.js";
import type { AppConfig } from "../types.js";

export interface ClaudeSessionManagerOptions {
  config: AppConfig["claude"];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  logger: Logger;
}

/**
 * Lazy `chat_id → ClaudeSession` map. Phase 2 keeps sessions in
 * memory only; there is no cleanup and no persistence. Phase 7 will
 * wire this into `StateStore` so sessions survive restarts.
 */
export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly cwdOverrides = new Map<string, string>();
  private readonly opts: ClaudeSessionManagerOptions;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  getOrCreate(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (session === undefined) {
      const cwd = this.cwdOverrides.get(chatId) ?? this.opts.config.defaultCwd;
      session = new ClaudeSession({
        chatId,
        config: { ...this.opts.config, defaultCwd: cwd },
        queryFn: this.opts.queryFn,
        clock: this.opts.clock,
        permissionBroker: this.opts.permissionBroker,
        questionBroker: this.opts.questionBroker,
        logger: this.opts.logger,
      });
      this.sessions.set(chatId, session);
    }
    return session;
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
  }

  setCwdOverride(chatId: string, cwd: string): void {
    this.cwdOverrides.set(chatId, cwd);
  }
}

import type { Logger } from "pino";
import { ClaudeSession, type QueryFn } from "./session.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { QuestionBroker } from "./question-broker.js";
import type { AppConfig } from "../types.js";
import type {
  StateStore,
  SessionRecord,
  State,
} from "../persistence/state-store.js";
import type { FeishuClient } from "../feishu/client.js";

export interface ClaudeSessionManagerOptions {
  config: AppConfig["claude"];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  logger: Logger;
  stateStore?: StateStore;
  feishuClient?: FeishuClient;
  sessionTtlDays?: number;
}

const DEBOUNCE_MS = 30_000;

/**
 * `chat_id → ClaudeSession` map with optional persistence via StateStore.
 *
 * When `stateStore` is absent (legacy / test callers that don't pass it),
 * all persistence operations are silent no-ops, preserving backward
 * compatibility with existing tests.
 *
 * Persistence model:
 * - **Immediate save (Scenario A)**: structural changes — session ID
 *   captured, session deleted, stale record set.
 * - **Debounced save (Scenario B, 30s)**: heartbeat updates — turn
 *   completions that only bump `lastActiveAt`.
 * - `saveNow()` always cancels any pending debounced timer first.
 */
export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly cwdOverrides = new Map<string, string>();
  private readonly staleRecords = new Map<string, SessionRecord>();
  private readonly opts: ClaudeSessionManagerOptions;
  private debounceTimer: TimeoutHandle | null = null;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  // --- lifecycle ---

  async startupLoad(): Promise<void> {
    if (!this.opts.stateStore) return;
    const state = await this.opts.stateStore.load();
    const now = Date.now();
    const ttlMs = (this.opts.sessionTtlDays ?? 30) * 24 * 60 * 60 * 1000;

    for (const [chatId, record] of Object.entries(state.sessions)) {
      const lastActive = new Date(record.lastActiveAt).getTime();
      if (now - lastActive > ttlMs) continue;
      this.staleRecords.set(chatId, record);
    }

    // Persist the pruned set so expired sessions are dropped from disk.
    await this.saveNow();
  }

  async crashRecovery(lastCleanShutdown: boolean): Promise<void> {
    if (lastCleanShutdown) return;
    if (!this.opts.feishuClient) return;

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [chatId, record] of this.staleRecords) {
      const lastActive = new Date(record.lastActiveAt).getTime();
      if (lastActive < oneHourAgo) continue;

      try {
        await this.opts.feishuClient.sendText(
          chatId,
          "⚠️ 上次 bot 异常重启，已恢复会话。请检查上一轮的执行结果是否完整",
        );
      } catch (err) {
        this.opts.logger.warn(
          { err, chatId },
          "Crash recovery notification failed",
        );
      }
    }
  }

  // --- session CRUD ---

  getOrCreate(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (session !== undefined) return session;

    const stale = this.staleRecords.get(chatId);
    const cwdOverride = this.cwdOverrides.get(chatId);

    let cwd: string;
    let permissionMode:
      | AppConfig["claude"]["defaultPermissionMode"]
      | undefined;
    let model: string | undefined;
    let claudeSessionId: string | undefined;

    if (stale) {
      cwd = cwdOverride ?? stale.cwd;
      permissionMode = stale.permissionMode as
        | AppConfig["claude"]["defaultPermissionMode"]
        | undefined;
      model = stale.model;
      claudeSessionId = stale.claudeSessionId;
      this.staleRecords.delete(chatId);
    } else {
      cwd = cwdOverride ?? this.opts.config.defaultCwd;
    }

    session = new ClaudeSession({
      chatId,
      config: { ...this.opts.config, defaultCwd: cwd },
      queryFn: this.opts.queryFn,
      clock: this.opts.clock,
      permissionBroker: this.opts.permissionBroker,
      questionBroker: this.opts.questionBroker,
      logger: this.opts.logger,
      onSessionIdCaptured: () => void this.saveNow(),
      onTurnComplete: () => this.scheduleDebouncedSave(),
    });

    if (permissionMode) {
      session.setPermissionModeOverride(permissionMode);
    }
    if (model) {
      session.setModelOverride(model);
    }
    if (claudeSessionId) {
      session.setClaudeSessionId(claudeSessionId);
    }
    if (stale) {
      session.setTimestamps(stale.createdAt, stale.lastActiveAt);
    }

    this.sessions.set(chatId, session);
    return session;
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
    this.staleRecords.delete(chatId);
    void this.saveNow();
  }

  setCwdOverride(chatId: string, cwd: string): void {
    this.cwdOverrides.set(chatId, cwd);
  }

  setStaleRecord(chatId: string, record: SessionRecord): void {
    this.staleRecords.set(chatId, record);
    void this.saveNow();
  }

  // --- query ---

  findSession(
    target: string,
  ): { chatId: string; record: SessionRecord } | undefined {
    // By claudeSessionId in active sessions
    for (const [chatId, session] of this.sessions) {
      const status = session.getStatus();
      if (status.claudeSessionId === target) {
        return { chatId, record: this.statusToRecord(status) };
      }
    }
    // By claudeSessionId in stale
    for (const [chatId, record] of this.staleRecords) {
      if (record.claudeSessionId === target) {
        return { chatId, record };
      }
    }
    // By chatId in active
    if (this.sessions.has(target)) {
      const status = this.sessions.get(target)!.getStatus();
      return { chatId: target, record: this.statusToRecord(status) };
    }
    // By chatId in stale
    if (this.staleRecords.has(target)) {
      return { chatId: target, record: this.staleRecords.get(target)! };
    }
    return undefined;
  }

  getAllSessions(): Array<{
    chatId: string;
    record: SessionRecord;
    active: boolean;
  }> {
    const result: Array<{
      chatId: string;
      record: SessionRecord;
      active: boolean;
    }> = [];
    for (const [chatId, session] of this.sessions) {
      result.push({
        chatId,
        record: this.statusToRecord(session.getStatus()),
        active: true,
      });
    }
    for (const [chatId, record] of this.staleRecords) {
      result.push({ chatId, record, active: false });
    }
    return result;
  }

  // --- persistence helpers ---

  async flushPendingSave(): Promise<void> {
    if (this.debounceTimer !== null) {
      this.opts.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      await this.saveNow();
    }
  }

  buildSessionsSnapshot(): Record<string, SessionRecord> {
    const sessions: Record<string, SessionRecord> = {};
    for (const [chatId, session] of this.sessions) {
      const status = session.getStatus();
      if (!status.claudeSessionId) continue;
      sessions[chatId] = this.statusToRecord(status);
    }
    for (const [chatId, record] of this.staleRecords) {
      sessions[chatId] = record;
    }
    return sessions;
  }

  /** Trigger an immediate save (Scenario A). Used by dispatcher after /mode, /model, /cd changes. */
  persistNow(): void {
    void this.saveNow();
  }

  scheduleDebouncedSave(): void {
    if (!this.opts.stateStore) return;
    if (this.debounceTimer !== null) {
      this.opts.clock.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = this.opts.clock.setTimeout(() => {
      this.debounceTimer = null;
      void this.saveNow();
    }, DEBOUNCE_MS);
  }

  // --- private ---

  private async saveNow(): Promise<void> {
    if (!this.opts.stateStore) return;
    if (this.debounceTimer !== null) {
      this.opts.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const state: State = {
      version: 1,
      lastCleanShutdown: false,
      sessions: this.buildSessionsSnapshot(),
    };
    try {
      await this.opts.stateStore.save(state);
    } catch (err) {
      this.opts.logger.error({ err }, "Failed to persist session state");
    }
  }

  private statusToRecord(status: {
    claudeSessionId?: string;
    cwd: string;
    permissionMode: string;
    model: string;
    createdAt: string;
    lastActiveAt: string;
  }): SessionRecord {
    return {
      claudeSessionId: status.claudeSessionId ?? "",
      cwd: status.cwd,
      createdAt: status.createdAt,
      lastActiveAt: status.lastActiveAt,
      permissionMode: status.permissionMode,
      model: status.model,
    };
  }
}

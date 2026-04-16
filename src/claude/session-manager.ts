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
  mcpServers?: AppConfig["mcp"];
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
  /**
   * Internal maps use a *session key* rather than raw chatId.
   *
   * Key format:
   *   - Default project : `chatId`
   *   - Named project   : `chatId\tprojectAlias`
   *
   * The tab character is the separator — it cannot appear in Feishu chat IDs
   * or project alias names, so it's safe to use without escaping.
   */
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly cwdOverrides = new Map<string, string>();
  private readonly staleRecords = new Map<string, SessionRecord>();
  /** chatId → currently-active project alias (absent = default project). */
  private readonly activeProjects = new Map<string, string>();
  private readonly opts: ClaudeSessionManagerOptions;
  private debounceTimer: TimeoutHandle | null = null;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  // --- project helpers ---

  /** Returns the session-map key for the currently active project of chatId. */
  private activeSessionKey(chatId: string): string {
    const alias = this.activeProjects.get(chatId);
    return alias ? `${chatId}\t${alias}` : chatId;
  }

  /** Parse a session key back into its components. */
  private parseSessionKey(key: string): { chatId: string; projectAlias?: string } {
    const tab = key.indexOf("\t");
    if (tab === -1) return { chatId: key };
    return { chatId: key.slice(0, tab), projectAlias: key.slice(tab + 1) };
  }

  // --- lifecycle ---

  async startupLoad(): Promise<void> {
    if (!this.opts.stateStore) return;
    const state = await this.opts.stateStore.load();
    const now = Date.now();
    const ttlMs = (this.opts.sessionTtlDays ?? 30) * 24 * 60 * 60 * 1000;

    // Sessions are keyed by chatId or chatId\tprojectAlias — preserve as-is.
    for (const [key, record] of Object.entries(state.sessions)) {
      const lastActive = new Date(record.lastActiveAt).getTime();
      if (now - lastActive > ttlMs) continue;
      this.staleRecords.set(key, record);
    }

    // Restore active project per chatId.
    for (const [chatId, alias] of Object.entries(state.activeProjects ?? {})) {
      this.activeProjects.set(chatId, alias);
    }

    // Persist the pruned set so expired sessions are dropped from disk.
    await this.saveNow();
  }

  async crashRecovery(lastCleanShutdown: boolean): Promise<void> {
    if (lastCleanShutdown) return;
    if (!this.opts.feishuClient) return;

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    // Deduplicate by real chatId so we send at most one notification per chat
    // even when that chat has multiple project sessions.
    const notified = new Set<string>();
    for (const [key, record] of this.staleRecords) {
      const lastActive = new Date(record.lastActiveAt).getTime();
      if (lastActive < oneHourAgo) continue;

      const { chatId } = this.parseSessionKey(key);
      if (notified.has(chatId)) continue;
      notified.add(chatId);

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
    const key = this.activeSessionKey(chatId);
    let session = this.sessions.get(key);
    if (session !== undefined) return session;

    const stale = this.staleRecords.get(key);
    const cwdOverride = this.cwdOverrides.get(key);

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
      this.staleRecords.delete(key);
    } else {
      cwd = cwdOverride ?? this.opts.config.defaultCwd;
    }

    session = new ClaudeSession({
      chatId,
      config: { ...this.opts.config, defaultCwd: cwd },
      mcpServers: this.opts.mcpServers ?? [],
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

    this.sessions.set(key, session);
    return session;
  }

  delete(chatId: string): void {
    const key = this.activeSessionKey(chatId);
    this.sessions.delete(key);
    this.staleRecords.delete(key);
    void this.saveNow();
  }

  setCwdOverride(chatId: string, cwd: string): void {
    this.cwdOverrides.set(this.activeSessionKey(chatId), cwd);
  }

  setStaleRecord(chatId: string, record: SessionRecord): void {
    this.staleRecords.set(this.activeSessionKey(chatId), record);
    void this.saveNow();
  }

  /**
   * Switch the active project for a chat.  The previous project's session
   * stays alive in memory and can be restored by switching back.  If the
   * target project has no saved session yet, `cwd` is used as the initial
   * working directory.
   */
  switchProject(chatId: string, alias: string, cwd: string): void {
    const newKey = `${chatId}\t${alias}`;
    // Only apply the cwd as an initial override if no session exists yet.
    if (!this.sessions.has(newKey) && !this.staleRecords.has(newKey)) {
      this.cwdOverrides.set(newKey, cwd);
    }
    this.activeProjects.set(chatId, alias);
    void this.saveNow();
  }

  /** Returns the currently active project alias, or undefined for the default project. */
  getActiveProject(chatId: string): string | undefined {
    return this.activeProjects.get(chatId);
  }

  // --- query ---

  findSession(
    target: string,
  ): { chatId: string; record: SessionRecord } | undefined {
    // By claudeSessionId in active sessions
    for (const [key, session] of this.sessions) {
      const status = session.getStatus();
      if (status.claudeSessionId === target) {
        const { chatId } = this.parseSessionKey(key);
        return { chatId, record: this.statusToRecord(status) };
      }
    }
    // By claudeSessionId in stale
    for (const [key, record] of this.staleRecords) {
      if (record.claudeSessionId === target) {
        const { chatId } = this.parseSessionKey(key);
        return { chatId, record };
      }
    }
    // By chatId: match against the active session key for that chatId
    const activeKey = this.activeSessionKey(target);
    if (this.sessions.has(activeKey)) {
      const status = this.sessions.get(activeKey)!.getStatus();
      return { chatId: target, record: this.statusToRecord(status) };
    }
    if (this.staleRecords.has(activeKey)) {
      return { chatId: target, record: this.staleRecords.get(activeKey)! };
    }
    return undefined;
  }

  getAllSessions(): Array<{
    chatId: string;
    projectAlias?: string;
    record: SessionRecord;
    active: boolean;
  }> {
    const result: Array<{
      chatId: string;
      projectAlias?: string;
      record: SessionRecord;
      active: boolean;
    }> = [];
    for (const [key, session] of this.sessions) {
      const { chatId, projectAlias } = this.parseSessionKey(key);
      const entry: { chatId: string; projectAlias?: string; record: SessionRecord; active: boolean } = {
        chatId,
        record: this.statusToRecord(session.getStatus()),
        active: true,
      };
      if (projectAlias !== undefined) entry.projectAlias = projectAlias;
      result.push(entry);
    }
    for (const [key, record] of this.staleRecords) {
      const { chatId, projectAlias } = this.parseSessionKey(key);
      const entry: { chatId: string; projectAlias?: string; record: SessionRecord; active: boolean } = {
        chatId,
        record,
        active: false,
      };
      if (projectAlias !== undefined) entry.projectAlias = projectAlias;
      result.push(entry);
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

  getActiveProjectsSnapshot(): Record<string, string> {
    return Object.fromEntries(this.activeProjects);
  }

  buildSessionsSnapshot(): Record<string, SessionRecord> {
    const sessions: Record<string, SessionRecord> = {};
    // Active sessions use composite keys; preserve them as-is.
    for (const [key, session] of this.sessions) {
      const status = session.getStatus();
      if (!status.claudeSessionId && !session.hasExplicitOverrides()) continue;
      sessions[key] = this.statusToRecord(status);
    }
    for (const [key, record] of this.staleRecords) {
      sessions[key] = record;
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
      version: 2,
      lastCleanShutdown: false,
      sessions: this.buildSessionsSnapshot(),
      activeProjects: Object.fromEntries(this.activeProjects),
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

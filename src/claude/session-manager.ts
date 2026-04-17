import type { Logger } from "pino";
import { ClaudeSession, type QueryFn, type SessionStatus } from "./session.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { QuestionBroker } from "./question-broker.js";
import type { AgentProvider, AppConfig } from "../types.js";
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
  providerQueryFns?: Partial<Record<AgentProvider, QueryFn>>;
  providerConfigs?: Pick<AppConfig, "claude" | "codex">;
  defaultProvider?: AgentProvider;
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
   *   - Default project : `chatId\t\tprovider`
   *   - Named project   : `chatId\tprojectAlias\tprovider`
   *
   * The tab character is the separator — it cannot appear in Feishu chat IDs
   * or project alias names, so it's safe to use without escaping.
   */
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly cwdOverrides = new Map<string, string>();
  private readonly providerOverrides = new Map<string, AgentProvider>();
  private readonly staleRecords = new Map<string, SessionRecord>();
  /** chatId → currently-active project alias (absent = default project). */
  private readonly activeProjects = new Map<string, string>();
  private readonly opts: ClaudeSessionManagerOptions;
  private debounceTimer: TimeoutHandle | null = null;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  // --- project helpers ---

  /** Returns the project-scope key for the currently active project of chatId. */
  private activeProjectKey(chatId: string): string {
    return this.projectKey(chatId, this.activeProjects.get(chatId));
  }

  private projectKey(chatId: string, projectAlias?: string): string {
    return projectAlias ? `${chatId}\t${projectAlias}` : chatId;
  }

  private sessionKey(
    chatId: string,
    provider: AgentProvider,
    projectAlias = this.activeProjects.get(chatId),
  ): string {
    return `${chatId}\t${projectAlias ?? ""}\t${provider}`;
  }

  /** Returns the session-map key for the currently selected provider/project of chatId. */
  private activeSessionKey(chatId: string): string {
    return this.sessionKey(chatId, this.getEffectiveProvider(chatId));
  }

  /** Parse a session key back into its components. */
  private parseSessionKey(key: string): {
    chatId: string;
    projectAlias?: string;
    provider?: AgentProvider;
  } {
    const parts = key.split("\t");
    if (
      parts.length === 3 &&
      (parts[2] === "claude" || parts[2] === "codex")
    ) {
      const parsed: {
        chatId: string;
        projectAlias?: string;
        provider?: AgentProvider;
      } = {
        chatId: parts[0] ?? key,
        provider: parts[2],
      };
      if (parts[1]) parsed.projectAlias = parts[1];
      return parsed;
    }
    if (parts.length === 2) {
      const parsed: {
        chatId: string;
        projectAlias?: string;
        provider?: AgentProvider;
      } = {
        chatId: parts[0] ?? key,
      };
      if (parts[1]) parsed.projectAlias = parts[1];
      return parsed;
    }
    return { chatId: key };
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
      const parsed = this.parseSessionKey(key);
      const normalizedKey = parsed.provider
        ? key
        : this.sessionKey(parsed.chatId, record.provider, parsed.projectAlias);
      this.staleRecords.set(normalizedKey, record);
    }

    // Restore active project per chatId.
    for (const [chatId, alias] of Object.entries(state.activeProjects ?? {})) {
      this.activeProjects.set(chatId, alias);
    }
    for (const [key, provider] of Object.entries(state.activeProviders ?? {})) {
      this.providerOverrides.set(key, provider);
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
    const effectiveProvider = this.getEffectiveProvider(chatId);
    const key = this.sessionKey(chatId, effectiveProvider);
    let session = this.sessions.get(key);
    if (session !== undefined) return session;

    const stale = this.staleRecords.get(key);
    const cwdOverride = this.cwdOverrides.get(key);
    const queryFn =
      this.opts.providerQueryFns?.[effectiveProvider] ?? this.opts.queryFn;

    let cwd: string;
    let permissionMode:
      | AppConfig["claude"]["defaultPermissionMode"]
      | undefined;
    let model: string | undefined;
    let providerSessionId: string | undefined;

    if (stale) {
      cwd = cwdOverride ?? stale.cwd;
      permissionMode = stale.permissionMode as
        | AppConfig["claude"]["defaultPermissionMode"]
        | undefined;
      model = stale.model;
      providerSessionId = stale.providerSessionId;
      this.staleRecords.delete(key);
    } else {
      cwd = cwdOverride ?? this.opts.config.defaultCwd;
    }

    session = new ClaudeSession({
      chatId,
      config: {
        ...this.opts.config,
        defaultCwd: cwd,
        defaultModel: this.getDefaultModelForProvider(effectiveProvider),
      },
      mcpServers: this.opts.mcpServers ?? [],
      queryFn,
      clock: this.opts.clock,
      permissionBroker: this.opts.permissionBroker,
      questionBroker: this.opts.questionBroker,
      logger: this.opts.logger,
      onSessionIdCaptured: () => void this.saveNow(),
      onTurnComplete: () => this.scheduleDebouncedSave(),
    });

    session.setProvider(effectiveProvider);

    if (permissionMode) {
      session.setPermissionModeOverride(permissionMode);
    }
    if (model) {
      session.setModelOverride(model);
    } else if (effectiveProvider === "codex") {
      session.setModelOverride(this.getDefaultModelForProvider("codex"));
    }
    if (providerSessionId) {
      session.setProviderSessionId(providerSessionId);
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

  setProviderOverride(chatId: string, provider: AgentProvider): void {
    this.providerOverrides.set(this.activeProjectKey(chatId), provider);
  }

  getEffectiveProvider(chatId: string): AgentProvider {
    const key = this.activeProjectKey(chatId);
    return this.providerOverrides.get(key)
      ?? this.inferProviderForProject(chatId, this.activeProjects.get(chatId))
      ?? this.getDefaultProvider();
  }

  setStaleRecord(chatId: string, record: SessionRecord): void {
    this.providerOverrides.set(this.activeProjectKey(chatId), record.provider);
    this.staleRecords.set(this.sessionKey(chatId, record.provider), record);
    void this.saveNow();
  }

  /**
   * Switch the active project for a chat.  The previous project's session
   * stays alive in memory and can be restored by switching back.  If the
   * target project has no saved session yet, `cwd` is used as the initial
   * working directory.
   */
  switchProject(chatId: string, alias: string, cwd: string): void {
    this.activeProjects.set(chatId, alias);
    // Only apply the cwd as an initial override if no session exists yet.
    for (const provider of ["claude", "codex"] as const) {
      const newKey = this.sessionKey(chatId, provider, alias);
      if (!this.sessions.has(newKey) && !this.staleRecords.has(newKey)) {
        this.cwdOverrides.set(newKey, cwd);
      }
    }
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
    // By provider session ID in active sessions
    for (const [key, session] of this.sessions) {
      const status = session.getStatus();
      if (status.providerSessionId === target) {
        const { chatId } = this.parseSessionKey(key);
        return {
          chatId,
          record: this.statusToRecord(this.requireProviderSessionStatus(status)),
        };
      }
    }
    // By provider session ID in stale
    for (const [key, record] of this.staleRecords) {
      if (record.providerSessionId === target) {
        const { chatId } = this.parseSessionKey(key);
        return { chatId, record };
      }
    }
    // By chatId: match against the active session key for that chatId
    const activeKey = this.activeSessionKey(target);
    if (this.sessions.has(activeKey)) {
      const status = this.sessions.get(activeKey)!.getStatus();
      if (!status.providerSessionId) return undefined;
      return {
        chatId: target,
        record: this.statusToRecord(this.requireProviderSessionStatus(status)),
      };
    }
    if (this.staleRecords.has(activeKey)) {
      return { chatId: target, record: this.staleRecords.get(activeKey)! };
    }
    return undefined;
  }

  getAllSessions(): Array<{
    chatId: string;
    projectAlias?: string;
    record: Omit<SessionRecord, "providerSessionId"> & { providerSessionId?: string };
    active: boolean;
  }> {
    const result: Array<{
      chatId: string;
      projectAlias?: string;
      record: Omit<SessionRecord, "providerSessionId"> & { providerSessionId?: string };
      active: boolean;
    }> = [];
    for (const [key, session] of this.sessions) {
      const status = session.getStatus();
      const { chatId, projectAlias } = this.parseSessionKey(key);
      const entry: {
        chatId: string;
        projectAlias?: string;
        record: Omit<SessionRecord, "providerSessionId"> & { providerSessionId?: string };
        active: boolean;
      } = {
        chatId,
        record: status.providerSessionId
          ? this.statusToRecord(this.requireProviderSessionStatus(status))
          : {
            provider: this.getEffectiveProvider(chatId),
            cwd: status.cwd,
            createdAt: status.createdAt,
            lastActiveAt: status.lastActiveAt,
            permissionMode: status.permissionMode,
            model: status.model,
          },
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

  getActiveProvidersSnapshot(): Record<string, AgentProvider> {
    return Object.fromEntries(this.providerOverrides);
  }

  buildSessionsSnapshot(): Record<string, SessionRecord> {
    const sessions: Record<string, SessionRecord> = {};
    // Active sessions use composite keys; preserve them as-is.
    for (const [key, session] of this.sessions) {
      const status = session.getStatus();
      if (!this.shouldPersistSession(status)) continue;
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
      version: 3,
      lastCleanShutdown: false,
      sessions: this.buildSessionsSnapshot(),
      activeProjects: Object.fromEntries(this.activeProjects),
      activeProviders: Object.fromEntries(this.providerOverrides),
    };
    try {
      await this.opts.stateStore.save(state);
    } catch (err) {
      this.opts.logger.error({ err }, "Failed to persist session state");
    }
  }

  private getDefaultProvider(): AgentProvider {
    return this.opts.defaultProvider ?? "claude";
  }

  private getDefaultModelForProvider(provider: AgentProvider): string {
    if (provider === "claude") {
      return this.opts.providerConfigs?.claude.defaultModel ?? this.opts.config.defaultModel;
    }
    return this.opts.providerConfigs?.codex.defaultModel ?? "gpt-5.4";
  }

  private requireProviderSessionStatus(
    status: SessionStatus,
  ): SessionStatus & { providerSessionId: string } {
    if (!status.providerSessionId) {
      throw new Error("Expected providerSessionId to be present");
    }
    return status as SessionStatus & { providerSessionId: string };
  }

  private statusToRecord(status: SessionStatus): SessionRecord {
    return {
      provider: status.provider,
      cwd: status.cwd,
      createdAt: status.createdAt,
      lastActiveAt: status.lastActiveAt,
      ...(status.providerSessionId
        ? { providerSessionId: status.providerSessionId }
        : {}),
      permissionMode: status.permissionMode,
      model: status.model,
    };
  }

  private shouldPersistSession(status: SessionStatus): boolean {
    return status.providerSessionId !== undefined
      || status.provider !== this.getDefaultProvider()
      || status.cwd !== this.opts.config.defaultCwd
      || status.permissionMode !== this.opts.config.defaultPermissionMode
      || status.model !== this.getDefaultModelForProvider(status.provider);
  }

  private inferProviderForProject(
    chatId: string,
    projectAlias?: string,
  ): AgentProvider | undefined {
    const providers = new Set<AgentProvider>();
    for (const [key, session] of this.sessions) {
      const parsed = this.parseSessionKey(key);
      if (parsed.chatId === chatId && parsed.projectAlias === projectAlias) {
        providers.add(session.getStatus().provider);
      }
    }
    for (const [key, record] of this.staleRecords) {
      const parsed = this.parseSessionKey(key);
      if (parsed.chatId === chatId && parsed.projectAlias === projectAlias) {
        providers.add(record.provider);
      }
    }
    return providers.size === 1
      ? [...providers][0]
      : undefined;
  }
}

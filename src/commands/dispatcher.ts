import crypto from "node:crypto";
import { access, appendFile, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ParsedCommand } from "./router.js";
import type { ClaudeSessionManager } from "../claude/session-manager.js";
import type { FeishuClient } from "../feishu/client.js";
import type { AppConfig } from "../types.js";
import type { PermissionBroker } from "../claude/permission-broker.js";
import type { QuestionBroker } from "../claude/question-broker.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { FeishuCardV2 } from "../feishu/card-types.js";
import {
  buildCdConfirmCard,
  buildCdConfirmResolved,
  buildCdConfirmCancelled,
  buildCdConfirmTimedOut,
} from "../feishu/cards/cd-confirm-card.js";
import { buildProjectsCard, buildSessionsCard } from "../feishu/cards.js";
import { writeConfigKey } from "../config.js";
import { t, type Locale } from "../util/i18n.js";

type KeyType = "boolean" | "number" | "fraction" | "string" | "enum";

const MODEL_CONTEXT_WINDOWS: Array<[prefix: string, tokens: number]> = [
  ["claude-3-haiku", 200_000],
  ["claude-3-5-haiku", 200_000],
  ["claude-3-5-sonnet", 200_000],
  ["claude-3-7-sonnet", 200_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
];

function contextWindowFor(model: string): number {
  for (const [prefix, size] of MODEL_CONTEXT_WINDOWS) {
    if (model.startsWith(prefix)) return size;
  }
  return 200_000;
}

interface SettableKeyDef {
  /** Path segments into AppConfig, e.g. ["render", "hideThinking"] */
  path: [string, string];
  type: KeyType;
  /** For "enum" type: valid values */
  values?: readonly string[];
  /** For "number" keys stored in different units: multiply raw value */
  multiplier?: number;
}

const SETTABLE_KEYS: Record<string, SettableKeyDef> = {
  "render.hide_thinking": { path: ["render", "hideThinking"], type: "boolean" },
  "render.show_turn_stats": { path: ["render", "showTurnStats"], type: "boolean" },
  "render.inline_max_bytes": { path: ["render", "inlineMaxBytes"], type: "number" },
  "logging.level": {
    path: ["logging", "level"],
    type: "enum",
    values: ["trace", "debug", "info", "warn", "error"],
  },
  "claude.default_model": { path: ["claude", "defaultModel"], type: "string" },
  "claude.default_cwd": { path: ["claude", "defaultCwd"], type: "string" },
  "claude.default_permission_mode": {
    path: ["claude", "defaultPermissionMode"],
    type: "enum",
    values: ["default", "acceptEdits", "plan", "bypassPermissions"],
  },
  "claude.permission_timeout_seconds": {
    path: ["claude", "permissionTimeoutMs"],
    type: "number",
    multiplier: 1000,
  },
  "claude.permission_warn_before_seconds": {
    path: ["claude", "permissionWarnBeforeMs"],
    type: "number",
    multiplier: 1000,
  },
  "claude.auto_compact_threshold": {
    path: ["claude", "autoCompactThreshold"],
    type: "fraction",
  },
};

function parseConfigValue(
  raw: string,
  def: SettableKeyDef,
): { ok: true; value: string | number | boolean } | {
  ok: false;
  reason: { kind: Exclude<KeyType, "enum"> } | { kind: "enum"; values: readonly string[] };
} {
  switch (def.type) {
    case "boolean":
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, reason: { kind: "boolean" } };
    case "number": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, reason: { kind: "number" } };
      }
      return { ok: true, value: n };
    }
    case "fraction": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { ok: false, reason: { kind: "fraction" } };
      }
      return { ok: true, value: n };
    }
    case "string":
      if (!raw) return { ok: false, reason: { kind: "string" } };
      return { ok: true, value: raw };
    case "enum":
      if (def.values!.includes(raw)) return { ok: true, value: raw };
      return { ok: false, reason: { kind: "enum", values: def.values! } };
  }
}

export interface CommandContext {
  chatId: string;
  senderOpenId: string;
  parentMessageId: string;
  /** Display language detected from the user's message text. */
  locale: Locale;
}

export type CdConfirmResult =
  | { kind: "resolved"; card: FeishuCardV2 }
  | { kind: "not_found" }
  | { kind: "forbidden"; ownerOpenId: string };

interface PendingCdConfirm {
  requestId: string;
  ownerOpenId: string;
  cardMessageId: string;
  targetPath: string;
  chatId: string;
  locale: Locale;
  timer: TimeoutHandle;
}

export interface CommandDispatcherOptions {
  sessionManager: ClaudeSessionManager;
  feishu: FeishuClient;
  config: AppConfig;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  clock: Clock;
  logger: Logger;
  configPath?: string;
}

export class CommandDispatcher {
  private readonly sessionManager: ClaudeSessionManager;
  private readonly feishu: FeishuClient;
  private readonly config: AppConfig;
  private readonly permissionBroker: PermissionBroker;
  private readonly questionBroker: QuestionBroker;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly configPath: string | undefined;
  private readonly pendingCdConfirms = new Map<string, PendingCdConfirm>();

  constructor(opts: CommandDispatcherOptions) {
    this.sessionManager = opts.sessionManager;
    this.feishu = opts.feishu;
    this.config = opts.config;
    this.permissionBroker = opts.permissionBroker;
    this.questionBroker = opts.questionBroker;
    this.clock = opts.clock;
    this.logger = opts.logger.child({ component: "CommandDispatcher" });
    this.configPath = opts.configPath;
  }

  async dispatch(cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
    switch (cmd.name) {
      case "help":
        return this.handleHelp(ctx);
      case "status":
        return this.handleStatus(ctx);
      case "cost":
        return this.handleCost(ctx);
      case "context":
        return this.handleContext(ctx);
      case "config_show":
        return this.handleConfigShow(ctx);
      case "new":
        return this.handleNew(ctx);
      case "compact":
        return this.handleCompact(ctx);
      case "provider":
        return this.handleProvider(cmd.provider, ctx);
      case "mode":
        return this.handleMode(cmd.mode, ctx);
      case "model":
        return this.handleModel(cmd.model, ctx);
      case "cd":
        return this.handleCd(cmd.path, ctx);
      case "project":
        return this.handleProject(cmd.alias, ctx);
      case "memory_show":
        return this.handleMemoryShow(ctx);
      case "memory_add":
        return this.handleMemoryAdd(cmd.text, ctx);
      case "sessions":
        return this.handleSessions(ctx);
      case "projects":
        return this.handleProjects(ctx);
      case "resume":
        return this.handleResume(cmd.target, ctx);
      case "config_set":
        return this.handleConfigSet(cmd.key, cmd.value, cmd.persist, ctx);
      default: {
        const _exhaustive: never = cmd;
        this.logger.warn({ cmd: _exhaustive }, "unhandled command");
        return;
      }
    }
  }

  async dispatchUnknown(raw: string, ctx: CommandContext): Promise<void> {
    await this.feishu.replyText(
      ctx.parentMessageId,
      t(ctx.locale).unknownCommand(raw),
    );
  }

  // --- Simple read-only command handlers ---

  private async handleHelp(ctx: CommandContext): Promise<void> {
    const s = t(ctx.locale);
    const text = [
      s.helpHeader,
      "",
      s.helpSectionSession,
      s.helpNew,
      s.helpCompact,
      s.helpStatus,
      s.helpCost,
      s.helpContext,
      s.helpStop,
      s.helpSessions,
      s.helpProjects,
      s.helpResume,
      "",
      s.helpSectionCwd,
      s.helpCd,
      s.helpProject,
      "",
      s.helpSectionMode,
      s.helpProvider,
      s.helpMode,
      s.helpModel,
      "",
      s.helpSectionConfig,
      s.helpConfigShow,
      s.helpConfigSet,
      s.helpConfigSetPersist,
      s.helpMemory,
      s.helpMemoryAdd,
      s.helpHelp,
    ].join("\n");

    await this.feishu.replyText(ctx.parentMessageId, text);
  }

  private async handleStatus(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    const status = session.getStatus();
    const provider = this.sessionManager.getEffectiveProvider(ctx.chatId);
    const projectAlias = this.sessionManager.getActiveProject(ctx.chatId);
    const s = t(ctx.locale);

    const lines = [
      s.statusState(status.state),
      s.statusProvider(provider),
      ...(projectAlias ? [`📁 ${projectAlias}`] : []),
      s.statusCwd(status.cwd),
      s.statusPermMode(status.permissionMode),
      s.statusModel(status.model),
      s.statusTurns(status.turnCount),
      s.statusInputTokens(status.totalInputTokens),
      s.statusOutputTokens(status.totalOutputTokens),
      s.statusQueueLen(status.queueLength),
    ];

    await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
  }

  private async handleCost(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    const status = session.getStatus();
    const s = t(ctx.locale);
    const total = status.totalInputTokens + status.totalOutputTokens;
    await this.feishu.replyText(
      ctx.parentMessageId,
      [
        s.costHeader,
        "",
        s.costInput(status.totalInputTokens),
        s.costOutput(status.totalOutputTokens),
        s.costTotal(total),
        "",
        s.costNote,
      ].join("\n"),
    );
  }

  private async handleContext(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    const status = session.getStatus();
    const s = t(ctx.locale);
    const windowSize = contextWindowFor(status.model);
    const used = status.totalInputTokens;
    const pct = ((used / windowSize) * 100).toFixed(1);
    const lines = [
      s.contextHeader,
      "",
      s.contextUsed(used),
      s.contextWindow(windowSize),
      s.contextPercent(pct),
    ];
    if (used / windowSize > 0.8) {
      lines.push("", s.contextWarning, s.contextStages);
    }
    await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
  }

  private async handleConfigShow(ctx: CommandContext): Promise<void> {
    const cfg = this.config;
    const s = t(ctx.locale);

    const lines: string[] = [
      s.configShowHeader,
      "",
      "[feishu]",
      `  appId: ${cfg.feishu.appId}`,
      `  appSecret: ***`,
      `  encryptKey: ***`,
      `  verificationToken: ***`,
      "",
      "[access]",
      `  allowedOpenIds: ${cfg.access.allowedOpenIds.join(", ") || "(none)"}`,
      `  unauthorizedBehavior: ${cfg.access.unauthorizedBehavior}`,
      "",
      "[agent]",
      `  defaultProvider: ${cfg.agent.defaultProvider}`,
      `  defaultCwd: ${cfg.agent.defaultCwd}`,
      `  defaultPermissionMode: ${cfg.agent.defaultPermissionMode}`,
      `  permissionTimeoutMs: ${cfg.agent.permissionTimeoutMs}`,
      `  permissionWarnBeforeMs: ${cfg.agent.permissionWarnBeforeMs}`,
      `  autoCompactThreshold: ${cfg.agent.autoCompactThreshold ?? "(default)"}`,
      "",
      "[claude]",
      `  defaultCwd: ${cfg.claude.defaultCwd}`,
      `  defaultPermissionMode: ${cfg.claude.defaultPermissionMode}`,
      `  defaultModel: ${cfg.claude.defaultModel}`,
      `  cliPath: ${cfg.claude.cliPath}`,
      `  permissionTimeoutMs: ${cfg.claude.permissionTimeoutMs}`,
      `  permissionWarnBeforeMs: ${cfg.claude.permissionWarnBeforeMs}`,
      `  autoCompactThreshold: ${cfg.claude.autoCompactThreshold ?? "(default)"}`,
      "",
      "[codex]",
      `  defaultModel: ${cfg.codex.defaultModel}`,
      `  cliPath: ${cfg.codex.cliPath}`,
      "",
      "[render]",
      `  inlineMaxBytes: ${cfg.render.inlineMaxBytes}`,
      `  hideThinking: ${cfg.render.hideThinking}`,
      `  showTurnStats: ${cfg.render.showTurnStats}`,
      "",
      "[persistence]",
      `  stateFile: ${cfg.persistence.stateFile}`,
      `  logDir: ${cfg.persistence.logDir}`,
      "",
      "[logging]",
      `  level: ${cfg.logging.level}`,
      "",
      "[projects]",
    ];

    const projectEntries = Object.entries(cfg.projects);
    if (projectEntries.length === 0) {
      lines.push("  (none)");
    } else {
      for (const [alias, path] of projectEntries) {
        lines.push(`  ${alias}: ${path}`);
      }
    }

    await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
  }

  private async handleConfigSet(
    key: string,
    rawValue: string,
    persist: boolean,
    ctx: CommandContext,
  ): Promise<void> {
    const def = SETTABLE_KEYS[key];
    if (!def) {
      const validKeys = Object.keys(SETTABLE_KEYS).join(", ");
      await this.feishu.replyText(
        ctx.parentMessageId,
        t(ctx.locale).configUnsupported(key, validKeys),
      );
      return;
    }

    const parsed = parseConfigValue(rawValue, def);
    if (!parsed.ok) {
      const s = t(ctx.locale);
      const reason = (() => {
        switch (parsed.reason.kind) {
          case "boolean":
            return s.configBoolExpected;
          case "number":
            return s.configPosIntExpected;
          case "fraction":
            return "0.0–1.0";
          case "string":
            return s.configNonEmptyStringExpected;
          case "enum":
            return s.configEnumExpected(parsed.reason.values.join(" | "));
        }
      })();
      await this.feishu.replyText(
        ctx.parentMessageId,
        s.configInvalidValue(rawValue, key, reason),
      );
      return;
    }

    // Mutate the shared config in place
    const [section, field] = def.path;
    const storeValue = def.multiplier
      ? (parsed.value as number) * def.multiplier
      : parsed.value;
    (this.config as unknown as Record<string, Record<string, unknown>>)[section]![field] =
      storeValue;

    // Persist to TOML if requested
    let persistMsg = "";
    if (persist) {
      if (!this.configPath) {
        persistMsg = t(ctx.locale).configPersistSkipped;
      } else {
        try {
          await writeConfigKey(this.configPath, key, parsed.value);
          persistMsg = t(ctx.locale).configPersisted;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          persistMsg = t(ctx.locale).configPersistFailed(errMsg);
          this.logger.error({ err, key }, "writeConfigKey failed");
        }
      }
    }

    await this.feishu.replyText(
      ctx.parentMessageId,
      t(ctx.locale).configUpdated(key, String(parsed.value), persistMsg),
    );
  }

  // --- Placeholder stubs for Tasks 8-9 ---

  private async handleNew(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      const noopEmit = async () => {};
      await session.stop(noopEmit);
    }
    this.permissionBroker.cancelAll("new session");
    this.questionBroker.cancelAll("new session");
    this.sessionManager.delete(ctx.chatId);
    await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).newSessionStarted);
  }

  private async handleCompact(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
      return;
    }
    this.permissionBroker.cancelAll("compact");
    this.questionBroker.cancelAll("compact");
    this.sessionManager.delete(ctx.chatId);
    await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).compactStarted);
  }

  private async handleMode(
    mode: string,
    ctx: CommandContext,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
      return;
    }
    session.setPermissionModeOverride(mode as "default" | "acceptEdits" | "plan" | "bypassPermissions");
    this.sessionManager.persistNow();
    await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).modeSwitched(mode));
  }

  private async handleProvider(
    provider: "claude" | "codex",
    ctx: CommandContext,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
      return;
    }
    this.sessionManager.setProviderOverride(ctx.chatId, provider);
    this.sessionManager.delete(ctx.chatId);
    await this.feishu.replyText(
      ctx.parentMessageId,
      t(ctx.locale).providerSwitched(provider),
    );
  }

  private async handleModel(
    model: string,
    ctx: CommandContext,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
      return;
    }
    session.setModelOverride(model);
    this.sessionManager.persistNow();
    await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).modelSwitched(model));
  }

  private async handleCd(path: string, ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
      return;
    }
    try {
      const s = await stat(path);
      if (!s.isDirectory()) {
        await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).cdNotDir(path));
        return;
      }
    } catch {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).cdNotFound(path));
      return;
    }
    const requestId = crypto.randomUUID();
    const card = buildCdConfirmCard({ requestId, targetPath: path, locale: ctx.locale });
    let cardMessageId: string;
    try {
      const res = await this.feishu.replyCard(ctx.parentMessageId, card);
      cardMessageId = res.messageId;
    } catch (err) {
      this.logger.error({ err }, "Failed to send cd confirm card");
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).cdSendFailed);
      return;
    }
    const timer = this.clock.setTimeout(() => this.cdTimeout(requestId), 60_000);
    this.pendingCdConfirms.set(requestId, {
      requestId,
      ownerOpenId: ctx.senderOpenId,
      cardMessageId,
      targetPath: path,
      chatId: ctx.chatId,
      locale: ctx.locale,
      timer,
    });
  }

  private async handleProject(alias: string, ctx: CommandContext): Promise<void> {
    const resolved = this.config.projects[alias];
    if (!resolved) {
      const available = Object.keys(this.config.projects);
      const list = available.length > 0 ? available.join(", ") : "(none configured)";
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).projectUnknown(alias, list));
      return;
    }

    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
      return;
    }

    const previous = this.sessionManager.getActiveProject(ctx.chatId);
    if (previous === alias) {
      await this.feishu.replyText(ctx.parentMessageId, `已在项目 ${alias}，工作目录: ${session.getStatus().cwd}`);
      return;
    }

    this.sessionManager.switchProject(ctx.chatId, alias, resolved);
    const suffix = previous ? `（上一个项目: ${previous}）` : "";
    await this.feishu.replyText(
      ctx.parentMessageId,
      `已切换到项目 ${alias}，工作目录: ${resolved}${suffix}`,
    );
  }

  private async handleProjects(ctx: CommandContext): Promise<void> {
    const configured = Object.entries(this.config.projects);
    if (configured.length === 0) {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).projectsNone);
      return;
    }

    // Build a lookup: projectAlias → session status for this chatId.
    const allSessions = this.sessionManager.getAllSessions();
    const sessionStatusMap = new Map<string, "active" | "stale">();
    for (const entry of allSessions) {
      if (entry.chatId !== ctx.chatId) continue;
      if (entry.projectAlias === undefined) continue;
      // active wins over stale if both somehow exist
      if (entry.active || !sessionStatusMap.has(entry.projectAlias)) {
        sessionStatusMap.set(entry.projectAlias, entry.active ? "active" : "stale");
      }
    }

    const activeAlias = this.sessionManager.getActiveProject(ctx.chatId);
    const entries = configured.map(([alias, cwd]) => ({
      alias,
      cwd,
      currentProject: alias === activeAlias,
      sessionStatus: sessionStatusMap.get(alias) ?? ("none" as const),
    }));

    const card = buildProjectsCard(entries, ctx.locale);
    await this.feishu.replyCard(ctx.parentMessageId, card);
  }

  private async handleSessions(ctx: CommandContext): Promise<void> {
    const all = this.sessionManager.getAllSessions();
    if (all.length === 0) {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionsNone);
      return;
    }

    const card = buildSessionsCard(all, ctx.locale);
    await this.feishu.replyCard(ctx.parentMessageId, card);
  }

  private async handleResume(target: string, ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(
        ctx.parentMessageId,
        t(ctx.locale).sessionBusy,
      );
      return;
    }

    if (
      target === ctx.chatId
      && this.sessionManager.getAllSessions().some((entry) =>
        entry.chatId === ctx.chatId && entry.active
      )
    ) {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).resumeAlreadyHere);
      return;
    }

    let found = this.sessionManager.findSession(target);
    if (!found) {
      const entry = this.sessionManager.getAllSessions().find((item) => item.chatId === target);
      if (entry) {
        found = {
          chatId: entry.chatId,
          record: {
            ...entry.record,
            providerSessionId: entry.record.providerSessionId ?? entry.chatId,
          },
        };
      }
    }
    if (!found) {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).resumeNotFound(target));
      return;
    }
    if (found.chatId === ctx.chatId) {
      await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).resumeAlreadyHere);
      return;
    }

    this.sessionManager.delete(ctx.chatId);
    this.sessionManager.setStaleRecord(ctx.chatId, found.record);

    const providerSessionId = found.record.providerSessionId ?? found.chatId;
    const shortId = providerSessionId.length > 12
      ? providerSessionId.slice(0, 12) + "…"
      : providerSessionId;
    await this.feishu.replyText(
      ctx.parentMessageId,
      t(ctx.locale).resumeSuccess(shortId, found.record.cwd),
    );
  }

  private async handleMemoryShow(ctx: CommandContext): Promise<void> {
    const s = t(ctx.locale);
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    const cwd = session.getStatus().cwd;
    const globalPath = join(homedir(), ".claude", "CLAUDE.md");
    const projectPath = join(cwd, "CLAUDE.md");

    const readOrEmpty = async (filePath: string): Promise<string | null> => {
      try {
        await access(filePath);
        return await readFile(filePath, "utf8");
      } catch {
        return null;
      }
    };

    const [globalContent, projectContent] = await Promise.all([
      readOrEmpty(globalPath),
      readOrEmpty(projectPath),
    ]);

    if (globalContent === null && projectContent === null) {
      await this.feishu.replyText(ctx.parentMessageId, s.memoryNone);
      return;
    }

    const parts: string[] = [];
    if (globalContent !== null) {
      parts.push(s.memoryGlobalHeader, globalContent.trim() || s.memoryEmpty);
    }
    if (projectContent !== null) {
      parts.push(
        s.memoryProjectHeader(cwd),
        projectContent.trim() || s.memoryEmpty,
      );
    }

    await this.feishu.replyText(ctx.parentMessageId, parts.join("\n\n"));
  }

  private async handleMemoryAdd(text: string, ctx: CommandContext): Promise<void> {
    const s = t(ctx.locale);
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    const cwd = session.getStatus().cwd;
    const projectPath = join(cwd, "CLAUDE.md");

    try {
      await appendFile(projectPath, `\n- ${text}\n`, "utf8");
      await this.feishu.replyText(ctx.parentMessageId, s.memoryAdded(projectPath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.feishu.replyText(ctx.parentMessageId, s.memoryAddFailed(msg));
    }
  }

  async resolveCdConfirm(args: {
    requestId: string;
    senderOpenId: string;
    accepted: boolean;
  }): Promise<CdConfirmResult> {
    const p = this.pendingCdConfirms.get(args.requestId);
    if (!p) return { kind: "not_found" };
    if (args.senderOpenId !== p.ownerOpenId) {
      return { kind: "forbidden", ownerOpenId: p.ownerOpenId };
    }
    this.clock.clearTimeout(p.timer);
    this.pendingCdConfirms.delete(args.requestId);
    if (args.accepted) {
      this.sessionManager.delete(p.chatId);
      this.sessionManager.setCwdOverride(p.chatId, p.targetPath);
      return { kind: "resolved", card: buildCdConfirmResolved({ targetPath: p.targetPath, locale: p.locale }) };
    }
    return { kind: "resolved", card: buildCdConfirmCancelled({ locale: p.locale }) };
  }

  private cdTimeout(requestId: string): void {
    const p = this.pendingCdConfirms.get(requestId);
    if (!p) return;
    this.pendingCdConfirms.delete(requestId);
    void this.feishu.patchCard(p.cardMessageId, buildCdConfirmTimedOut({ locale: p.locale })).catch((err) => {
      this.logger.warn({ err, requestId }, "cd timeout patch failed");
    });
  }
}

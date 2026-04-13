import crypto from "node:crypto";
import { stat } from "node:fs/promises";
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
import { buildSessionsCard } from "../feishu/cards.js";
import { writeConfigKey } from "../config.js";
import type { Locale } from "../util/i18n.js";

type KeyType = "boolean" | "number" | "string" | "enum";

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
};

function parseConfigValue(
  raw: string,
  def: SettableKeyDef,
): { ok: true; value: string | number | boolean } | { ok: false; reason: string } {
  switch (def.type) {
    case "boolean":
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, reason: "布尔值，需要 true 或 false" };
    case "number": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, reason: "正整数" };
      }
      return { ok: true, value: n };
    }
    case "string":
      if (!raw) return { ok: false, reason: "非空字符串" };
      return { ok: true, value: raw };
    case "enum":
      if (def.values!.includes(raw)) return { ok: true, value: raw };
      return { ok: false, reason: `枚举值: ${def.values!.join(" | ")}` };
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
      case "config_show":
        return this.handleConfigShow(ctx);
      case "new":
        return this.handleNew(ctx);
      case "mode":
        return this.handleMode(cmd.mode, ctx);
      case "model":
        return this.handleModel(cmd.model, ctx);
      case "cd":
        return this.handleCd(cmd.path, ctx);
      case "project":
        return this.handleProject(cmd.alias, ctx);
      case "sessions":
        return this.handleSessions(ctx);
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
      `未知命令 ${raw}，发 /help 查看可用命令`,
    );
  }

  // --- Simple read-only command handlers ---

  private async handleHelp(ctx: CommandContext): Promise<void> {
    const text = [
      "可用命令：",
      "",
      "会话管理",
      "  /new          — 开启新会话（清除上下文）",
      "  /status       — 查看当前会话状态",
      "  /stop         — 中断当前生成",
      "  /sessions     — 列出所有已知会话",
      "  /resume <id>  — 恢复到指定会话",
      "",
      "工作目录",
      "  /cd <路径>    — 切换工作目录",
      "  /project <别名> — 切换到已配置项目",
      "",
      "模型与权限",
      "  /mode <模式>  — 设置权限模式（default / acceptEdits / plan / bypassPermissions）",
      "  /model <名称> — 切换 Claude 模型",
      "",
      "配置与帮助",
      "  /config show  — 显示当前配置",
      "  /config set <key> <value> — 运行时修改配置",
      "  /config set <key> <value> --persist — 修改并写入文件",
      "  /help         — 显示此帮助",
    ].join("\n");

    await this.feishu.replyText(ctx.parentMessageId, text);
  }

  private async handleStatus(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    const status = session.getStatus();
    const projectAlias = this.sessionManager.getActiveProject(ctx.chatId);

    const lines = [
      `状态：${status.state}`,
      ...(projectAlias ? [`项目：${projectAlias}`] : []),
      `工作目录：${status.cwd}`,
      `权限模式：${status.permissionMode}`,
      `模型：${status.model}`,
      `已完成轮次：${status.turnCount}`,
      `输入 Token 合计：${status.totalInputTokens}`,
      `输出 Token 合计：${status.totalOutputTokens}`,
      `队列长度：${status.queueLength}`,
    ];

    await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
  }

  private async handleConfigShow(ctx: CommandContext): Promise<void> {
    const cfg = this.config;

    const lines: string[] = [
      "当前配置：",
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
      "[claude]",
      `  defaultCwd: ${cfg.claude.defaultCwd}`,
      `  defaultPermissionMode: ${cfg.claude.defaultPermissionMode}`,
      `  defaultModel: ${cfg.claude.defaultModel}`,
      `  cliPath: ${cfg.claude.cliPath}`,
      `  permissionTimeoutMs: ${cfg.claude.permissionTimeoutMs}`,
      `  permissionWarnBeforeMs: ${cfg.claude.permissionWarnBeforeMs}`,
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
        `不支持的配置项: ${key}\n可设置的配置项: ${validKeys}`,
      );
      return;
    }

    const parsed = parseConfigValue(rawValue, def);
    if (!parsed.ok) {
      await this.feishu.replyText(
        ctx.parentMessageId,
        `无效的值: ${rawValue}，${key} 需要 ${parsed.reason}`,
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
        persistMsg = "（持久化跳过：configPath 未配置）";
      } else {
        try {
          await writeConfigKey(this.configPath, key, parsed.value);
          persistMsg = "（已持久化）";
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          persistMsg = `（写入 config.toml 失败: ${errMsg}）`;
          this.logger.error({ err, key }, "writeConfigKey failed");
        }
      }
    }

    await this.feishu.replyText(
      ctx.parentMessageId,
      `配置已更新: ${key} = ${String(parsed.value)}${persistMsg ? " " + persistMsg : ""}`,
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
    await this.feishu.replyText(
      ctx.parentMessageId,
      "新会话已开始，下条消息将开启新对话",
    );
  }

  private async handleMode(
    mode: string,
    ctx: CommandContext,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, "会话正在执行中，请先发送 /stop 或等待完成");
      return;
    }
    session.setPermissionModeOverride(mode as "default" | "acceptEdits" | "plan" | "bypassPermissions");
    this.sessionManager.persistNow();
    await this.feishu.replyText(ctx.parentMessageId, `权限模式已切换为 ${mode}`);
  }

  private async handleModel(
    model: string,
    ctx: CommandContext,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, "会话正在执行中，请先发送 /stop 或等待完成");
      return;
    }
    session.setModelOverride(model);
    this.sessionManager.persistNow();
    await this.feishu.replyText(ctx.parentMessageId, `模型已切换为 ${model}`);
  }

  private async handleCd(path: string, ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, "会话正在执行中，请先发送 /stop 或等待完成");
      return;
    }
    try {
      const s = await stat(path);
      if (!s.isDirectory()) {
        await this.feishu.replyText(ctx.parentMessageId, `路径不是目录: ${path}`);
        return;
      }
    } catch {
      await this.feishu.replyText(ctx.parentMessageId, `路径不存在: ${path}`);
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
      await this.feishu.replyText(ctx.parentMessageId, "发送确认卡片失败");
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
      await this.feishu.replyText(ctx.parentMessageId, `未知项目别名: ${alias}，可用别名: ${list}`);
      return;
    }

    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(ctx.parentMessageId, "会话正在执行中，请先发送 /stop 或等待完成");
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

  private async handleSessions(ctx: CommandContext): Promise<void> {
    const all = this.sessionManager.getAllSessions();
    if (all.length === 0) {
      await this.feishu.replyText(ctx.parentMessageId, "暂无会话记录");
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
        "会话正在执行中，请先发送 /stop 或等待完成",
      );
      return;
    }

    const found = this.sessionManager.findSession(target);
    if (!found) {
      await this.feishu.replyText(ctx.parentMessageId, `未找到会话 ${target}`);
      return;
    }
    if (found.chatId === ctx.chatId) {
      await this.feishu.replyText(ctx.parentMessageId, "已经在该会话中");
      return;
    }

    this.sessionManager.delete(ctx.chatId);
    this.sessionManager.setStaleRecord(ctx.chatId, found.record);

    const shortId = found.record.claudeSessionId.length > 12
      ? found.record.claudeSessionId.slice(0, 12) + "…"
      : found.record.claudeSessionId;
    await this.feishu.replyText(
      ctx.parentMessageId,
      `已恢复会话 \`${shortId}\`, 工作目录: \`${found.record.cwd}\``,
    );
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

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

export interface CommandContext {
  chatId: string;
  senderOpenId: string;
  parentMessageId: string;
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
}

export class CommandDispatcher {
  private readonly sessionManager: ClaudeSessionManager;
  private readonly feishu: FeishuClient;
  private readonly config: AppConfig;
  private readonly permissionBroker: PermissionBroker;
  private readonly questionBroker: QuestionBroker;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly pendingCdConfirms = new Map<string, PendingCdConfirm>();

  constructor(opts: CommandDispatcherOptions) {
    this.sessionManager = opts.sessionManager;
    this.feishu = opts.feishu;
    this.config = opts.config;
    this.permissionBroker = opts.permissionBroker;
    this.questionBroker = opts.questionBroker;
    this.clock = opts.clock;
    this.logger = opts.logger.child({ component: "CommandDispatcher" });
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
      "  /help         — 显示此帮助",
    ].join("\n");

    await this.feishu.replyText(ctx.parentMessageId, text);
  }

  private async handleStatus(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    const status = session.getStatus();

    const text = [
      `状态：${status.state}`,
      `工作目录：${status.cwd}`,
      `权限模式：${status.permissionMode}`,
      `模型：${status.model}`,
      `已完成轮次：${status.turnCount}`,
      `输入 Token 合计：${status.totalInputTokens}`,
      `输出 Token 合计：${status.totalOutputTokens}`,
      `队列长度：${status.queueLength}`,
    ].join("\n");

    await this.feishu.replyText(ctx.parentMessageId, text);
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
    const card = buildCdConfirmCard({ requestId, targetPath: path });
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
    return this.handleCd(resolved, ctx);
  }

  private async handleSessions(ctx: CommandContext): Promise<void> {
    const all = this.sessionManager.getAllSessions();
    if (all.length === 0) {
      await this.feishu.replyText(ctx.parentMessageId, "暂无会话记录");
      return;
    }

    const lines = ["已知会话：", ""];
    for (const entry of all) {
      const short = entry.chatId.length > 16
        ? entry.chatId.slice(0, 16) + "…"
        : entry.chatId;
      const status = entry.active ? "active" : "stale";
      lines.push(
        `  ${short}  ${entry.record.cwd}  ${entry.record.model ?? "-"}  ${status}`,
      );
    }
    await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
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
      return { kind: "resolved", card: buildCdConfirmResolved({ targetPath: p.targetPath }) };
    }
    return { kind: "resolved", card: buildCdConfirmCancelled() };
  }

  private cdTimeout(requestId: string): void {
    const p = this.pendingCdConfirms.get(requestId);
    if (!p) return;
    this.pendingCdConfirms.delete(requestId);
    void this.feishu.patchCard(p.cardMessageId, buildCdConfirmTimedOut()).catch((err) => {
      this.logger.warn({ err, requestId }, "cd timeout patch failed");
    });
  }
}

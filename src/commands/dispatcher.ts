import type { Logger } from "pino";
import type { ParsedCommand } from "./router.js";
import type { ClaudeSessionManager } from "../claude/session-manager.js";
import type { FeishuClient } from "../feishu/client.js";
import type { AppConfig } from "../types.js";
import type { PermissionBroker } from "../claude/permission-broker.js";
import type { QuestionBroker } from "../claude/question-broker.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { FeishuCardV2 } from "../feishu/card-types.js";

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

    // Touch unused fields to avoid compiler warnings for future-use fields
    void this.clock;
    void this.pendingCdConfirms;
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

  private async handleCd(_path: string, _ctx: CommandContext): Promise<void> {
    throw new Error("not implemented");
  }

  private async handleProject(
    _alias: string,
    _ctx: CommandContext,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  async resolveCdConfirm(_args: {
    requestId: string;
    senderOpenId: string;
    approved: boolean;
  }): Promise<CdConfirmResult> {
    throw new Error("not implemented");
  }
}

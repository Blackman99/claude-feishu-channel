/**
 * Minimal i18n helper. Supports 'zh' (Chinese) and 'en' (English).
 * Language is detected from user message text and threaded through
 * every user-visible string so the bot always responds in the user's
 * language.
 */

export type Locale = "zh" | "en";

/**
 * Detect locale from user-supplied text. Returns 'zh' when the text
 * contains CJK Unified Ideographs, 'en' otherwise.
 */
export function detectLocale(text: string): Locale {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/.test(text) ? "zh" : "en";
}

/** All user-visible strings, keyed by locale. */
const STRINGS = {
  zh: {
    // ── messages.ts ──────────────────────────────────────────────
    statsLine: (seconds: string, input: number, output: number) =>
      `✅ 本轮耗时 ${seconds}s · 输入 ${input} / 输出 ${output} tokens`,
    errorLine: (message: string) => `❌ 错误: ${message}`,
    queued: (position: number) =>
      `📥 已加入队列 #${position}（当前有一个轮次在运行，发 \`/stop\` 可取消）`,
    stopped: "🛑 已停止",
    dropped:
      "⚠️ 你之前的消息在被 Claude 处理前已被后续指令打断丢弃",

    // ── cards.ts ─────────────────────────────────────────────────
    statusProcessing: "⏳ 正在处理...",
    statusDone: "✅ 完成",
    statusThinking: "💭 思考中...",
    thinkingPanelHeader: "💭 思考",
    intermediateRepliesHeader: (n: number) => `📝 中间回复（${n} 条）`,
    toolActivityPanelHeader: "🔧 工具活动",
    toolCount: (n: number) => `共 ${n} 个工具`,
    toolRunning: "⏳ 执行中...",

    // ── permission-card.ts ───────────────────────────────────────
    permCardHeader: (tool: string) => `🔐 权限请求 · ${tool}`,
    permCardPrompt: (tool: string) =>
      `Claude 要调用工具 **${tool}**：`,
    permBtnAllow: "✅ 允许",
    permBtnDeny: "❌ 拒绝",
    permBtnAllowTurn: "✅ 本轮 acceptEdits",
    permBtnAllowSession: "✅ 会话 acceptEdits",
    permFooter: "只有发起者可点击 · 5 分钟未响应自动拒绝",
    permResolvedAllow: "允许",
    permResolvedDeny: "拒绝",
    permResolvedAllowTurn: "本轮 acceptEdits",
    permResolvedAllowSession: "会话 acceptEdits",
    permCancelled: (tool: string, reason: string) =>
      `🛑 已取消 \`${tool}\`（${reason}）`,
    permTimedOut: (tool: string) => `⏰ 已超时 \`${tool}\``,
    permWarnReminder: (tool: string, secondsLeft: number) =>
      `⏰ 权限请求（${tool}）将在 ${secondsLeft}s 后自动拒绝`,

    // ── question-card.ts ─────────────────────────────────────────
    questionCardHeader: (count: number) =>
      count > 1 ? `🙋 问题 (${count})` : "🙋 问题",
    questionFooter: "只有发起者可点击 · 5 分钟未响应自动取消",
    questionCancelled: (reason: string) => `🛑 已取消提问（${reason}）`,
    questionTimedOut: "⏰ 提问已超时",
    questionWarnReminder: (secondsLeft: number) =>
      `⏰ 问题将在 ${secondsLeft}s 后自动取消`,

    // ── cd-confirm-card.ts ───────────────────────────────────────
    cdCardHeader: "📁 切换工作目录",
    cdCardPrompt: (path: string) => `切换工作目录至：\`${path}\``,
    cdBtnConfirm: "✅ 确认",
    cdBtnCancel: "❌ 取消",
    cdFooter: "只有发起者可点击 · 5 分钟未响应自动取消",
    cdResolved: (path: string) => `📁 工作目录已切换为 \`${path}\``,
    cdCancelled: "🛑 已取消切换工作目录",
    cdTimedOut: "⏰ 切换工作目录已超时",

    // ── session.ts (context reset) ────────────────────────────────
    contextReset:
      "⚠️ 对话上下文过大（超过 20MB 限制），已自动开启新会话重试您的消息。之前的对话历史已清除。",

    // ── session-manager.ts ───────────────────────────────────────
    crashRecovery:
      "⚠️ 上次 bot 异常重启，已恢复会话。请检查上一轮的执行结果是否完整",

    // ── dispatcher.ts ────────────────────────────────────────────
    unknownCommand: (raw: string) =>
      `未知命令 ${raw}，发 /help 查看可用命令`,
    helpHeader: "可用命令：",
    helpSectionSession: "会话管理",
    helpNew: "  /new          — 开启新会话（清除上下文）",
    helpStatus: "  /status       — 查看当前会话状态",
    helpStop: "  /stop         — 中断当前生成",
    helpSessions: "  /sessions     — 列出所有已知会话",
    helpResume: "  /resume <id>  — 恢复到指定会话",
    helpSectionCwd: "工作目录",
    helpCd: "  /cd <路径>    — 切换工作目录",
    helpProject: "  /project <别名> — 切换到已配置项目",
    helpProjects: "  /projects       — 查看所有已配置项目",
    helpSectionMode: "模型与权限",
    helpMode: "  /mode <模式>  — 设置权限模式（default / acceptEdits / plan / bypassPermissions）",
    helpModel: "  /model <名称> — 切换 Claude 模型",
    helpSectionConfig: "配置与帮助",
    helpConfigShow: "  /config show  — 显示当前配置",
    helpConfigSet: "  /config set <key> <value> — 运行时修改配置",
    helpConfigSetPersist:
      "  /config set <key> <value> --persist — 修改并写入文件",
    helpHelp: "  /help         — 显示此帮助",
    statusState: (v: string) => `状态：${v}`,
    statusCwd: (v: string) => `工作目录：${v}`,
    statusPermMode: (v: string) => `权限模式：${v}`,
    statusModel: (v: string) => `模型：${v}`,
    statusTurns: (v: number) => `已完成轮次：${v}`,
    statusInputTokens: (v: number) => `输入 Token 合计：${v}`,
    statusOutputTokens: (v: number) => `输出 Token 合计：${v}`,
    statusQueueLen: (v: number) => `队列长度：${v}`,
    configShowHeader: "当前配置：",
    configUnsupported: (key: string, valid: string) =>
      `不支持的配置项: ${key}\n可设置的配置项: ${valid}`,
    configInvalidValue: (rawValue: string, key: string, reason: string) =>
      `无效的值: ${rawValue}，${key} 需要 ${reason}`,
    configPersistSkipped: "（持久化跳过：configPath 未配置）",
    configPersisted: "（已持久化）",
    configPersistFailed: (msg: string) => `（写入 config.toml 失败: ${msg}）`,
    configUpdated: (key: string, value: string, persistMsg: string) =>
      `配置已更新: ${key} = ${value}${persistMsg ? " " + persistMsg : ""}`,
    configBoolExpected: "布尔值，需要 true 或 false",
    configPosIntExpected: "正整数",
    configNonEmptyStringExpected: "非空字符串",
    configEnumExpected: (values: string) => `枚举值: ${values}`,
    sessionBusy:
      "会话正在执行中，请先发送 /stop 或等待完成",
    newSessionStarted: "新会话已开始，下条消息将开启新对话",
    modeSwitched: (mode: string) => `权限模式已切换为 ${mode}`,
    modelSwitched: (model: string) => `模型已切换为 ${model}`,
    cdNotDir: (path: string) => `路径不是目录: ${path}`,
    cdNotFound: (path: string) => `路径不存在: ${path}`,
    cdSendFailed: "发送确认卡片失败",
    projectUnknown: (alias: string, list: string) =>
      `未知项目别名: ${alias}，可用别名: ${list}`,
    projectsNone: "暂无已配置项目",
    projectsHeader: "📋 项目列表",
    projectsCount: (n: number) => `共 ${n} 个项目`,
    projectsActive: "📌 当前",
    projectsSessionActive: "🟢 活跃会话",
    projectsSessionStale: "⚪ 有历史记录",
    projectsSessionNone: "— 无会话",
    projectsCwd: (cwd: string) => `目录：\`${cwd}\``,
    sessionsNone: "暂无会话记录",
    sessionsHeader: "📋 会话列表",
    sessionsCount: (n: number) => `共 ${n} 个会话`,
    sessionsProject: (alias: string) => `📁 ${alias}`,
    sessionsDefaultProject: "默认项目",
    sessionsCwd: (cwd: string) => `目录：\`${cwd}\``,
    sessionsModel: (model: string) => `模型：${model}`,
    sessionsActive: "🟢 活跃",
    sessionsStale: "⚪ 未活跃",
    sessionsLastActive: (timeAgo: string) => `最近活跃：${timeAgo}`,
    resumeNotFound: (id: string) => `未找到会话 ${id}`,
    resumeAlreadyHere: "已经在该会话中",
    resumeSuccess: (shortId: string, cwd: string) =>
      `已恢复会话 \`${shortId}\`, 工作目录: \`${cwd}\``,
  },

  en: {
    // ── messages.ts ──────────────────────────────────────────────
    statsLine: (seconds: string, input: number, output: number) =>
      `✅ Done in ${seconds}s · input ${input} / output ${output} tokens`,
    errorLine: (message: string) => `❌ Error: ${message}`,
    queued: (position: number) =>
      `📥 Queued as #${position} (a turn is running — send \`/stop\` to cancel)`,
    stopped: "🛑 Stopped",
    dropped:
      "⚠️ Your previous message was dropped before Claude could process it",

    // ── cards.ts ─────────────────────────────────────────────────
    statusProcessing: "⏳ Processing...",
    statusDone: "✅ Done",
    statusThinking: "💭 Thinking...",
    thinkingPanelHeader: "💭 Thinking",
    intermediateRepliesHeader: (n: number) => `📝 Intermediate replies (${n})`,
    toolActivityPanelHeader: "🔧 Tool Activity",
    toolCount: (n: number) => `${n} tool${n === 1 ? "" : "s"}`,
    toolRunning: "⏳ Running...",

    // ── permission-card.ts ───────────────────────────────────────
    permCardHeader: (tool: string) => `🔐 Permission Request · ${tool}`,
    permCardPrompt: (tool: string) =>
      `Claude wants to call **${tool}**:`,
    permBtnAllow: "✅ Allow",
    permBtnDeny: "❌ Deny",
    permBtnAllowTurn: "✅ Accept (this turn)",
    permBtnAllowSession: "✅ Accept (session)",
    permFooter: "Only the requester can click · auto-denied after 5 min",
    permResolvedAllow: "Allowed",
    permResolvedDeny: "Denied",
    permResolvedAllowTurn: "Accepted (turn)",
    permResolvedAllowSession: "Accepted (session)",
    permCancelled: (tool: string, reason: string) =>
      `🛑 Cancelled \`${tool}\` (${reason})`,
    permTimedOut: (tool: string) => `⏰ Timed out · \`${tool}\``,
    permWarnReminder: (tool: string, secondsLeft: number) =>
      `⏰ Permission request for ${tool} will auto-deny in ${secondsLeft}s`,

    // ── question-card.ts ─────────────────────────────────────────
    questionCardHeader: (count: number) =>
      count > 1 ? `🙋 Questions (${count})` : "🙋 Question",
    questionFooter:
      "Only the requester can click · auto-cancelled after 5 min",
    questionCancelled: (reason: string) => `🛑 Questions cancelled (${reason})`,
    questionTimedOut: "⏰ Questions timed out",
    questionWarnReminder: (secondsLeft: number) =>
      `⏰ Questions will auto-cancel in ${secondsLeft}s`,

    // ── cd-confirm-card.ts ───────────────────────────────────────
    cdCardHeader: "📁 Change Working Directory",
    cdCardPrompt: (path: string) => `Switch working directory to: \`${path}\``,
    cdBtnConfirm: "✅ Confirm",
    cdBtnCancel: "❌ Cancel",
    cdFooter: "Only the requester can click · auto-cancelled after 5 min",
    cdResolved: (path: string) => `📁 Working directory changed to \`${path}\``,
    cdCancelled: "🛑 Directory change cancelled",
    cdTimedOut: "⏰ Directory change timed out",

    // ── session.ts (context reset) ────────────────────────────────
    contextReset:
      "⚠️ Conversation context too large (exceeded 20MB limit). Automatically started a new session to retry your message. Previous conversation history has been cleared.",

    // ── session-manager.ts ───────────────────────────────────────
    crashRecovery:
      "⚠️ Bot restarted unexpectedly — session restored. Please check if the last turn completed successfully.",

    // ── dispatcher.ts ────────────────────────────────────────────
    unknownCommand: (raw: string) =>
      `Unknown command ${raw} — send /help to see available commands`,
    helpHeader: "Available commands:",
    helpSectionSession: "Session management",
    helpNew: "  /new          — Start a new session (clear context)",
    helpStatus: "  /status       — Show current session status",
    helpStop: "  /stop         — Interrupt current generation",
    helpSessions: "  /sessions     — List all known sessions",
    helpResume: "  /resume <id>  — Restore a previous session",
    helpSectionCwd: "Working directory",
    helpCd: "  /cd <path>    — Change working directory",
    helpProject: "  /project <alias> — Switch to a configured project",
    helpProjects: "  /projects       — List all configured projects",
    helpSectionMode: "Model & permissions",
    helpMode:
      "  /mode <mode>  — Set permission mode (default / acceptEdits / plan / bypassPermissions)",
    helpModel: "  /model <name> — Switch Claude model",
    helpSectionConfig: "Config & help",
    helpConfigShow: "  /config show  — Show current config",
    helpConfigSet: "  /config set <key> <value> — Change config at runtime",
    helpConfigSetPersist:
      "  /config set <key> <value> --persist — Change and write to file",
    helpHelp: "  /help         — Show this help",
    statusState: (v: string) => `State: ${v}`,
    statusCwd: (v: string) => `Working dir: ${v}`,
    statusPermMode: (v: string) => `Permission mode: ${v}`,
    statusModel: (v: string) => `Model: ${v}`,
    statusTurns: (v: number) => `Turns completed: ${v}`,
    statusInputTokens: (v: number) => `Total input tokens: ${v}`,
    statusOutputTokens: (v: number) => `Total output tokens: ${v}`,
    statusQueueLen: (v: number) => `Queue length: ${v}`,
    configShowHeader: "Current config:",
    configUnsupported: (key: string, valid: string) =>
      `Unknown config key: ${key}\nSettable keys: ${valid}`,
    configInvalidValue: (rawValue: string, key: string, reason: string) =>
      `Invalid value: ${rawValue} — ${key} expects ${reason}`,
    configPersistSkipped: "(persist skipped: configPath not set)",
    configPersisted: "(persisted)",
    configPersistFailed: (msg: string) =>
      `(failed to write config.toml: ${msg})`,
    configUpdated: (key: string, value: string, persistMsg: string) =>
      `Config updated: ${key} = ${value}${persistMsg ? " " + persistMsg : ""}`,
    configBoolExpected: "a boolean (true or false)",
    configPosIntExpected: "a positive integer",
    configNonEmptyStringExpected: "a non-empty string",
    configEnumExpected: (values: string) => `one of: ${values}`,
    sessionBusy:
      "A turn is in progress — send /stop or wait for it to finish",
    newSessionStarted: "New session started — next message begins a fresh conversation",
    modeSwitched: (mode: string) => `Permission mode set to ${mode}`,
    modelSwitched: (model: string) => `Model switched to ${model}`,
    cdNotDir: (path: string) => `Not a directory: ${path}`,
    cdNotFound: (path: string) => `Path not found: ${path}`,
    cdSendFailed: "Failed to send confirmation card",
    projectUnknown: (alias: string, list: string) =>
      `Unknown project alias: ${alias} — available: ${list}`,
    projectsNone: "No configured projects",
    projectsHeader: "📋 Projects",
    projectsCount: (n: number) => `${n} project${n === 1 ? "" : "s"}`,
    projectsActive: "📌 Current",
    projectsSessionActive: "🟢 Active session",
    projectsSessionStale: "⚪ Has history",
    projectsSessionNone: "— No session",
    projectsCwd: (cwd: string) => `Dir: \`${cwd}\``,
    sessionsNone: "No sessions found",
    sessionsHeader: "📋 Sessions",
    sessionsCount: (n: number) => `${n} session${n === 1 ? "" : "s"}`,
    sessionsProject: (alias: string) => `📁 ${alias}`,
    sessionsDefaultProject: "Default project",
    sessionsCwd: (cwd: string) => `Dir: \`${cwd}\``,
    sessionsModel: (model: string) => `Model: ${model}`,
    sessionsActive: "🟢 Active",
    sessionsStale: "⚪ Stale",
    sessionsLastActive: (timeAgo: string) => `Last active: ${timeAgo}`,
    resumeNotFound: (id: string) => `Session not found: ${id}`,
    resumeAlreadyHere: "Already in this session",
    resumeSuccess: (shortId: string, cwd: string) =>
      `Session \`${shortId}\` resumed, working dir: \`${cwd}\``,
  },
} as const;

/** Get the translation bundle for a given locale. */
export function t(locale: Locale): (typeof STRINGS)[Locale] {
  return STRINGS[locale];
}

export interface ResultTipStats {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export function formatResultTip(stats: ResultTipStats): string {
  const seconds = (stats.durationMs / 1000).toFixed(1);
  const input = formatTokenCount(stats.inputTokens);
  const output = formatTokenCount(stats.outputTokens);
  return `✅ 本轮耗时 ${seconds}s · 输入 ${input} / 输出 ${output} tokens`;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatErrorText(message: string): string {
  return `❌ 错误: ${message}`;
}

/**
 * Notice rendered when an incoming message lands in a non-empty
 * queue because the session is already running a turn. The hint
 * tells the user how to cancel without having to look up /help.
 *
 * Position is 1-indexed (the first queued message is #1, not #0).
 */
export function formatQueuedTip(position: number): string {
  if (position < 1 || !Number.isFinite(position)) {
    throw new Error(`formatQueuedTip: position must be >= 1, got ${position}`);
  }
  return `📥 已加入队列 #${position}（当前有一个轮次在运行，发 \`/stop\` 可取消）`;
}

/**
 * Acknowledgement sent after `/stop` successfully interrupted a turn
 * or was received while idle (both paths end up in the same state,
 * so the user gets the same confirmation either way).
 */
export function formatStopAck(): string {
  return "🛑 已停止";
}

/**
 * Sent as the final emit for any queued input that was dropped by a
 * `!` prefix or `/stop` before its turn ran. The user's original
 * message context is theirs — they know which message this was
 * replying to, so we don't repeat it.
 */
export function formatInterruptDropAck(): string {
  return "⚠️ 你之前的消息在被 Claude 处理前已被后续指令打断丢弃";
}

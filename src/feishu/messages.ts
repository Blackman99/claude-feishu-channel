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

import { t, type Locale } from "../util/i18n.js";

export interface ResultTipStats {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export function formatResultTip(
  stats: ResultTipStats,
  locale: Locale = "zh",
): string {
  const seconds = (stats.durationMs / 1000).toFixed(1);
  const input = formatTokenCount(stats.inputTokens);
  const output = formatTokenCount(stats.outputTokens);
  return t(locale).statsLine(seconds, input, output);
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatErrorText(message: string, locale: Locale = "zh"): string {
  return t(locale).errorLine(message);
}

/**
 * Notice rendered when an incoming message lands in a non-empty
 * queue because the session is already running a turn. The hint
 * tells the user how to cancel without having to look up /help.
 *
 * Position is 1-indexed (the first queued message is #1, not #0).
 */
export function formatQueuedTip(position: number, locale: Locale = "zh"): string {
  if (position < 1 || !Number.isFinite(position)) {
    throw new Error(`formatQueuedTip: position must be >= 1, got ${position}`);
  }
  return t(locale).queued(position);
}

/**
 * Acknowledgement sent after `/stop` successfully interrupted a turn
 * or was received while idle (both paths end up in the same state,
 * so the user gets the same confirmation either way).
 */
export function formatStopAck(locale: Locale = "zh"): string {
  return t(locale).stopped;
}

/**
 * Sent as the final emit for any queued input that was dropped by a
 * `!` prefix or `/stop` before its turn ran. The user's original
 * message context is theirs — they know which message this was
 * replying to, so we don't repeat it.
 */
export function formatInterruptDropAck(locale: Locale = "zh"): string {
  return t(locale).dropped;
}

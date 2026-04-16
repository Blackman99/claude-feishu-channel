/**
 * One renderable event emitted by ClaudeSession as it walks the SDK
 * message stream. The consumer (src/index.ts) dispatches each event to
 * the appropriate Feishu client method:
 *   text         → sendText
 *   thinking     → sendText (with 💭 prefix, gated by render.hideThinking)
 *   tool_use     → sendCard(buildToolUseCard)
 *   tool_result  → sendCard(buildToolResultCard)
 *   turn_end     → sendText (turn stats, gated by render.showTurnStats)
 *
 * Turn-level errors are NOT emitted — handleMessage throws instead, and
 * the consumer catches & sends an error text message.
 */
export type RenderEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "turn_end"; durationMs: number; inputTokens: number; outputTokens: number }
  // Phase 4: out-of-band notices
  | { type: "queued"; position: number }
  | { type: "interrupted"; reason: "stop" | "bang_prefix" }
  // Phase 4: dedicated stop ack. Distinct from `text` so the dispatcher
  // renders it as a plain one-liner rather than routing it through the
  // answer-card / "✅ 完成" status path — stopping is not completing.
  | { type: "stop_ack" }
  // Emitted when a "Request too large" error triggers an automatic
  // session reset + retry. The consumer should notify the user that
  // prior context was dropped and the message is being retried.
  | { type: "context_warning"; level: "warn" }
  | { type: "context_compacting" }
  | { type: "context_summarized_reset" }
  | { type: "context_reset" };

/**
 * Result of parsing one inbound chat message.
 *
 * - `run`: deliver `text` to the current Claude session as a new turn
 *   or as a queue entry, depending on session state.
 * - `stop`: interrupt the current turn (if any) and drop the queue.
 *   Does not deliver any text.
 * - `interrupt_and_run`: interrupt the current turn, drop the queue,
 *   THEN deliver `text` as the next turn. The `!` prefix form.
 *
 * Phase 6 will extend this union with `{ kind: "new" }`, `{ kind:
 * "cd", path }`, etc. — keep the discriminated-union shape so new
 * kinds are exhaustiveness-checked at every call site.
 */
export type CommandRouterResult =
  | { kind: "run"; text: string }
  | { kind: "stop" }
  | { kind: "interrupt_and_run"; text: string };

/**
 * Parse raw inbound text into a `CommandRouterResult`. Pure function —
 * no I/O, no state.
 *
 * Recognition rules:
 * - `/stop` (case-insensitive, trailing whitespace allowed, NO other
 *   trailing content) → `{ kind: "stop" }`
 * - `!<payload>` or `! <payload>` where `<payload>` is non-empty after
 *   trimming the leading `!` and one optional space → `{ kind:
 *   "interrupt_and_run", text: <payload> }`
 * - everything else → `{ kind: "run", text: <raw text unchanged> }`
 *
 * Whitespace-only and empty strings fall through to `run`; the
 * session decides whether to ignore them. This way the parser stays
 * dumb and only makes decisions based on syntactic prefixes.
 */
export function parseInput(text: string): CommandRouterResult {
  // /stop (case-insensitive, optional trailing whitespace, nothing else)
  if (/^\/stop\s*$/i.test(text)) {
    return { kind: "stop" };
  }

  // ! prefix interrupt. The payload is the substring after the first
  // `!`, with at most one leading space consumed. An empty payload
  // (bare "!" or "!   ") falls through to a plain run so the user
  // isn't accidentally interrupting with nothing to say.
  if (text.startsWith("!")) {
    let payload = text.slice(1);
    if (payload.startsWith(" ")) payload = payload.slice(1);
    if (payload.length > 0 && payload.trim().length > 0) {
      return { kind: "interrupt_and_run", text: payload };
    }
    // Empty payload → fall through
  }

  return { kind: "run", text };
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type ParsedCommand =
  | { name: "provider"; provider: "claude" | "codex" }
  | { name: "new" }
  | { name: "cost" }
  | { name: "context" }
  | { name: "compact" }
  | { name: "cd"; path: string }
  | { name: "memory_show" }
  | { name: "memory_add"; text: string }
  | { name: "project"; alias: string }
  | { name: "mode"; mode: PermissionMode }
  | { name: "model"; model: string }
  | { name: "status" }
  | { name: "help" }
  | { name: "config_show" }
  | { name: "config_set"; key: string; value: string; persist: boolean }
  | { name: "sessions" }
  | { name: "projects" }
  | { name: "resume"; target: string };

/**
 * Result of parsing one inbound chat message.
 *
 * - `run`: deliver `text` to the current Claude session as a new turn
 *   or as a queue entry, depending on session state.
 * - `stop`: interrupt the current turn (if any) and drop the queue.
 *   Does not deliver any text.
 * - `interrupt_and_run`: interrupt the current turn, drop the queue,
 *   THEN deliver `text` as the next turn. The `!` prefix form.
 * - `command`: a recognized slash-command with structured payload.
 * - `unknown_command`: slash followed by a known command word but with
 *   invalid or missing arguments; surface an error to the user.
 *
 * Keep the discriminated-union shape so new kinds are
 * exhaustiveness-checked at every call site.
 */
export type CommandRouterResult =
  | { kind: "run"; text: string }
  | { kind: "stop" }
  | { kind: "interrupt_and_run"; text: string }
  | { kind: "command"; cmd: ParsedCommand }
  | { kind: "unknown_command"; raw: string };

const VALID_MODES = new Set<string>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

/** Command words that the parser recognizes after a leading `/`. */
const KNOWN_COMMANDS = new Set([
  "new",
  "cost",
  "context",
  "compact",
  "cd",
  "memory",
  "project",
  "provider",
  "mode",
  "model",
  "status",
  "help",
  "config",
  "stop",
  "sessions",
  "projects",
  "resume",
]);

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
 * - `/word` where `word` is a known command → parsed command or
 *   `unknown_command` if arguments are invalid/missing
 * - `/word` where `word` is NOT a known command word → `{ kind: "run" }`
 *   so messages like `/etc/hosts` reach Claude unmodified
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

  // Slash-command detection: /word at the start
  const slashMatch = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/i);
  if (slashMatch) {
    const word = slashMatch[1]!.toLowerCase();
    const rest = slashMatch[2]?.trim() ?? "";

    if (!KNOWN_COMMANDS.has(word)) {
      // Not a known command word — treat as unknown_command so the
      // user gets an error message. Paths like "/etc/hosts" don't
      // reach here because the regex requires `/word` with no
      // embedded slashes; those fall through to `run` below.
      return { kind: "unknown_command", raw: text };
    }

    // /stop with trailing text already fell through above (the bare
    // /stop case was handled before the ! block). Any /stop that
    // reaches here has trailing text, so treat as run.
    if (word === "stop") {
      return { kind: "run", text };
    }

    const cmd = parseCommand(word, rest, text);
    if (cmd) return { kind: "command", cmd };
    return { kind: "unknown_command", raw: text };
  }

  return { kind: "run", text };
}

function parseCommand(
  word: string,
  rest: string,
  _raw: string,
): ParsedCommand | null {
  switch (word) {
    case "new":
      return { name: "new" };
    case "cost":
      return { name: "cost" };
    case "context":
      return { name: "context" };
    case "compact":
      return { name: "compact" };
    case "cd":
      return rest ? { name: "cd", path: rest } : null;
    case "memory":
      if (!rest) return { name: "memory_show" };
      if (rest.startsWith("add ")) {
        const text = rest.slice(4).trim();
        return text ? { name: "memory_add", text } : null;
      }
      return null;
    case "project":
      return rest ? { name: "project", alias: rest } : null;
    case "provider":
      if (rest === "claude" || rest === "codex") {
        return { name: "provider", provider: rest };
      }
      return null;
    case "mode":
      if (VALID_MODES.has(rest)) {
        return { name: "mode", mode: rest as PermissionMode };
      }
      return null;
    case "model":
      return rest ? { name: "model", model: rest } : null;
    case "status":
      return { name: "status" };
    case "help":
      return { name: "help" };
    case "config":
      if (rest === "show") return { name: "config_show" };
      if (rest.startsWith("set ")) {
        const afterSet = rest.slice(4).trim();
        if (!afterSet) return null;
        const persist = afterSet.endsWith(" --persist");
        const core = persist ? afterSet.slice(0, -" --persist".length).trim() : afterSet;
        const spaceIdx = core.indexOf(" ");
        if (spaceIdx < 0) return null;
        const key = core.slice(0, spaceIdx);
        const value = core.slice(spaceIdx + 1).trim();
        if (!key || !value) return null;
        return { name: "config_set", key, value, persist };
      }
      return null;
    case "sessions":
      return { name: "sessions" };
    case "projects":
      return { name: "projects" };
    case "resume":
      return rest ? { name: "resume", target: rest } : null;
    default:
      return null;
  }
}

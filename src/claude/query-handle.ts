import type { AppConfig } from "../types.js";
import type { SDKMessageLike } from "./session.js";

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  permissionMode: AppConfig["claude"]["defaultPermissionMode"];
  settingSources: readonly ("project" | "user" | "local")[];
}

/**
 * Per-turn permission callback the session hands to the transport. The
 * SDK invokes this on every `tool_use` event that Claude emits while
 * the turn is running. Contract: MUST NOT reject under normal
 * operation — timeouts, cancellations, and user denials all return
 * `{behavior: "deny", message}`. Rejections are treated as programming
 * bugs and will abort the turn.
 *
 * Return type is intentionally narrower than the broker's internal
 * `PermissionResponse`: the SDK only understands `allow` / `deny`, so
 * the session's closure translates broker-level `allow_turn` /
 * `allow_session` responses into `{allow}` plus side effects
 * (`handle.setPermissionMode` and/or sticky flag) before returning.
 */
export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseID: string },
) => Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

/**
 * Handle exposed by a `QueryFn` for one turn. Consumers iterate
 * `.messages` to receive the stream-json events and can call
 * `.interrupt()` at any point to terminate the turn early (used by
 * `ClaudeSession` for `/stop` and `!` prefix).
 *
 * `interrupt()` MUST be idempotent — the state machine may call it
 * during the narrow window between a result message arriving and the
 * iterator ending naturally, and we don't want the second call to
 * throw or spawn a second signal.
 *
 * `interrupt()` resolves only after the turn has fully settled (child
 * exited / iterator ended), so the state machine can safely assume
 * that once the returned Promise resolves, no more messages will be
 * emitted for this turn.
 *
 * `setPermissionMode()` mirrors the SDK's `query.setPermissionMode`
 * and changes the default permission policy for the REMAINING tool
 * calls in this turn. Used to implement the "本轮 acceptEdits" button:
 * the session flips the mode mid-turn so subsequent Edit/Write tool
 * uses are auto-allowed without re-prompting. Idempotent; calling
 * with the current mode is a no-op.
 */
export interface QueryHandle {
  readonly messages: AsyncIterable<SDKMessageLike>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: ClaudeQueryOptions["permissionMode"]): void;
}

/**
 * Structural signature of the function that creates a per-turn
 * `QueryHandle`. The `canUseTool` callback is a parameter (not a
 * method on the handle) because the session constructs a fresh
 * closure per turn that captures the owning message's `senderOpenId`
 * / `parentMessageId`, and hands it in when it opens the turn.
 */
export type QueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
  canUseTool: CanUseToolFn;
}) => QueryHandle;

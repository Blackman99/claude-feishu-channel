import type { AppConfig } from "../types.js";
import type { SDKMessageLike } from "./session.js";

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  permissionMode: AppConfig["claude"]["defaultPermissionMode"];
  settingSources: readonly ("project" | "user" | "local")[];
}

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
 */
export interface QueryHandle {
  readonly messages: AsyncIterable<SDKMessageLike>;
  interrupt(): Promise<void>;
}

/**
 * Structural signature of the function that creates a per-turn
 * `QueryHandle`. `src/claude/cli-query.ts` implements this for the
 * real CLI subprocess; tests inject `FakeQueryHandle` via this same
 * type.
 */
export type QueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
}) => QueryHandle;

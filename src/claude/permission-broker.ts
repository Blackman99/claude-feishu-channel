/**
 * A pending permission check — Phase 5 will construct one of these
 * from the SDK's `canUseTool` callback parameters.
 */
export interface PermissionRequest {
  /** Name of the tool Claude wants to call, e.g. "Bash", "Edit". */
  toolName: string;
  /** Raw tool input (the session does NOT validate the shape). */
  input: unknown;
  /** Feishu chat that owns this request (for card routing). */
  chatId: string;
}

/**
 * The response the broker returns to Claude. "allow" lets the tool
 * run (optionally with a modified input); "deny" aborts with a user-
 * visible message that Claude will see as the tool_result.
 */
export type PermissionResponse =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

/**
 * Bridges between the SDK's `canUseTool` callback and the Feishu
 * permission card UX. Phase 5 will ship the real implementation that
 * creates a `Deferred<PermissionResponse>`, sends a permission card,
 * and resolves the deferred on button click / timeout.
 *
 * Phase 4 only declares the interface + a stub that throws. The
 * `ClaudeSession` constructor takes a `PermissionBroker` so the
 * Phase 5 wiring is a drop-in replacement with no session-side churn.
 */
export interface PermissionBroker {
  /**
   * Request permission for a tool call. Resolves with the user's
   * decision. The returned promise MUST NOT reject under normal
   * operation — timeouts resolve with `deny`, cancellations resolve
   * with `deny`. Only programming bugs should reject.
   */
  request(req: PermissionRequest): Promise<PermissionResponse>;
}

/**
 * Placeholder broker that throws on use. Phase 4 production wiring
 * injects this — if anything actually calls it, that's a bug (the
 * CLI transport doesn't surface canUseTool yet, and the Phase 4 test
 * seam bypasses the broker entirely via `_testEnterAwaitingPermission`).
 */
export class NullPermissionBroker implements PermissionBroker {
  async request(_req: PermissionRequest): Promise<PermissionResponse> {
    throw new Error(
      "NullPermissionBroker.request called — permission bridge not wired yet (Phase 5)",
    );
  }
}

/**
 * A pending permission check — the session constructs one of these in
 * its `canUseTool` closure and hands it to `broker.request`.
 */
export interface PermissionRequest {
  /** Name of the tool Claude wants to call, e.g. "Bash", "Edit". */
  toolName: string;
  /** Raw tool input (the session does NOT validate the shape). */
  input: unknown;
  /** Feishu chat that owns this request (for card routing). */
  chatId: string;
  /**
   * Open id of the user who sent the message that kicked off this
   * turn. Only this user may click the permission buttons — everyone
   * else in the group gets a `forbidden` response.
   */
  ownerOpenId: string;
  /**
   * Feishu `message_id` of the user message that kicked off this
   * turn. The broker posts the permission card as a reply to it so
   * the card threads under the exact request that caused it.
   */
  parentMessageId: string;
}

/**
 * Broker-internal response. The session's `canUseTool` closure
 * receives this and translates the last two variants to `{allow}` +
 * side effects before returning to the SDK (which only understands
 * `allow`/`deny`).
 */
export type PermissionResponse =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }
  | { behavior: "allow_turn" }
  | { behavior: "allow_session" };

/** Choice value encoded on each permission card button. */
export type CardChoice = "allow" | "deny" | "allow_turn" | "allow_session";

/** Result of routing a `card.action.trigger` event to the broker. */
export type CardActionResult =
  | { kind: "resolved" }
  | { kind: "not_found" }
  | { kind: "forbidden"; ownerOpenId: string };

/**
 * Bridges between the SDK's `canUseTool` callback and the Feishu
 * permission card UX. Phase 5 ships `FeishuPermissionBroker` as the
 * real implementation; tests use `FakePermissionBroker`.
 */
export interface PermissionBroker {
  /**
   * Request permission for a tool call. Resolves with the user's
   * decision. The returned promise MUST NOT reject under normal
   * operation — timeouts resolve with `deny`, cancellations resolve
   * with `deny`. Only programming bugs should reject.
   */
  request(req: PermissionRequest): Promise<PermissionResponse>;

  /**
   * Handle a card button click. Called by the gateway after
   * access-control passes on the `card.action.trigger` event.
   * Returns a result the gateway uses to decide whether to log or
   * surface anything back to the user.
   */
  resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult>;

  /**
   * Bulk-deny all pending requests with the given reason. Called by
   * `session.stop()` / `!` prefix so interrupting the turn also
   * unblocks any outstanding `canUseTool` calls. The reason becomes
   * the deny `message` that Claude sees as the tool_result.
   */
  cancelAll(reason: string): void;
}

/**
 * Transitional stub used only by `src/index.ts` until Task 15 wires
 * the real `FeishuPermissionBroker`. Throws on every method so an
 * accidental call during this window is loud. Delete once the real
 * broker is wired.
 */
export class TransitionalStubBroker implements PermissionBroker {
  async request(_req: PermissionRequest): Promise<PermissionResponse> {
    throw new Error(
      "TransitionalStubBroker.request called — real broker not wired yet (Task 15)",
    );
  }
  async resolveByCard(_args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult> {
    throw new Error(
      "TransitionalStubBroker.resolveByCard called — real broker not wired yet (Task 15)",
    );
  }
  cancelAll(_reason: string): void {
    // no-op during transition — stop/! still works because session.pendingPermission carries the cancel path until Task 13.
  }
}

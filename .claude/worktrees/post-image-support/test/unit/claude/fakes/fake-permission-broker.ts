import type {
  CardActionResult,
  CardChoice,
  PermissionBroker,
  PermissionRequest,
  PermissionResponse,
} from "../../../../src/claude/permission-broker.js";

/**
 * In-memory PermissionBroker for session-state tests. Captures all
 * `request` calls and gives tests a `fakeResolve` handle to advance
 * them. `cancelAll` records the reason and resolves any outstanding
 * pending promise with a deny.
 */
export class FakePermissionBroker implements PermissionBroker {
  readonly requests: PermissionRequest[] = [];
  readonly cancelCalls: string[] = [];
  readonly resolveByCardCalls: Array<{
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }> = [];
  private pending: Array<(r: PermissionResponse) => void> = [];

  async request(req: PermissionRequest): Promise<PermissionResponse> {
    this.requests.push(req);
    return new Promise<PermissionResponse>((resolve) => {
      this.pending.push(resolve);
    });
  }

  /**
   * Test helper — resolves the OLDEST pending request with the given
   * response. Throws if nothing is pending so tests fail loudly on
   * bad ordering.
   */
  fakeResolve(response: PermissionResponse): void {
    const resolver = this.pending.shift();
    if (!resolver) {
      throw new Error("FakePermissionBroker: no pending request to resolve");
    }
    resolver(response);
  }

  async resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult> {
    this.resolveByCardCalls.push(args);
    return { kind: "not_found" };
  }

  cancelAll(reason: string): void {
    this.cancelCalls.push(reason);
    const resolvers = this.pending;
    this.pending = [];
    for (const r of resolvers) {
      r({ behavior: "deny", message: reason });
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }
}

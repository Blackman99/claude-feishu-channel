import type {
  QuestionBroker,
  QuestionCardActionResult,
  QuestionCardChoice,
  QuestionRequest,
  QuestionResponse,
} from "../../../../src/claude/question-broker.js";

/**
 * In-memory QuestionBroker for session-state and MCP-handler tests.
 * Captures all `request` calls and gives tests a `fakeResolve`
 * handle to advance them. `cancelAll` records the reason and
 * resolves any outstanding pending promise with a `cancelled`
 * response.
 */
export class FakeQuestionBroker implements QuestionBroker {
  readonly requests: QuestionRequest[] = [];
  readonly cancelCalls: string[] = [];
  readonly timingUpdates: Array<{ timeoutMs: number; warnBeforeMs: number }> = [];
  readonly resolveByCardCalls: Array<{
    requestId: string;
    senderOpenId: string;
    choice: QuestionCardChoice;
  }> = [];
  private pending: Array<(r: QuestionResponse) => void> = [];

  async request(req: QuestionRequest): Promise<QuestionResponse> {
    this.requests.push(req);
    return new Promise<QuestionResponse>((resolve) => {
      this.pending.push(resolve);
    });
  }

  /**
   * Test helper — resolves the OLDEST pending request with the given
   * response. Throws if nothing is pending so tests fail loudly on
   * bad ordering.
   */
  fakeResolve(response: QuestionResponse): void {
    const resolver = this.pending.shift();
    if (!resolver) {
      throw new Error("FakeQuestionBroker: no pending request to resolve");
    }
    resolver(response);
  }

  async resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: QuestionCardChoice;
  }): Promise<QuestionCardActionResult> {
    this.resolveByCardCalls.push(args);
    return { kind: "not_found" };
  }

  cancelAll(reason: string): void {
    this.cancelCalls.push(reason);
    const resolvers = this.pending;
    this.pending = [];
    for (const r of resolvers) {
      r({ kind: "cancelled", reason });
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }

  updateTiming(config: { timeoutMs: number; warnBeforeMs: number }): void {
    this.timingUpdates.push(config);
  }
}

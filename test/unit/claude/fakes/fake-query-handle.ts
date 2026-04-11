import { createDeferred, type Deferred } from "../../../../src/util/deferred.js";
import type { SDKMessageLike } from "../../../../src/claude/session.js";
import type { QueryHandle } from "../../../../src/claude/query-handle.js";

type PendingValue = { kind: "msg"; msg: SDKMessageLike } | { kind: "end" };

/**
 * Scriptable `QueryHandle` implementation for state-machine tests.
 *
 * Usage pattern (from a test):
 *   const fake = new FakeQueryHandle();
 *   session.submit(...); // kicks off a turn that consumes fake.messages
 *   fake.emitMessage({ type: "system", subtype: "init" });
 *   fake.emitMessage({ type: "assistant", ... });
 *   fake.finishWithSuccess({ ... });
 *
 * The internal channel is a FIFO of Deferreds — each `emitMessage`
 * resolves the next pending pull (or enqueues a value if nothing is
 * pulling yet). `finishWith*` / `interrupt()` all push a terminal
 * sentinel that ends the async iterator the next time the consumer
 * pulls.
 *
 * Observation points for assertions:
 * - `interrupted`: true iff `interrupt()` has been called
 * - `lastFinishReason`: the most recent end cause ("success" / "error" /
 *   "interrupted" / null if still running)
 * - `messagesConsumed`: how many values the iterator has yielded
 */
export class FakeQueryHandle implements QueryHandle {
  interrupted = false;
  lastFinishReason: "success" | "error" | "interrupted" | null = null;
  messagesConsumed = 0;
  /** Recorded permissionMode changes from the session under test. */
  readonly permissionModeChanges: string[] = [];

  private readonly queue: PendingValue[] = [];
  private readonly waiters: Deferred<PendingValue>[] = [];
  private ended = false;

  readonly messages: AsyncIterable<SDKMessageLike> = {
    [Symbol.asyncIterator]: () => this.makeIterator(),
  };

  emitMessage(msg: SDKMessageLike): void {
    if (this.ended) {
      throw new Error("FakeQueryHandle: cannot emitMessage after end");
    }
    this.push({ kind: "msg", msg });
  }

  /** Finalize with an SDKResultSuccess-shaped message. */
  finishWithSuccess(opts: {
    result?: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
  }): void {
    if (this.ended) return;
    const msg: SDKMessageLike = {
      type: "result",
      subtype: "success",
      duration_ms: opts.durationMs,
      usage: {
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
      },
    };
    if (opts.result !== undefined) msg.result = opts.result;
    this.push({ kind: "msg", msg });
    this.lastFinishReason = "success";
    this.pushEnd();
  }

  /** Finalize with an error-variant result message. */
  finishWithError(opts: {
    subtype: "error_during_execution" | "error_max_turns";
    errors: readonly string[];
    durationMs?: number;
  }): void {
    if (this.ended) return;
    this.push({
      kind: "msg",
      msg: {
        type: "result",
        subtype: opts.subtype,
        errors: opts.errors,
        duration_ms: opts.durationMs ?? 0,
      },
    });
    this.lastFinishReason = "error";
    this.pushEnd();
  }

  async interrupt(): Promise<void> {
    if (this.interrupted) return;
    this.interrupted = true;
    if (!this.ended) {
      this.lastFinishReason = "interrupted";
      this.pushEnd();
    }
  }

  setPermissionMode(mode: string): void {
    this.permissionModeChanges.push(mode);
  }

  // --- internals ---

  private push(value: PendingValue): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.queue.push(value);
    }
  }

  private pushEnd(): void {
    if (this.ended) return;
    this.ended = true;
    this.push({ kind: "end" });
  }

  private async pull(): Promise<PendingValue> {
    const head = this.queue.shift();
    if (head) return head;
    const waiter = createDeferred<PendingValue>();
    this.waiters.push(waiter);
    return waiter.promise;
  }

  private makeIterator(): AsyncIterator<SDKMessageLike> {
    return {
      next: async (): Promise<IteratorResult<SDKMessageLike>> => {
        const value = await this.pull();
        if (value.kind === "end") {
          return { value: undefined, done: true };
        }
        this.messagesConsumed += 1;
        return { value: value.msg, done: false };
      },
    };
  }
}

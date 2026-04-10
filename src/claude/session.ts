import type { Logger } from "pino";
import { Mutex } from "../util/mutex.js";
import { createDeferred, type Deferred } from "../util/deferred.js";
import type { Clock } from "../util/clock.js";
import type { AppConfig } from "../types.js";
import type { RenderEvent } from "./render-event.js";
import type { QueryFn, QueryHandle } from "./query-handle.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { CommandRouterResult } from "../commands/router.js";
import {
  extractToolResultText,
  type ToolResultBlock,
} from "../feishu/tool-result.js";
import { formatStopAck } from "../feishu/messages.js";

/**
 * Error rejected on a QueuedInput's `done` promise when its turn was
 * dropped before it ran (either by `/stop` or by a `!` prefix). The
 * `reason` field matches the RenderEvent `interrupted` variant so
 * dispatchers can render both consistently.
 */
export class InterruptedError extends Error {
  constructor(public readonly reason: "stop" | "bang_prefix") {
    super(`turn interrupted: ${reason}`);
    this.name = "InterruptedError";
  }
}

/**
 * Shallow structural subset of the Claude Code stream-json message
 * union. Narrowed to only the fields the session reads when
 * dispatching RenderEvents, so any transport — in-process SDK or CLI
 * subprocess — can yield these.
 */
export interface SDKMessageLike {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: readonly SDKContentBlock[] };
  result?: string;
  errors?: readonly string[];
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface SDKContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | readonly ToolResultBlock[];
}

export type {
  QueryFn,
  QueryHandle,
  ClaudeQueryOptions,
} from "./query-handle.js";

export type EmitFn = (event: RenderEvent) => Promise<void>;
/** Retained for Phase 3 import compatibility. */
export type RenderEventEmitter = EmitFn;

export type SessionState = "idle" | "generating" | "awaiting_permission";

export interface ClaudeSessionOptions {
  chatId: string;
  config: AppConfig["claude"];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  logger: Logger;
}

/**
 * Result of `session.submit(input, emit)`. The caller (dispatcher)
 * uses the shape to decide what to send back to the user immediately,
 * and awaits `done` for per-input backpressure and error propagation.
 */
export type SubmitOutcome =
  | { kind: "started"; done: Promise<void> }
  | { kind: "queued"; position: number; done: Promise<void> }
  | { kind: "rejected"; reason: string };

/**
 * Per-queue-entry state. Each submitted input owns one of these
 * until its turn runs to completion (or is dropped by `!` / `/stop`).
 */
interface QueuedInput {
  readonly text: string;
  readonly emit: EmitFn;
  readonly done: Deferred<void>;
  /** Monotonic id for logging — not exposed to the outside. */
  readonly seq: number;
}

/**
 * Phase 4 ClaudeSession — explicit state machine with an input queue
 * and a processLoop that drains one turn at a time. The mutex here
 * only guards mutations to the state/queue fields; the turn itself
 * runs outside the mutex so `submit()` and `stop()` stay responsive
 * while a turn is in-flight.
 */
export class ClaudeSession {
  private readonly config: AppConfig["claude"];
  private readonly queryFn: QueryFn;
  // `clock` and `permissionBroker` are dependencies Phase 5 will use
  // (timers + canUseTool). Phase 4 only keeps them in the constructor
  // signature so Phase 5 is a drop-in addition without another
  // constructor churn.
  private readonly clock: Clock;
  private readonly permissionBroker: PermissionBroker;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();

  private state: SessionState = "idle";
  private readonly inputQueue: QueuedInput[] = [];
  private currentTurn: {
    input: QueuedInput;
    handle: QueryHandle;
  } | null = null;
  private nextSeq = 1;
  /**
   * Has a `processLoop` invocation been scheduled but not yet
   * finished? Used to avoid double-scheduling when multiple `submit`s
   * race to kick off a drain.
   */
  private loopRunning = false;

  constructor(opts: ClaudeSessionOptions) {
    this.config = opts.config;
    this.queryFn = opts.queryFn;
    this.clock = opts.clock;
    this.permissionBroker = opts.permissionBroker;
    this.logger = opts.logger.child({ chat_id: opts.chatId });
    // Touch the unused-for-now deps so the compiler doesn't warn.
    void this.clock;
    void this.permissionBroker;
  }

  /**
   * Submit a parsed command to the session. Phase 4 Task 6 wires
   * `run` only; `stop` and `interrupt_and_run` arrive in Tasks 8/9.
   */
  async submit(
    input: CommandRouterResult,
    emit: EmitFn,
  ): Promise<SubmitOutcome> {
    if (input.kind === "stop") {
      throw new Error("submit({kind:'stop'}) not implemented yet (Task 8)");
    }
    if (input.kind === "interrupt_and_run") {
      throw new Error(
        "submit({kind:'interrupt_and_run'}) not implemented yet (Task 9)",
      );
    }

    const entry: QueuedInput = {
      text: input.text,
      emit,
      done: createDeferred<void>(),
      seq: this.nextSeq++,
    };

    const outcome = await this.mutex.run(
      async (): Promise<SubmitOutcome> => {
        this.inputQueue.push(entry);
        const wasIdle = this.state === "idle";
        if (wasIdle) {
          this.state = "generating";
        }
        if (!this.loopRunning) {
          this.loopRunning = true;
          // Start the loop on a microtask so it runs after submit
          // releases the mutex. Fire-and-forget — the loop catches
          // its own errors.
          queueMicrotask(() => {
            void (async () => {
              try {
                await this.processLoop();
              } catch (err) {
                this.logger.error(
                  { err },
                  "processLoop crashed — state machine may be inconsistent",
                );
              }
            })();
          });
        }
        if (wasIdle) {
          return { kind: "started", done: entry.done.promise };
        }
        // State is "generating" or "awaiting_permission". The
        // currently running turn lives in `currentTurn`, not in
        // `inputQueue`, so after pushing, `inputQueue.length` is the
        // 1-indexed position of this new input.
        return {
          kind: "queued",
          position: this.inputQueue.length,
          done: entry.done.promise,
        };
      },
    );

    // Fire the out-of-band "queued" notice after releasing the lock.
    // Doing this OUTSIDE the lock keeps the mutex fast, and since
    // `emit` is per-input there's no concurrency with other emits.
    if (outcome.kind === "queued") {
      try {
        await emit({ type: "queued", position: outcome.position });
      } catch (err) {
        this.logger.warn(
          { err, seq: entry.seq },
          "emit({type:'queued'}) threw — continuing",
        );
      }
    }
    return outcome;
  }

  /**
   * Cancel any in-flight turn and drop every queued input. Safe to
   * call in any state — in `idle` it's a no-op that just emits the
   * stop ack. Returns once the queue has been drained and the
   * interrupt has been dispatched; the currently running turn may
   * still take a beat to finish unwinding its iterator.
   */
  async stop(emit: EmitFn): Promise<void> {
    // Gather the interrupt target + drain the queue under the lock.
    // We don't await the interrupt INSIDE the lock so other submits
    // aren't blocked on the child's exit.
    const toDrop: QueuedInput[] = [];
    let toInterrupt: QueryHandle | null = null;

    await this.mutex.run(async () => {
      if (this.state === "idle") {
        // Nothing to stop. Ack and return.
        return;
      }
      toInterrupt = this.currentTurn?.handle ?? null;
      while (this.inputQueue.length > 0) {
        toDrop.push(this.inputQueue.shift()!);
      }
      // The currentTurn's Deferred is NOT rejected here — it will
      // reject naturally when runTurn observes the interrupted iterator.
    });

    // 1. Notify each dropped input via its own emit, then reject its done.
    for (const dropped of toDrop) {
      try {
        await dropped.emit({ type: "interrupted", reason: "stop" });
      } catch (err) {
        this.logger.warn(
          { err, seq: dropped.seq },
          "emit interrupted event threw — continuing to reject done",
        );
      }
      dropped.done.reject(new InterruptedError("stop"));
    }

    // 2. Ask the in-flight turn to terminate.
    if (toInterrupt !== null) {
      try {
        await (toInterrupt as QueryHandle).interrupt();
      } catch (err) {
        this.logger.warn({ err }, "currentTurn.interrupt() threw");
      }
    }

    // 3. Ack the caller.
    try {
      await emit({ type: "text", text: formatStopAck() });
    } catch (err) {
      this.logger.warn({ err }, "stop ack emit threw");
    }
  }

  // --- internals ---

  private async processLoop(): Promise<void> {
    while (true) {
      // Decide whether to keep looping and grab the next input
      // atomically. If the queue is empty, flip to idle and clear
      // `loopRunning` in the same mutex critical section as submit's
      // enqueue path — this guarantees submit will always either see
      // `loopRunning=true` (and rely on this loop to pick it up) or
      // `loopRunning=false` AND `state=idle` (and start a new loop).
      const next = await this.mutex.run(async () => {
        const head = this.inputQueue.shift();
        if (!head) {
          this.state = "idle";
          this.currentTurn = null;
          this.loopRunning = false;
          return null;
        }
        return head;
      });
      if (next === null) return;

      const handle = this.queryFn({
        prompt: next.text,
        options: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode: this.config.defaultPermissionMode,
          settingSources: ["project"],
        },
      });
      this.currentTurn = { input: next, handle };

      let turnError: unknown = null;
      try {
        await this.runTurn(next, handle);
      } catch (err) {
        this.logger.error({ err, seq: next.seq }, "Claude turn failed");
        turnError = err;
      }

      // Flip to idle BEFORE resolving/rejecting the caller's Deferred
      // if the queue is empty. Otherwise observers awaiting `done`
      // would see a stale "generating" state in the window between
      // resolve and the next loop iteration.
      await this.mutex.run(async () => {
        this.currentTurn = null;
        if (this.inputQueue.length === 0) {
          this.state = "idle";
        }
      });

      if (turnError === null) {
        next.done.resolve();
      } else {
        next.done.reject(turnError);
      }
    }
  }

  private async runTurn(
    input: QueuedInput,
    handle: QueryHandle,
  ): Promise<void> {
    this.logger.info(
      { len: input.text.length, seq: input.seq },
      "Claude turn start",
    );
    let resultMsg: SDKMessageLike | undefined;

    for await (const msg of handle.messages) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          await this.emitAssistantBlock(block, input.emit);
        }
      } else if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            await input.emit({
              type: "tool_result",
              toolUseId: block.tool_use_id ?? "",
              isError: block.is_error === true,
              text: extractToolResultText(block.content),
            });
          }
        }
      } else if (msg.type === "result") {
        resultMsg = msg;
      }
    }

    if (resultMsg === undefined) {
      throw new Error("Claude turn ended without a result message");
    }
    if (resultMsg.subtype !== "success") {
      const errs = resultMsg.errors?.join("; ") ?? "unknown error";
      this.logger.error(
        {
          subtype: resultMsg.subtype,
          errors: resultMsg.errors,
          seq: input.seq,
        },
        "Claude turn errored",
      );
      throw new Error(`Claude turn failed (${resultMsg.subtype}): ${errs}`);
    }

    await input.emit({
      type: "turn_end",
      durationMs: resultMsg.duration_ms ?? 0,
      inputTokens: resultMsg.usage?.input_tokens ?? 0,
      outputTokens: resultMsg.usage?.output_tokens ?? 0,
    });
    this.logger.info(
      { durationMs: resultMsg.duration_ms, seq: input.seq },
      "Claude turn complete",
    );
  }

  private async emitAssistantBlock(
    block: SDKContentBlock,
    emit: EmitFn,
  ): Promise<void> {
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.length > 0
    ) {
      await emit({ type: "text", text: block.text });
      return;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      await emit({ type: "thinking", text: block.thinking });
      return;
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      await emit({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
      return;
    }
  }

  // --- test seams ---

  /** @internal */
  _testGetState(): SessionState {
    return this.state;
  }

  /** @internal */
  _testGetQueueLength(): number {
    return this.inputQueue.length;
  }
}

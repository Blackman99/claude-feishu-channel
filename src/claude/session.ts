import type { Logger } from "pino";
import { Mutex } from "../util/mutex.js";
import { createDeferred, type Deferred } from "../util/deferred.js";
import type { Clock } from "../util/clock.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider, AppConfig, McpServerConfig } from "../types.js";
import type { RenderEvent } from "./render-event.js";
import type { CanUseToolFn, QueryFn, QueryHandle } from "./query-handle.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { QuestionBroker } from "./question-broker.js";
import { createAskUserMcpServer } from "./ask-user-mcp.js";
import type { CommandRouterResult } from "../commands/router.js";
import {
  extractToolResultText,
  type ToolResultBlock,
} from "../feishu/tool-result.js";

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
  session_id?: string;
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

type ContextRiskLevel = "normal" | "warn" | "compact" | "summarize_reset";

interface ContextAssessment {
  level: ContextRiskLevel;
  tokenUsage: number;
  tokenWindow: number;
  estimatedBytes: number;
}

type RetainedTaskStatus = "pending" | "in_progress" | "completed";

interface RetainedTaskState {
  title: string;
  status: RetainedTaskStatus;
}

interface RetainedContinuationState {
  tasks: RetainedTaskState[];
  completionSignals: string[];
  latestObjective: string;
}

export interface SessionStatus {
  provider: AgentProvider;
  state: SessionState;
  permissionMode: string;
  model: string;
  cwd: string;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  queueLength: number;
  providerSessionId?: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface ClaudeSessionOptions {
  chatId: string;
  config: AppConfig["claude"];
  mcpServers?: readonly McpServerConfig[];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  logger: Logger;
  onSessionIdCaptured?: () => void;
  onTurnComplete?: () => void;
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
  readonly senderOpenId: string;
  readonly parentMessageId: string;
  readonly imageDataUri?: string;
  readonly emit: EmitFn;
  readonly done: Deferred<void>;
  /** Monotonic id for logging — not exposed to the outside. */
  readonly seq: number;
  /** Display language detected from the user's message text. */
  readonly locale: import("../util/i18n.js").Locale;
}

/**
 * Extended submit() input: `CommandRouterResult` widened with the
 * fields the broker needs to check ownership and thread replies.
 * The dispatcher builds one of these per incoming Feishu message.
 */
export type SubmitInput = CommandRouterResult & {
  senderOpenId: string;
  parentMessageId: string;
  imageDataUri?: string;
  /** Display language detected from the user's message text. */
  locale: import("../util/i18n.js").Locale;
};

/**
 * Phase 4 ClaudeSession — explicit state machine with an input queue
 * and a processLoop that drains one turn at a time. The mutex here
 * only guards mutations to the state/queue fields; the turn itself
 * runs outside the mutex so `submit()` and `stop()` stay responsive
 * while a turn is in-flight.
 */
export class ClaudeSession {
  private readonly chatId: string;
  private readonly config: AppConfig["claude"];
  private readonly queryFn: QueryFn;
  // `clock` is a dependency Phase 5 will use (timers). Phase 4 only
  // keeps it in the constructor signature so Phase 5 is a drop-in
  // addition without another constructor churn.
  private readonly clock: Clock;
  private readonly permissionBroker: PermissionBroker;
  private readonly questionBroker: QuestionBroker;
  private readonly mcpServers: readonly McpServerConfig[];
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

  /**
   * When true, subsequent turns run with `permissionMode: "acceptEdits"`
   * regardless of the configured default. Set by the session's canUseTool
   * closure when the user clicks "会话 acceptEdits" on a permission card.
   * Cleared only on process restart (Phase 5 scope) — Phase 6's `/new`
   * and `/mode default` commands will clear it too.
   */
  private sessionAcceptEditsSticky = false;

  private permissionModeOverride?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  private modelOverride?: string;
  private provider: AgentProvider = "claude";
  private turnCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private claudeSessionId: string | undefined;
  private retainedContinuation: RetainedContinuationState = {
    tasks: [],
    completionSignals: [],
    latestObjective: "",
  };
  private readonly onSessionIdCaptured?: () => void;
  private readonly onTurnComplete?: () => void;
  private createdAt: string;
  private lastActiveAt: string;

  constructor(opts: ClaudeSessionOptions) {
    this.chatId = opts.chatId;
    this.config = opts.config;
    this.queryFn = opts.queryFn;
    this.clock = opts.clock;
    this.permissionBroker = opts.permissionBroker;
    this.questionBroker = opts.questionBroker;
    this.mcpServers = opts.mcpServers ?? [];
    this.logger = opts.logger.child({ chat_id: opts.chatId });
    if (opts.onSessionIdCaptured !== undefined) {
      this.onSessionIdCaptured = opts.onSessionIdCaptured;
    }
    if (opts.onTurnComplete !== undefined) {
      this.onTurnComplete = opts.onTurnComplete;
    }
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    // Touch clock so the compiler doesn't warn about an unused field.
    void this.clock;
  }

  /**
   * Submit a parsed command to the session. Phase 4 Task 6 wires
   * `run` only; `stop` and `interrupt_and_run` arrive in Tasks 8/9.
   */
  async submit(
    input: SubmitInput,
    emit: EmitFn,
  ): Promise<SubmitOutcome> {
    if (input.kind === "stop") {
      // Route through stop() so both the /stop command and a direct
      // caller get the same behavior. stop() doesn't return a
      // SubmitOutcome, so synthesize one so the dispatcher can handle
      // all three submit kinds uniformly.
      await this.stop(emit);
      return { kind: "rejected", reason: "stop" };
    }

    if (input.kind === "command" || input.kind === "unknown_command") {
      // These are handled by CommandDispatcher before reaching submit().
      // Guard here so TypeScript can narrow input.text below.
      throw new Error(`submit() called with kind="${input.kind}"; route through CommandDispatcher instead`);
    }

    const entry: QueuedInput = {
      text: input.text,
      senderOpenId: input.senderOpenId,
      parentMessageId: input.parentMessageId,
      ...(input.imageDataUri ? { imageDataUri: input.imageDataUri } : {}),
      emit,
      done: createDeferred<void>(),
      seq: this.nextSeq++,
      locale: input.locale,
    };

    if (input.kind === "interrupt_and_run") {
      return await this.submitInterruptAndRun(entry);
    }

    // Plain run.
    const outcome = await this.mutex.run(
      async (): Promise<SubmitOutcome> => {
        this.inputQueue.push(entry);
        const wasIdle = this.state === "idle";
        if (wasIdle) {
          this.state = "generating";
        }
        this.kickLoopIfNeeded();
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
   * `!` prefix path: drop whatever is queued, interrupt the currently
   * running turn, and enqueue the new input so it runs NEXT. Always
   * returns { kind: "started" } — bang never queues.
   */
  private async submitInterruptAndRun(
    entry: QueuedInput,
  ): Promise<SubmitOutcome> {
    const toDrop: QueuedInput[] = [];
    let toInterrupt: QueryHandle | null = null;
    let needCancelPending = false;

    await this.mutex.run(async () => {
      while (this.inputQueue.length > 0) {
        toDrop.push(this.inputQueue.shift()!);
      }
      toInterrupt = this.currentTurn?.handle ?? null;
      if (this.state === "awaiting_permission") {
        needCancelPending = true;
        this.state = "generating";
      }
      this.inputQueue.push(entry);
      if (this.state === "idle") {
        this.state = "generating";
      }
      this.kickLoopIfNeeded();
    });

    if (needCancelPending) {
      this.permissionBroker.cancelAll("User sent ! prefix");
    }
    // Questions can be pending at any time during a turn (not just
    // in `awaiting_permission`), so always cancel the question
    // broker whenever we interrupt the current turn.
    if (toInterrupt !== null) {
      this.questionBroker.cancelAll("User sent ! prefix");
    }

    for (const dropped of toDrop) {
      try {
        await dropped.emit({ type: "interrupted", reason: "bang_prefix" });
      } catch (err) {
        this.logger.warn(
          { err, seq: dropped.seq },
          "emit interrupted event threw — continuing to reject done",
        );
      }
      dropped.done.reject(new InterruptedError("bang_prefix"));
    }

    if (toInterrupt !== null) {
      try {
        await (toInterrupt as QueryHandle).interrupt();
      } catch (err) {
        this.logger.warn(
          { err },
          "interrupt_and_run: currentTurn.interrupt() threw",
        );
      }
    }

    return { kind: "started", done: entry.done.promise };
  }

  /**
   * Start the processLoop if it isn't already running. Must be called
   * inside the mutex — it sets `loopRunning` atomically with the push
   * that made the queue non-empty.
   */
  private kickLoopIfNeeded(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    // Start the loop on a microtask so it runs after the current
    // mutex-protected block releases. Fire-and-forget — the loop
    // catches its own errors.
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

  /**
   * Cancel any in-flight turn and drop every queued input. Safe to
   * call in any state — in `idle` it's a no-op that just emits the
   * stop ack. Returns once the queue has been drained and the
   * interrupt has been dispatched; the currently running turn may
   * still take a beat to finish unwinding its iterator.
   */
  async stop(emit: EmitFn): Promise<void> {
    const toDrop: QueuedInput[] = [];
    let toInterrupt: QueryHandle | null = null;
    let needCancelPending = false;

    await this.mutex.run(async () => {
      if (this.state === "idle") return;
      toInterrupt = this.currentTurn?.handle ?? null;
      if (this.state === "awaiting_permission") {
        needCancelPending = true;
        this.state = "generating";
      }
      while (this.inputQueue.length > 0) {
        toDrop.push(this.inputQueue.shift()!);
      }
    });

    if (needCancelPending) {
      this.permissionBroker.cancelAll("User issued /stop");
    }
    // Cancel question broker whenever we have a turn to interrupt —
    // an `ask_user` call might be pending without the session being
    // in `awaiting_permission`.
    if (toInterrupt !== null) {
      this.questionBroker.cancelAll("User issued /stop");
    }

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

    if (toInterrupt !== null) {
      try {
        await (toInterrupt as QueryHandle).interrupt();
      } catch (err) {
        this.logger.warn({ err }, "currentTurn.interrupt() threw");
      }
    }

    try {
      await emit({ type: "stop_ack" });
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

      const permissionMode = this.sessionAcceptEditsSticky
        ? ("acceptEdits" as const)
        : (this.permissionModeOverride ?? this.config.defaultPermissionMode);
      // Per-turn MCP server binds the ask_user tool handler to the
      // current input's senderOpenId / parentMessageId so the
      // question card threads under the triggering message and only
      // the original sender can click.
      const askUserMcp = createAskUserMcpServer({
        broker: this.questionBroker,
        chatId: this.chatId,
        ownerOpenId: next.senderOpenId,
        parentMessageId: next.parentMessageId,
        locale: next.locale,
        logger: this.logger,
      });
      const mcpServers = {
        feishu: askUserMcp,
        ...this.userMcpServerRecord(),
      };
      const prompt = this.buildPrompt(next);
      const promptText = this.promptPreview(next);
      const assessment = this.assessContextRisk(promptText);
      let effectivePrompt = prompt;

      if (assessment.level === "warn") {
        await next.emit({ type: "context_warning", level: "warn" });
      }

      if (assessment.level === "compact" && this.claudeSessionId !== undefined) {
        this.logger.warn(
          { seq: next.seq, old_session_id: this.claudeSessionId, assessment },
          "Context approaching limit — compacting before provider call",
        );
        this.claudeSessionId = undefined;
        await next.emit({ type: "context_compacting" });
      }

      if (assessment.level === "summarize_reset") {
        this.logger.warn(
          { seq: next.seq, old_session_id: this.claudeSessionId, assessment },
          "Context requires summarized fresh session",
        );
        this.claudeSessionId = undefined;
        await next.emit({ type: "context_summarized_reset" });
        effectivePrompt = this.prependContinuationSummary(
          prompt,
          this.buildContinuationSummary(next),
        );
      }

      const handle = this.queryFn({
        prompt: effectivePrompt,
        options: {
          cwd: this.config.defaultCwd,
          model: this.modelOverride ?? this.config.defaultModel,
          permissionMode,
          settingSources: ["user", "project"],
          mcpServers,
          disallowedTools: ["AskUserQuestion"],
          ...(this.config.autoCompactThreshold !== undefined
            ? { autoCompactThreshold: this.config.autoCompactThreshold }
            : {}),
          ...(this.claudeSessionId !== undefined
            ? { resumeId: this.claudeSessionId }
            : {}),
        },
        canUseTool: this.buildCanUseToolClosure(next),
      });
      this.currentTurn = { input: next, handle };

      let turnError: unknown = null;
      try {
        await this.runTurn(next, handle);
      } catch (err) {
        // When the accumulated conversation context exceeds 20 MB the
        // Claude API rejects the request outright. Detect this, drop
        // the session id (so the next attempt starts a fresh context),
        // notify the user, and retry the same input once.
        if (this.isRequestTooLargeError(err) && this.claudeSessionId !== undefined) {
          this.logger.warn(
            { err, seq: next.seq, old_session_id: this.claudeSessionId },
            "Request too large — resetting session and retrying",
          );
          this.claudeSessionId = undefined;
          try {
            await next.emit({ type: "context_reset" });
          } catch (emitErr) {
            this.logger.warn({ err: emitErr }, "context_reset emit threw");
          }

          // Rebuild handle without resume (fresh session).
          const retryHandle = this.queryFn({
            prompt,
            options: {
              cwd: this.config.defaultCwd,
              model: this.modelOverride ?? this.config.defaultModel,
              permissionMode,
              settingSources: ["user", "project"],
              mcpServers,
              disallowedTools: ["AskUserQuestion"],
              ...(this.config.autoCompactThreshold !== undefined
                ? { autoCompactThreshold: this.config.autoCompactThreshold }
                : {}),
              // no resume — start fresh
            },
            canUseTool: this.buildCanUseToolClosure(next),
          });
          this.currentTurn = { input: next, handle: retryHandle };

          try {
            await this.runTurn(next, retryHandle);
          } catch (retryErr) {
            this.logger.error(
              { err: retryErr, seq: next.seq },
              "Retry after context reset also failed",
            );
            turnError = retryErr;
          }
        } else {
          this.logger.error({ err, seq: next.seq }, "Claude turn failed");
          turnError = err;
        }
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

  private estimatePromptBytes(prompt: string): number {
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    const historicalBytes = (this.totalInputTokens + this.totalOutputTokens) * 4;
    return promptBytes + historicalBytes;
  }

  private contextWindowFor(model: string): number {
    void model;
    return 200_000;
  }

  private assessContextRisk(prompt: string): ContextAssessment {
    const tokenUsage = this.totalInputTokens + this.totalOutputTokens;
    const tokenWindow = this.contextWindowFor(
      this.modelOverride ?? this.config.defaultModel,
    );
    const estimatedBytes = this.estimatePromptBytes(prompt);

    if (estimatedBytes >= 18_000_000) {
      return { level: "summarize_reset", tokenUsage, tokenWindow, estimatedBytes };
    }
    if (tokenUsage / tokenWindow >= 0.9) {
      return { level: "compact", tokenUsage, tokenWindow, estimatedBytes };
    }
    if (tokenUsage / tokenWindow >= 0.8 || estimatedBytes >= 12_000_000) {
      return { level: "warn", tokenUsage, tokenWindow, estimatedBytes };
    }
    return { level: "normal", tokenUsage, tokenWindow, estimatedBytes };
  }

  private promptPreview(input: QueuedInput): string {
    if (!input.imageDataUri) return input.text;

    const text =
      input.text === "[Image]" || input.text.trim().length === 0
        ? "What is in this image?"
        : input.text;
    return `${text}\n${input.imageDataUri}`;
  }

  private immediateRequestSummary(input: QueuedInput): string {
    if (!input.imageDataUri) {
      return input.text.slice(0, 4_000);
    }

    const text =
      input.text === "[Image]" || input.text.trim().length === 0
        ? "What is in this image?"
        : input.text;
    return `${text}\n[image attachment preserved for the next turn]`;
  }

  private pruneCompletedTasks(tasks: RetainedTaskState[]): RetainedTaskState[] {
    return tasks.filter((task) => task.status !== "completed");
  }

  private isExplicitCompletionSignal(text: string): boolean {
    if (/\balmost done\b/i.test(text)) return false;
    return /\b(completed?|done)\b/i.test(text) || /已完成/.test(text);
  }

  private pruneExplicitCompletionSignals(signals: string[]): string[] {
    return signals.filter((signal) => !this.isExplicitCompletionSignal(signal));
  }

  private refreshRetainedContinuation(nextObjective: string): void {
    this.retainedContinuation = {
      tasks: this.pruneCompletedTasks(this.retainedContinuation.tasks),
      completionSignals: this.pruneExplicitCompletionSignals(
        this.retainedContinuation.completionSignals,
      ),
      latestObjective: nextObjective,
    };
  }

  private buildRetainedContinuationSummary(): string {
    const activeTasks = this.retainedContinuation.tasks.map(
      (task) => `- ${task.title} [${task.status}]`,
    );

    return [
      "Continuation summary for a fresh session:",
      "",
      "Completed items removed from continuation context.",
      ...(this.retainedContinuation.latestObjective
        ? [`Current objective: ${this.retainedContinuation.latestObjective}`]
        : []),
      ...activeTasks,
      ...this.retainedContinuation.completionSignals,
    ].join("\n");
  }

  private buildContinuationSummary(next: QueuedInput): string {
    const status = this.getStatus();
    this.refreshRetainedContinuation(this.immediateRequestSummary(next));
    return [
      this.buildRetainedContinuationSummary(),
      `Provider: ${status.provider}`,
      `Model: ${status.model}`,
      `Working directory: ${status.cwd}`,
      `Permission mode: ${status.permissionMode}`,
      `Prior token totals: in=${status.totalInputTokens}, out=${status.totalOutputTokens}`,
    ].join("\n");
  }

  private prependContinuationSummary(
    prompt: string | AsyncIterable<SDKUserMessage>,
    summary: string,
  ): string | AsyncIterable<SDKUserMessage> {
    if (typeof prompt === "string") {
      return `${summary}\n\nUser request:\n${prompt}`;
    }

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: summary }],
          },
          parent_tool_use_id: null,
        };

        for await (const message of prompt) {
          yield message;
        }
      },
    };
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
      if (msg.session_id && !this.claudeSessionId) {
        this.setProviderSessionId(msg.session_id);
        this.onSessionIdCaptured?.();
      }
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
    this.turnCount++;
    this.totalInputTokens += resultMsg.usage?.input_tokens ?? 0;
    this.totalOutputTokens += resultMsg.usage?.output_tokens ?? 0;
    this.lastActiveAt = new Date().toISOString();
    this.onTurnComplete?.();
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

  // --- public API ---

  getState(): SessionState {
    return this.state;
  }

  setPermissionModeOverride(
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
  ): void {
    this.permissionModeOverride = mode;
    this.sessionAcceptEditsSticky = mode === "acceptEdits";
  }

  setModelOverride(model: string): void {
    this.modelOverride = model;
  }

  setProvider(provider: AgentProvider): void {
    this.provider = provider;
  }

  /** Returns true if the session has any explicit configuration overrides worth persisting. */
  hasExplicitOverrides(): boolean {
    return this.modelOverride !== undefined || this.permissionModeOverride !== undefined;
  }

  /** Set the provider session ID for resume. Used by SessionManager during lazy restore. */
  setProviderSessionId(id: string): void {
    this.claudeSessionId = id;
  }

  /** Restore timestamps from a persisted record. Used by SessionManager during lazy restore. */
  setTimestamps(createdAt: string, lastActiveAt: string): void {
    this.createdAt = createdAt;
    this.lastActiveAt = lastActiveAt;
  }

  getStatus(): SessionStatus {
    return {
      provider: this.provider,
      state: this.state,
      permissionMode: this.sessionAcceptEditsSticky
        ? "acceptEdits"
        : (this.permissionModeOverride ?? this.config.defaultPermissionMode),
      model: this.modelOverride ?? this.config.defaultModel,
      cwd: this.config.defaultCwd,
      turnCount: this.turnCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      queueLength: this.inputQueue.length,
      ...(this.claudeSessionId !== undefined
        ? { providerSessionId: this.claudeSessionId }
        : {}),
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
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

  /** @internal Phase 5 test seam — manipulates sticky flag directly. */
  _testSetSessionAcceptEditsSticky(value: boolean): void {
    this.sessionAcceptEditsSticky = value;
  }

  /** @internal */
  _testGetSessionAcceptEditsSticky(): boolean {
    return this.sessionAcceptEditsSticky;
  }

  /** @internal */
  _testAssessContextRisk(prompt: string): ContextAssessment {
    return this.assessContextRisk(prompt);
  }

  /** @internal */
  _testBuildContinuationSummary(nextInput: string): string {
    return this.buildContinuationSummary({
      text: nextInput,
      senderOpenId: "ou_test",
      parentMessageId: "om_test",
      emit: async () => {},
      done: createDeferred<void>(),
      seq: -1,
      locale: "en",
    });
  }

  /** @internal */
  _testSetRetainedTaskState(tasks: RetainedTaskState[]): void {
    this.retainedContinuation.tasks = tasks.map((task) => ({ ...task }));
  }

  /** @internal */
  _testRecordCompletionSignal(text: string): void {
    this.retainedContinuation.completionSignals.push(text);
  }

  /** @internal */
  _testRefreshRetainedContinuation(nextObjective: string): void {
    this.refreshRetainedContinuation(nextObjective);
  }

  /** @internal */
  _testBuildRetainedContinuationSummary(): string {
    return this.buildRetainedContinuationSummary();
  }

  private buildPrompt(
    input: QueuedInput,
  ): string | AsyncIterable<SDKUserMessage> {
    if (!input.imageDataUri) {
      return input.text;
    }

    const match = input.imageDataUri.match(/^data:(image\/[^;]+);base64,(.+)$/);
    const mediaType = (() => {
      switch (match?.[1]) {
        case "image/png":
        case "image/gif":
        case "image/webp":
          return match[1];
        default:
          return "image/jpeg";
      }
    })();
    const data = match?.[2] ?? input.imageDataUri;
    const text =
      input.text === "[Image]" || input.text.trim().length === 0
        ? "What is in this image?"
        : input.text;
    const message: SDKUserMessage["message"] = {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data,
          },
        },
        { type: "text", text },
      ],
    };

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          message,
          parent_tool_use_id: null,
        };
      },
    };
  }

  private userMcpServerRecord(): Record<
    string,
    import("@anthropic-ai/claude-agent-sdk").McpServerConfig
  > {
    return Object.fromEntries(
      this.mcpServers.map((server) => {
        if (server.type === "sse") {
          return [
            server.name,
            {
              type: "sse" as const,
              url: server.url!,
            },
          ] as const;
        }
        return [
          server.name,
          {
            ...(server.type === "stdio" ? { type: "stdio" as const } : {}),
            command: server.command!,
            ...(server.args !== undefined ? { args: server.args } : {}),
            ...(server.env !== undefined ? { env: server.env } : {}),
          },
        ] as const;
      }),
    );
  }

  /**
   * Detect whether an error is the Claude API "Request too large"
   * rejection. The SDK surfaces this as an error message containing
   * "Request too large" or "max 20MB" — match both variants and
   * common casing variations so we don't miss it.
   */
  private isRequestTooLargeError(err: unknown): boolean {
    const msg =
      err instanceof Error ? err.message : typeof err === "string" ? err : "";
    return /request too large|max 20\s?mb/i.test(msg);
  }

  private buildCanUseToolClosure(input: QueuedInput): CanUseToolFn {
    return async (toolName, rawInput, _sdkOpts) => {
      this.logger.info(
        { tool_name: toolName, input_keys: Object.keys(rawInput) },
        "canUseTool called",
      );
      // In-process MCP tools we inject ourselves (the `feishu` server —
      // currently just `ask_user`) must bypass the permission broker.
      // These are UX affordances the bot owns, not arbitrary tool calls
      // the user needs to approve; running them through the permission
      // card would pop up "Claude wants to call mcp__feishu__ask_user"
      // on top of the actual ask_user question card, which is both
      // nonsensical and blocks the real card from appearing.
      if (toolName.startsWith("mcp__feishu__")) {
        this.logger.info(
          { tool_name: toolName },
          "canUseTool: auto-allow mcp__feishu__*",
        );
        return { behavior: "allow", updatedInput: rawInput };
      }

      // Flip into awaiting_permission while we wait on the broker.
      await this.mutex.run(async () => {
        if (this.state === "generating") {
          this.state = "awaiting_permission";
        }
      });

      let response;
      try {
        response = await this.permissionBroker.request({
          toolName,
          input: rawInput,
          chatId: this.chatId,
          ownerOpenId: input.senderOpenId,
          parentMessageId: input.parentMessageId,
          locale: input.locale,
        });
      } finally {
        await this.mutex.run(async () => {
          if (this.state === "awaiting_permission") {
            this.state = "generating";
          }
        });
      }

      switch (response.behavior) {
        case "allow":
          return { behavior: "allow" };
        case "deny":
          return { behavior: "deny", message: response.message };
        case "allow_turn":
          this.currentTurn?.handle.setPermissionMode("acceptEdits");
          return { behavior: "allow" };
        case "allow_session":
          this.currentTurn?.handle.setPermissionMode("acceptEdits");
          this.sessionAcceptEditsSticky = true;
          return { behavior: "allow" };
      }
    };
  }
}

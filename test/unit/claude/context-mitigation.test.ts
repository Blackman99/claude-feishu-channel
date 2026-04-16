import { describe, expect, it } from "vitest";
import { ClaudeSession, type ClaudeSessionOptions } from "../../../src/claude/session.js";
import type { RenderEvent } from "../../../src/claude/render-event.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "./fakes/fake-question-broker.js";
import { FakeQueryHandle } from "./fakes/fake-query-handle.js";
import type { QueryFn } from "../../../src/claude/query-handle.js";
import type { SDKMessageLike } from "../../../src/claude/session.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
  permissionTimeoutMs: 300_000,
  permissionWarnBeforeMs: 60_000,
};

function createHarness(overrides?: {
  model?: string;
  providerSessionId?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  firstRunError?: Error;
}): {
  session: ClaudeSession;
  events: RenderEvent[];
  queryCalls: Array<{
    prompt: Parameters<QueryFn>[0]["prompt"];
    options: Parameters<QueryFn>[0]["options"];
  }>;
  fakes: FakeQueryHandle[];
  timeline: string[];
  emit: (event: RenderEvent) => Promise<void>;
} {
  const events: RenderEvent[] = [];
  const queryCalls: Array<{
    prompt: Parameters<QueryFn>[0]["prompt"];
    options: Parameters<QueryFn>[0]["options"];
  }> = [];
  const fakes: FakeQueryHandle[] = [];
  const timeline: string[] = [];
  const emit = async (event: RenderEvent): Promise<void> => {
    events.push(event);
    timeline.push(`event:${event.type}`);
  };
  const queryFn: QueryFn = (params) => {
    timeline.push("queryFn");
    queryCalls.push({ prompt: params.prompt, options: params.options });
    if (overrides?.firstRunError !== undefined && queryCalls.length === 1) {
      return {
        messages: {
          async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessageLike> {
            throw overrides.firstRunError;
          },
        },
        interrupt: async () => {},
        setPermissionMode: () => {},
      };
    }
    const fake = new FakeQueryHandle();
    fake.canUseTool = params.canUseTool;
    fake.options = params.options;
    fakes.push(fake);
    return fake;
  };
  const opts: ClaudeSessionOptions = {
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    clock: new FakeClock(),
    permissionBroker: new FakePermissionBroker(),
    questionBroker: new FakeQuestionBroker(),
    logger: SILENT_LOGGER,
  };
  const session = new ClaudeSession(opts);
  const mutableSession = session as any;
  if (overrides?.model !== undefined) {
    session.setModelOverride(overrides.model);
  }
  if (overrides?.providerSessionId !== undefined) {
    session.setProviderSessionId(overrides.providerSessionId);
  }
  if (overrides?.totalInputTokens !== undefined) {
    mutableSession.totalInputTokens = overrides.totalInputTokens;
  }
  if (overrides?.totalOutputTokens !== undefined) {
    mutableSession.totalOutputTokens = overrides.totalOutputTokens;
  }
  return { session, events, queryCalls, fakes, timeline, emit };
}

function runInput(text: string) {
  return {
    kind: "run" as const,
    text,
    senderOpenId: "ou_test",
    parentMessageId: "om_test",
    locale: "en" as const,
  };
}

function runImageInput(text: string, imageDataUris: readonly string[]) {
  return {
    ...runInput(text),
    imageDataUris,
  };
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

describe("ClaudeSession context assessment", () => {
  it("classifies normal usage below warning thresholds", async () => {
    const h = createHarness({
      totalInputTokens: 20_000,
      totalOutputTokens: 2_000,
    });
    expect(h.session._testAssessContextRisk("small prompt")).toMatchObject({
      level: "normal",
    });
  });

  it("classifies warning when token usage is high but reset is not required", async () => {
    const h = createHarness({
      model: "claude-opus-4-6",
      totalInputTokens: 160_000,
      totalOutputTokens: 4_000,
    });
    expect(h.session._testAssessContextRisk("follow-up prompt")).toMatchObject({
      level: "warn",
    });
  });

  it("uses the same 200k context window for other supported Claude families", async () => {
    const h = createHarness({
      model: "claude-haiku-4-0",
      totalInputTokens: 160_000,
      totalOutputTokens: 5_000,
    });
    expect(h.session._testAssessContextRisk("haiku prompt")).toMatchObject({
      level: "warn",
      tokenWindow: 200_000,
    });
  });

  it("classifies summarize_reset when estimated bytes are above the hard threshold", async () => {
    const huge = "x".repeat(19_000_000);
    const h = createHarness();
    expect(h.session._testAssessContextRisk(huge)).toMatchObject({
      level: "summarize_reset",
    });
  });

  it("accounts for accumulated session history in byte estimation", async () => {
    const h = createHarness({
      totalInputTokens: 4_600_000,
      totalOutputTokens: 200_000,
    });
    expect(h.session._testAssessContextRisk("small prompt")).toMatchObject({
      level: "summarize_reset",
    });
  });

  it("emits a context warning before running a high-usage turn", async () => {
    const h = createHarness({
      totalInputTokens: 165_000,
      totalOutputTokens: 2_000,
    });

    const outcome = await h.session.submit(runInput("warn me"), h.emit);
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    expect(h.timeline[0]).toBe("event:context_warning");
    expect(h.timeline[1]).toBe("queryFn");
    expect(h.events).toContainEqual({
      type: "context_warning",
      level: "warn",
    });

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("keeps resumeId in warning zone while continuing to use the provider thread", async () => {
    const h = createHarness({
      providerSessionId: "ses_warn",
      totalInputTokens: 165_000,
      totalOutputTokens: 2_000,
    });

    const outcome = await h.session.submit(runInput("warn me"), h.emit);
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    expect(h.queryCalls[0]!.options.resumeId).toBe("ses_warn");

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("drops providerSessionId before running a compact-required turn", async () => {
    const h = createHarness({
      totalInputTokens: 190_000,
      totalOutputTokens: 2_000,
      providerSessionId: "ses_old",
    });

    const outcome = await h.session.submit(runInput("compact me"), h.emit);
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    expect(h.timeline[0]).toBe("event:context_compacting");
    expect(h.timeline[1]).toBe("queryFn");
    expect(h.events).toContainEqual({ type: "context_compacting" });
    expect(h.queryCalls).toHaveLength(1);
    expect(h.queryCalls[0]!.options.resumeId).toBeUndefined();

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("uses retained summary plus bounded recent context for lower-risk compact handoff", async () => {
    const h = createHarness({
      providerSessionId: "ses_compact",
      totalInputTokens: 181_000,
      totalOutputTokens: 1_000,
    });

    h.session._testSetRetainedTaskState([
      { title: "Task 2", status: "in_progress" },
    ]);
    (h.session as any)._testRecordRecentContext("User: previous request");
    (h.session as any)._testRecordRecentContext("Assistant: previous answer");

    const outcome = await h.session.submit(runInput("continue work"), h.emit);
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    expect(h.queryCalls[0]!.options.resumeId).toBeUndefined();
    expect(h.events).toContainEqual({ type: "context_compacting" });
    expect(typeof h.queryCalls[0]!.prompt).toBe("string");
    expect(h.queryCalls[0]!.prompt).toContain("Continuation summary for resumed work:");
    expect(h.queryCalls[0]!.prompt).toContain("Recent context:");
  });

  it("counts image payload bytes when assessing pre-turn warning risk", async () => {
    const h = createHarness();
    const imageDataUri = `data:image/png;base64,${"a".repeat(12_500_000)}`;

    const outcome = await h.session.submit(
      runImageInput("describe image", [imageDataUri]),
      h.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    expect(h.events).toContainEqual({
      type: "context_warning",
      level: "warn",
    });

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("starts a fresh summarized session when context risk requires summarize_reset", async () => {
    const huge = "x".repeat(19_000_000);
    const h = createHarness({
      providerSessionId: "ses_old",
      model: "claude-opus-4-6",
      totalInputTokens: 195_000,
      totalOutputTokens: 3_000,
    });

    const outcome = await h.session.submit(runInput(huge), h.emit);
    if (outcome.kind === "rejected") throw new Error(outcome.reason);
    await flushMicrotasks();

    expect(h.events).toContainEqual({ type: "context_summarized_reset" });
    expect(h.queryCalls).toHaveLength(1);
    expect(h.queryCalls[0]!.options.resumeId).toBeUndefined();
    expect(typeof h.queryCalls[0]!.prompt).toBe("string");
    expect(h.queryCalls[0]!.prompt).toContain("Continuation summary for a fresh session:");
    expect(h.session.getStatus().providerSessionId).toBeUndefined();

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("preserves provider/model/cwd/permission mode across summarized reset", () => {
    const h = createHarness({
      providerSessionId: "thread_old",
      model: "gpt-5.4",
    });

    h.session.setProvider("codex");
    h.session.setPermissionModeOverride("plan");

    const summary = h.session._testBuildContinuationSummary("next task");
    expect(summary).toContain("Current objective");
    expect(summary).toContain("gpt-5.4");
    expect(summary).toContain("/tmp/cfc-test");
    expect(summary).toContain("plan");
    expect(summary).toContain("codex");
  });

  it("removes explicitly completed structured tasks from retained continuation state", () => {
    const h = createHarness({
      totalInputTokens: 165_000,
      totalOutputTokens: 5_000,
    });

    h.session._testSetRetainedTaskState([
      { title: "Task 1", status: "completed" },
      { title: "Task 2", status: "in_progress" },
      { title: "Task 3", status: "pending" },
    ]);

    h.session._testRefreshRetainedContinuation("Task 2 in progress");

    const summary = h.session._testBuildRetainedContinuationSummary();
    expect(summary).not.toContain("Task 1");
    expect(summary).toContain("Task 2");
    expect(summary).toContain("Task 3");
  });

  it("uses explicit completion text as a fallback pruning signal", () => {
    const h = createHarness();

    h.session._testRecordCompletionSignal("Task 4 已完成");
    h.session._testRefreshRetainedContinuation("Task 5 pending");

    const summary = h.session._testBuildRetainedContinuationSummary();
    expect(summary).not.toContain("Task 4");
  });

  it("does not delete context for ambiguous progress wording", () => {
    const h = createHarness();

    h.session._testRecordCompletionSignal("Task 6 almost done");
    h.session._testRefreshRetainedContinuation("Task 6 still active");

    const summary = h.session._testBuildRetainedContinuationSummary();
    expect(summary).toContain("Task 6");
  });

  it("preserves image prompts when summarized reset starts a fresh session", async () => {
    const h = createHarness({
      providerSessionId: "ses_old",
      totalInputTokens: 10_000,
      totalOutputTokens: 2_000,
    });
    const imageDataUri = `data:image/png;base64,${"a".repeat(19_000_000)}`;

    const outcome = await h.session.submit(
      runImageInput("describe image", [imageDataUri]),
      h.emit,
    );
    if (outcome.kind === "rejected") throw new Error(outcome.reason);
    await flushMicrotasks();

    expect(h.events).toContainEqual({ type: "context_summarized_reset" });
    expect(typeof h.queryCalls[0]!.prompt).not.toBe("string");

    const messages: unknown[] = [];
    for await (const msg of h.queryCalls[0]!.prompt as AsyncIterable<unknown>) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      message: {
        content: [{ type: "text", text: expect.stringContaining("Current objective") }],
      },
    });
    expect(messages[1]).toMatchObject({ type: "user" });
    const secondContent = (messages[1] as { message: { content: Array<{ type: string }> } })
      .message.content;
    expect(secondContent[0]).toMatchObject({ type: "image" });
    expect(secondContent[1]).toMatchObject({ type: "text", text: "describe image" });

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("still performs the existing reset-and-retry when backend size detection misses", async () => {
    const h = createHarness({
      providerSessionId: "ses_backend_limit",
      firstRunError: new Error("Request too large: max 20MB"),
    });

    const outcome = await h.session.submit(runInput("retry me"), h.emit);
    if (outcome.kind === "rejected") throw new Error(outcome.reason);
    await flushMicrotasks();

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;

    expect(h.events).toContainEqual({ type: "context_reset" });
    expect(h.queryCalls).toHaveLength(2);
    expect(h.queryCalls[0]!.options.resumeId).toBe("ses_backend_limit");
    expect(h.queryCalls[1]!.options.resumeId).toBeUndefined();
  });

  it("uses retained-summary handoff for hard fallback retry", async () => {
    const h = createHarness({
      providerSessionId: "ses_backend_limit",
      firstRunError: new Error("Request too large: max 20MB"),
    });

    h.session._testSetRetainedTaskState([
      { title: "Task 5", status: "in_progress" },
    ]);

    const outcome = await h.session.submit(runInput("retry me"), h.emit);
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;

    expect(h.queryCalls).toHaveLength(2);
    expect(typeof h.queryCalls[1]!.prompt).toBe("string");
    expect(h.queryCalls[1]!.prompt).toContain(
      "Continuation summary for resumed work:",
    );
  });
});

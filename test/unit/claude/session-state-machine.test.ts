import { describe, it, expect } from "vitest";
import {
  ClaudeSession,
  type ClaudeSessionOptions,
} from "../../../src/claude/session.js";
import { FakeQueryHandle } from "./fakes/fake-query-handle.js";
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "./fakes/fake-question-broker.js";
import { SpyRenderer } from "./fakes/spy-renderer.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import type { QueryFn, QueryHandle } from "../../../src/claude/query-handle.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
  permissionTimeoutMs: 300_000,
  permissionWarnBeforeMs: 60_000,
};

interface Harness {
  session: ClaudeSession;
  fakes: FakeQueryHandle[];
  queryFn: QueryFn;
  clock: FakeClock;
}

/**
 * Build a session with a queryFn that hands out a fresh
 * FakeQueryHandle per invocation. Tests grab successive fakes out of
 * `harness.fakes[i]` to drive each turn.
 */
function makeHarness(overrides?: { onSessionIdCaptured?: () => void }): Harness {
  const fakes: FakeQueryHandle[] = [];
  const queryFn: QueryFn = (params) => {
    const fake = new FakeQueryHandle();
    fake.canUseTool = params.canUseTool;
    fake.options = params.options;
    fakes.push(fake);
    return fake as QueryHandle;
  };
  const clock = new FakeClock();
  const questionBroker = new FakeQuestionBroker();
  const opts: ClaudeSessionOptions = {
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    clock,
    permissionBroker: new FakePermissionBroker(),
    questionBroker,
    logger: SILENT_LOGGER,
    ...(overrides?.onSessionIdCaptured !== undefined
      ? { onSessionIdCaptured: overrides.onSessionIdCaptured }
      : {}),
  };
  return { session: new ClaudeSession(opts), fakes, queryFn, clock };
}

/** Tick the event loop so queued microtasks (processLoop kicks) run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("ClaudeSession — happy path (idle → generating → idle)", () => {
  it("transitions to generating on first submit and kicks off a turn", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    expect(h.session._testGetState()).toBe("idle");
    const outcome = await h.session.submit(
      { kind: "run", text: "hello", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    expect(outcome.kind).toBe("started");
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("generating");
    expect(h.fakes).toHaveLength(1);
    expect(h.fakes[0]!.messagesConsumed).toBe(0); // turn still waiting on first emit
  });

  it("forwards a text assistant block through the emit callback", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    const outcome = await h.session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    expect(outcome.kind).toBe("started");
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    fake.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    });
    fake.finishWithSuccess({
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
    });
    if (outcome.kind !== "started") throw new Error("unreachable");
    await outcome.done;

    expect(spy.events).toEqual([
      { type: "text", text: "hello world" },
      { type: "turn_end", durationMs: 100, inputTokens: 10, outputTokens: 20 },
    ]);
    expect(h.session._testGetState()).toBe("idle");
  });

  it("logs start and completion with the active provider name", async () => {
    const infoMessages: string[] = [];
    const fakeLogger = {
      child() {
        return this;
      },
      info(_obj: unknown, msg?: string) {
        if (typeof msg === "string") infoMessages.push(msg);
      },
      warn() {},
      error() {},
      debug() {},
    } as unknown as ClaudeSessionOptions["logger"];
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: fakeLogger,
    });
    session.setProvider("codex");
    const spy = new SpyRenderer();

    const outcome = await session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;

    expect(infoMessages).toContain("Codex turn start");
    expect(infoMessages).toContain("Codex turn complete");
    expect(infoMessages).not.toContain("Claude turn complete");
  });

  it("passes cwd / model / permissionMode / settingSources / mcpServers / disallowedTools to the injected queryFn", async () => {
    const recorded: Array<{
      prompt: string | AsyncIterable<unknown>;
      options: {
        cwd: string;
        model: string;
        permissionMode: string;
        settingSources: readonly string[];
        mcpServers?: Readonly<Record<string, unknown>>;
        disallowedTools?: readonly string[];
      };
    }> = [];
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      recorded.push({
        prompt: params.prompt,
        options: {
          cwd: params.options.cwd,
          model: params.options.model,
          permissionMode: params.options.permissionMode,
          settingSources: params.options.settingSources,
          ...(params.options.mcpServers
            ? { mcpServers: params.options.mcpServers }
            : {}),
          ...(params.options.disallowedTools
            ? { disallowedTools: params.options.disallowedTools }
            : {}),
        },
      });
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    const spy = new SpyRenderer();
    const outcome = await session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.prompt).toBe("hi");
    expect(recorded[0]!.options.cwd).toBe("/tmp/cfc-test");
    expect(recorded[0]!.options.model).toBe("claude-opus-4-6");
    expect(recorded[0]!.options.permissionMode).toBe("default");
    expect(recorded[0]!.options.settingSources).toEqual(["user", "project"]);
    // Phase 5 Part 2: the session must disable the built-in AskUserQuestion
    // tool and inject exactly one in-process MCP server for the
    // `mcp__feishu__ask_user` shim.
    expect(recorded[0]!.options.disallowedTools).toEqual(["AskUserQuestion"]);
    expect(Object.keys(recorded[0]!.options.mcpServers ?? {})).toHaveLength(1);
  });

  it("rejects the per-input `done` promise when the turn ends with subtype=error", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "boom", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    h.fakes[0]!.finishWithError({
      subtype: "error_during_execution",
      errors: ["kaboom"],
    });
    await expect(outcome.done).rejects.toThrow(
      /kaboom|error_during_execution/,
    );
    expect(h.session._testGetState()).toBe("idle");
  });

  it("rejects the per-input `done` promise when the turn ends without a result message", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "incomplete", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    // Interrupt ends the iterator WITHOUT a result message.
    await h.fakes[0]!.interrupt();
    await expect(outcome.done).rejects.toThrow(/without a result/);
  });

  it("returns to idle after the turn, ready to accept a second submit", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (first.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await first.done;
    expect(h.session._testGetState()).toBe("idle");

    const second = await h.session.submit(
      { kind: "run", text: "two", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    expect(second.kind).toBe("started");
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("generating");
    if (second.kind !== "started") throw new Error("unreachable");
    h.fakes[1]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await second.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});

describe("ClaudeSession — FIFO queue", () => {
  it("second submit while generating returns queued #1 without consuming a new turn", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(1);
    expect(first.kind).toBe("started");

    const second = await h.session.submit(
      { kind: "run", text: "two", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy2.emit,
    );
    expect(second.kind).toBe("queued");
    if (second.kind !== "queued") throw new Error("unreachable");
    expect(second.position).toBe(1);
    expect(h.session._testGetQueueLength()).toBe(1);
    // Still only one turn has been created.
    expect(h.fakes).toHaveLength(1);
    // And the queued emit was delivered.
    expect(spy2.events).toEqual([{ type: "queued", position: 1 }]);
  });

  it("third submit lands at position 2", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spy3 = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    await flushMicrotasks();
    await h.session.submit({ kind: "run", text: "two", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" }, spy2.emit);
    const third = await h.session.submit(
      { kind: "run", text: "three", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy3.emit,
    );

    expect(third.kind).toBe("queued");
    if (third.kind !== "queued") throw new Error("unreachable");
    expect(third.position).toBe(2);
    expect(spy3.events).toEqual([{ type: "queued", position: 2 }]);
    void first;
  });

  it("drains the queue in FIFO order after each turn ends", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spy3 = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      { kind: "run", text: "two", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy2.emit,
    );
    const third = await h.session.submit(
      { kind: "run", text: "three", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy3.emit,
    );
    if (
      first.kind !== "started" ||
      second.kind !== "queued" ||
      third.kind !== "queued"
    ) {
      throw new Error("unreachable");
    }

    // End turn 1 → drain pulls "two"
    h.fakes[0]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply one" }] },
    });
    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await first.done;
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(2);

    // End turn 2 → drain pulls "three"
    h.fakes[1]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply two" }] },
    });
    h.fakes[1]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await second.done;
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(3);

    // End turn 3 → back to idle
    h.fakes[2]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply three" }] },
    });
    h.fakes[2]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await third.done;
    expect(h.session._testGetState()).toBe("idle");

    // Each turn's reply landed on the right emit.
    expect(
      spy1.events.some((e) => e.type === "text" && e.text === "reply one"),
    ).toBe(true);
    expect(
      spy2.events.some((e) => e.type === "text" && e.text === "reply two"),
    ).toBe(true);
    expect(
      spy3.events.some((e) => e.type === "text" && e.text === "reply three"),
    ).toBe(true);
  });

  it("a turn that fails still allows the next queued input to run", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "bad", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      { kind: "run", text: "good", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy2.emit,
    );
    if (first.kind !== "started" || second.kind !== "queued") {
      throw new Error("unreachable");
    }

    h.fakes[0]!.finishWithError({
      subtype: "error_during_execution",
      errors: ["boom"],
    });
    await expect(first.done).rejects.toThrow(/boom/);
    await flushMicrotasks();

    // Drain picked up turn 2 despite turn 1's error.
    expect(h.fakes).toHaveLength(2);
    h.fakes[1]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await second.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});

describe("ClaudeSession — /stop", () => {
  it("stop in idle emits stop ack and stays idle", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    await h.session.stop(spy.emit);
    expect(h.session._testGetState()).toBe("idle");
    expect(spy.events).toEqual([{ type: "stop_ack" }]);
  });

  it("stop in generating interrupts the current turn, clears the queue, and returns to idle", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const stopSpy = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      { kind: "run", text: "two", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy2.emit,
    );
    if (first.kind !== "started" || second.kind !== "queued") {
      throw new Error("unreachable");
    }

    // Fire the stop.
    await h.session.stop(stopSpy.emit);

    // The running turn's first handle was interrupted.
    expect(h.fakes[0]!.interrupted).toBe(true);
    // The queued second input got an "interrupted" out-of-band event
    // on its own emit and its done promise rejected with the stop reason.
    expect(spy2.events).toEqual([
      { type: "queued", position: 1 },
      { type: "interrupted", reason: "stop" },
    ]);
    await expect(second.done).rejects.toThrow(/stop|interrupted/i);

    // Turn 1 ends abnormally → first.done rejects.
    await expect(first.done).rejects.toThrow();

    // After the in-flight turn's iterator drains, state returns to idle.
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");

    // Stop ack was emitted via the caller's emit.
    expect(stopSpy.events).toEqual([{ type: "stop_ack" }]);
  });

  it("two /stop calls in a row are idempotent — second is a no-op ack", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    await h.session.stop(spy.emit);
    await h.session.stop(spy.emit);
    expect(h.session._testGetState()).toBe("idle");
    expect(spy.events).toEqual([
      { type: "stop_ack" },
      { type: "stop_ack" },
    ]);
  });

  it("submit({kind:'stop'}) delegates to stop() and returns rejected", async () => {
    // The command router parses "/stop" into `{kind: "stop"}`. The
    // Phase 4 dispatcher currently routes /stop through `session.stop()`
    // directly, but `session.submit()` also accepts `{kind: "stop"}` so
    // a single code path can handle all three CommandRouterResult
    // kinds uniformly. Exercise that contract here so the code path
    // stays alive and regressions don't sneak in.
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit({ kind: "stop", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" }, spy.emit);
    expect(outcome).toEqual({ kind: "rejected", reason: "stop" });
    expect(spy.events).toEqual([{ type: "stop_ack" }]);
    expect(h.session._testGetState()).toBe("idle");
  });

  it("submit({kind:'stop'}) interrupts a running turn just like session.stop()", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const stopSpy = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    if (first.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    const stopOutcome = await h.session.submit({ kind: "stop", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" }, stopSpy.emit);
    expect(stopOutcome).toEqual({ kind: "rejected", reason: "stop" });
    expect(h.fakes[0]!.interrupted).toBe(true);

    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");
    expect(stopSpy.events).toEqual([{ type: "stop_ack" }]);
  });

  it("stop during generating does NOT lose subsequently-submitted inputs", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const stopSpy = new SpyRenderer();
    const spy2 = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    if (first.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    await h.session.stop(stopSpy.emit);
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");

    const second = await h.session.submit(
      { kind: "run", text: "two", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy2.emit,
    );
    expect(second.kind).toBe("started");
    if (second.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    h.fakes[1]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await second.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});

describe("ClaudeSession — ! prefix interrupt", () => {
  it("interrupt_and_run in idle is equivalent to run", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "interrupt_and_run", text: "urgent", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    expect(outcome.kind).toBe("started");
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(1);
    expect(h.session._testGetState()).toBe("generating");
  });

  it("interrupt_and_run in generating: drops queue, interrupts turn, runs new input next", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spy3 = new SpyRenderer();
    const spyBang = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      { kind: "run", text: "two", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy2.emit,
    );
    const third = await h.session.submit(
      { kind: "run", text: "three", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy3.emit,
    );
    if (
      first.kind !== "started" ||
      second.kind !== "queued" ||
      third.kind !== "queued"
    ) {
      throw new Error("unreachable");
    }

    // Fire the bang.
    const bang = await h.session.submit(
      { kind: "interrupt_and_run", text: "urgent", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spyBang.emit,
    );
    expect(bang.kind).toBe("started");
    expect(h.fakes[0]!.interrupted).toBe(true);

    // Previously-queued inputs are rejected with bang_prefix.
    expect(spy2.events).toContainEqual({
      type: "interrupted",
      reason: "bang_prefix",
    });
    expect(spy3.events).toContainEqual({
      type: "interrupted",
      reason: "bang_prefix",
    });
    await expect(second.done).rejects.toThrow(/bang_prefix|interrupted/i);
    await expect(third.done).rejects.toThrow(/bang_prefix|interrupted/i);

    // First turn's iterator drains (interrupted) → first.done rejects.
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();

    // Next turn is the bang input.
    expect(h.fakes).toHaveLength(2);
    h.fakes[1]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "urgent reply" }] },
    });
    h.fakes[1]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    if (bang.kind !== "started") throw new Error("unreachable");
    await bang.done;

    expect(
      spyBang.events.some(
        (e) => e.type === "text" && e.text === "urgent reply",
      ),
    ).toBe(true);
    expect(h.session._testGetState()).toBe("idle");
  });

  it("interrupt_and_run on top of another interrupt_and_run replaces the new input", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spyBang1 = new SpyRenderer();
    const spyBang2 = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy1.emit,
    );
    await flushMicrotasks();

    const bang1 = await h.session.submit(
      { kind: "interrupt_and_run", text: "bang1", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spyBang1.emit,
    );
    const bang2 = await h.session.submit(
      { kind: "interrupt_and_run", text: "bang2", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spyBang2.emit,
    );
    if (
      first.kind !== "started" ||
      bang1.kind !== "started" ||
      bang2.kind !== "started"
    ) {
      throw new Error("unreachable");
    }

    // bang1 was dropped by bang2 (since it was queued when bang2 arrived).
    await expect(bang1.done).rejects.toThrow(/bang_prefix|interrupted/i);
    expect(spyBang1.events).toContainEqual({
      type: "interrupted",
      reason: "bang_prefix",
    });

    // The in-flight first turn was interrupted by whichever bang landed first.
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();

    // Turn 2 runs bang2.
    h.fakes[1]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "bang2 reply" }] },
    });
    h.fakes[1]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await bang2.done;
    expect(
      spyBang2.events.some(
        (e) => e.type === "text" && e.text === "bang2 reply",
      ),
    ).toBe(true);
  });
});

describe("ClaudeSession — sessionAcceptEditsSticky", () => {
  it("runTurn uses acceptEdits when sessionAcceptEditsSticky is set", async () => {
    const recorded: Array<{ permissionMode: string }> = [];
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      recorded.push({ permissionMode: params.options.permissionMode });
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    // Manually set the sticky flag via a test seam (added below).
    session._testSetSessionAcceptEditsSticky(true);

    const outcome = await session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_test",
        parentMessageId: "om_test",
        locale: "zh",
      },
      new SpyRenderer().emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    fakes[0]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;

    expect(recorded[0]!.permissionMode).toBe("acceptEdits");
  });
});

describe("ClaudeSession — canUseTool bridging via PermissionBroker", () => {
  function makeBrokerHarness(): Harness & {
    broker: FakePermissionBroker;
    questionBroker: FakeQuestionBroker;
  } {
    const broker = new FakePermissionBroker();
    const questionBroker = new FakeQuestionBroker();
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const clock = new FakeClock();
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock,
      permissionBroker: broker,
      questionBroker,
      logger: SILENT_LOGGER,
    });
    return { session, fakes, queryFn, clock, broker, questionBroker };
  }

  it("canUseTool → broker.request is called with the correct fields", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    const p = fake.invokeCanUseTool("Bash", { command: "ls" });
    await flushMicrotasks();
    expect(h.broker.requests).toHaveLength(1);
    expect(h.broker.requests[0]).toMatchObject({
      toolName: "Bash",
      input: { command: "ls" },
      chatId: "oc_x",
      ownerOpenId: "ou_alice",
      parentMessageId: "om_root_1",
    });
    h.broker.fakeResolve({ behavior: "allow" });
    expect(await p).toEqual({ behavior: "allow" });

    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("canUseTool short-circuits mcp__feishu__* tools without hitting the broker", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    // Claude calling our in-process `ask_user` tool must not go
    // through the permission broker — if it did, we'd pop a permission
    // card on top of the question card.
    const rawInput = { questions: [] };
    const result = await fake.invokeCanUseTool(
      "mcp__feishu__ask_user",
      rawInput,
    );
    expect(result).toEqual({ behavior: "allow", updatedInput: rawInput });
    expect(h.broker.requests).toHaveLength(0);
    // State must stay `generating` — no awaiting_permission flip.
    expect(h.session._testGetState()).toBe("generating");

    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("broker deny maps to {deny, message} for the SDK", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    const p = fake.invokeCanUseTool("Bash", {});
    await flushMicrotasks();
    h.broker.fakeResolve({ behavior: "deny", message: "nope" });
    expect(await p).toEqual({ behavior: "deny", message: "nope" });
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("broker allow_turn calls handle.setPermissionMode('acceptEdits') and returns {allow}", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    const p = fake.invokeCanUseTool("Edit", {});
    await flushMicrotasks();
    h.broker.fakeResolve({ behavior: "allow_turn" });
    expect(await p).toEqual({ behavior: "allow" });
    expect(fake.permissionModeChanges).toEqual(["acceptEdits"]);
    expect(h.session._testGetSessionAcceptEditsSticky()).toBe(false);
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("broker allow_session flips sticky and calls setPermissionMode", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    const p = fake.invokeCanUseTool("Edit", {});
    await flushMicrotasks();
    h.broker.fakeResolve({ behavior: "allow_session" });
    expect(await p).toEqual({ behavior: "allow" });
    expect(fake.permissionModeChanges).toEqual(["acceptEdits"]);
    expect(h.session._testGetSessionAcceptEditsSticky()).toBe(true);
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("/stop while awaiting_permission calls broker.cancelAll", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const stopSpy = new SpyRenderer();
    const first = await h.session.submit(
      {
        kind: "run",
        text: "one",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    await flushMicrotasks();
    if (first.kind !== "started") throw new Error("unreachable");
    const fake = h.fakes[0]!;
    const permP = fake.invokeCanUseTool("Bash", {});
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("awaiting_permission");

    await h.session.stop(stopSpy.emit);

    expect(h.broker.cancelCalls).toContain("User issued /stop");
    // `ask_user` might not have been invoked this turn, but the
    // session must still fire `questionBroker.cancelAll` whenever it
    // interrupts a running turn — a pending `ask_user` is not gated on
    // the `awaiting_permission` state.
    expect(h.questionBroker.cancelCalls).toContain("User issued /stop");
    expect(await permP).toMatchObject({ behavior: "deny" });
    expect(fake.interrupted).toBe(true);
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");
    expect(stopSpy.events).toEqual([{ type: "stop_ack" }]);
  });

  it("/stop with a pending ask_user resolves the question with cancelled", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const stopSpy = new SpyRenderer();
    const first = await h.session.submit(
      {
        kind: "run",
        text: "one",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    await flushMicrotasks();
    if (first.kind !== "started") throw new Error("unreachable");

    // Simulate Claude calling `ask_user` by directly exercising the
    // question broker the session handed to its per-turn MCP server.
    const qPromise = h.questionBroker.request({
      questions: [
        {
          question: "Pick one",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
          multiSelect: false,
        },
      ],
      chatId: "oc_x",
      ownerOpenId: "ou_alice",
      parentMessageId: "om_root_1",
      locale: "zh",
    });
    expect(h.questionBroker.pendingCount()).toBe(1);

    await h.session.stop(stopSpy.emit);

    expect(h.questionBroker.cancelCalls).toContain("User issued /stop");
    await expect(qPromise).resolves.toMatchObject({
      kind: "cancelled",
      reason: "User issued /stop",
    });
    await expect(first.done).rejects.toThrow();
  });

  it("! prefix while awaiting_permission calls cancelAll, drops queue, runs new input", async () => {
    const h = makeBrokerHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spyBang = new SpyRenderer();
    const first = await h.session.submit(
      {
        kind: "run",
        text: "one",
        senderOpenId: "ou_a",
        parentMessageId: "om_1",
        locale: "zh",
      },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      {
        kind: "run",
        text: "two",
        senderOpenId: "ou_a",
        parentMessageId: "om_2",
        locale: "zh",
      },
      spy2.emit,
    );
    if (first.kind !== "started" || second.kind !== "queued") {
      throw new Error("unreachable");
    }
    const fake = h.fakes[0]!;
    const permP = fake.invokeCanUseTool("Bash", {});
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("awaiting_permission");

    const bang = await h.session.submit(
      {
        kind: "interrupt_and_run",
        text: "urgent",
        senderOpenId: "ou_a",
        parentMessageId: "om_3",
        locale: "zh",
      },
      spyBang.emit,
    );
    if (bang.kind !== "started") throw new Error("unreachable");

    expect(h.broker.cancelCalls).toContain("User sent ! prefix");
    expect(await permP).toMatchObject({ behavior: "deny" });
    await expect(second.done).rejects.toThrow(/bang_prefix|interrupted/i);
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();

    expect(h.fakes).toHaveLength(2);
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await bang.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});

describe("Session runtime overrides + stats", () => {
  it("getState() returns idle initially", () => {
    const h = makeHarness();
    expect(h.session.getState()).toBe("idle");
  });

  it("setPermissionModeOverride causes processLoop to use the override", async () => {
    const h = makeHarness();
    h.session.setPermissionModeOverride("plan");
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    expect(fake.options.permissionMode).toBe("plan");
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("setPermissionModeOverride('acceptEdits') sets sessionAcceptEditsSticky", () => {
    const h = makeHarness();
    h.session.setPermissionModeOverride("acceptEdits");
    expect(h.session._testGetSessionAcceptEditsSticky()).toBe(true);
  });

  it("setPermissionModeOverride('default') clears sessionAcceptEditsSticky", () => {
    const h = makeHarness();
    h.session._testSetSessionAcceptEditsSticky(true);
    h.session.setPermissionModeOverride("default");
    expect(h.session._testGetSessionAcceptEditsSticky()).toBe(false);
  });

  it("setModelOverride causes processLoop to use the override", async () => {
    const h = makeHarness();
    h.session.setModelOverride("claude-sonnet-4-6");
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    expect(fake.options.model).toBe("claude-sonnet-4-6");
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 10, outputTokens: 20 });
    await outcome.done;
  });

  it("getStatus() returns correct initial values", () => {
    const h = makeHarness();
    const status = h.session.getStatus();
    expect(status.provider).toBe("claude");
    expect(status.providerSessionId).toBeUndefined();
    expect(status.state).toBe("idle");
    expect(status.turnCount).toBe(0);
    expect(status.totalInputTokens).toBe(0);
    expect(status.totalOutputTokens).toBe(0);
    expect(status.queueLength).toBe(0);
  });

  it("turnCount and token counters accumulate after a turn", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
        locale: "zh",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    h.fakes[0]!.finishWithSuccess({
      durationMs: 100,
      inputTokens: 500,
      outputTokens: 1200,
    });
    await outcome.done;
    const status = h.session.getStatus();
    expect(status.turnCount).toBe(1);
    expect(status.totalInputTokens).toBe(500);
    expect(status.totalOutputTokens).toBe(1200);
  });
});

describe("ClaudeSession — providerSessionId capture and resume", () => {
  it("captures session_id from the first SDK message that carries it", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    // Message without session_id — should not capture
    fake.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    await flushMicrotasks();
    expect(h.session.getStatus().providerSessionId).toBeUndefined();

    // Message with session_id — should capture
    fake.emitMessage({
      type: "assistant",
      session_id: "ses_abc123",
      message: { content: [{ type: "text", text: "world" }] },
    });
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;

    expect(h.session.getStatus().providerSessionId).toBe("ses_abc123");
  });

  it("does not overwrite session_id once captured", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    fake.emitMessage({
      type: "assistant",
      session_id: "ses_first",
      message: { content: [{ type: "text", text: "first" }] },
    });
    fake.emitMessage({
      type: "assistant",
      session_id: "ses_second",
      message: { content: [{ type: "text", text: "second" }] },
    });
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;

    expect(h.session.getStatus().providerSessionId).toBe("ses_first");
  });

  it("fires onSessionIdCaptured callback once on first capture", async () => {
    let captureCount = 0;
    const h = makeHarness({ onSessionIdCaptured: () => { captureCount++; } });
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    fake.emitMessage({
      type: "assistant",
      session_id: "ses_abc",
      message: { content: [{ type: "text", text: "first" }] },
    });
    fake.emitMessage({
      type: "assistant",
      session_id: "ses_abc",
      message: { content: [{ type: "text", text: "second" }] },
    });
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;

    expect(captureCount).toBe(1);
  });

  it("passes resumeId to queryFn when providerSessionId is set", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    // Turn 1: emit a message with session_id
    const first = await h.session.submit(
      { kind: "run", text: "turn1", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (first.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    h.fakes[0]!.emitMessage({
      type: "assistant",
      session_id: "ses_resume",
      message: { content: [{ type: "text", text: "reply" }] },
    });
    h.fakes[0]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await first.done;

    // Turn 2: should pass resume
    const second = await h.session.submit(
      { kind: "run", text: "turn2", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (second.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    expect(h.fakes[1]!.options.resumeId).toBe("ses_resume");

    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await second.done;
  });

  it("does not pass resumeId when providerSessionId is not yet captured", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test", locale: "zh" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();

    expect(h.fakes[0]!.options.resumeId).toBeUndefined();

    h.fakes[0]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });
});

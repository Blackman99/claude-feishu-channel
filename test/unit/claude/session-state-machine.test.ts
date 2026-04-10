import { describe, it, expect } from "vitest";
import {
  ClaudeSession,
  type ClaudeSessionOptions,
} from "../../../src/claude/session.js";
import { FakeQueryHandle } from "./fakes/fake-query-handle.js";
import { SpyRenderer } from "./fakes/spy-renderer.js";
import { NullPermissionBroker } from "../../../src/claude/permission-broker.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import type { QueryFn, QueryHandle } from "../../../src/claude/query-handle.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
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
function makeHarness(): Harness {
  const fakes: FakeQueryHandle[] = [];
  const queryFn: QueryFn = () => {
    const fake = new FakeQueryHandle();
    fakes.push(fake);
    return fake as QueryHandle;
  };
  const clock = new FakeClock();
  const opts: ClaudeSessionOptions = {
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    clock,
    permissionBroker: new NullPermissionBroker(),
    logger: SILENT_LOGGER,
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
      { kind: "run", text: "hello" },
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
      { kind: "run", text: "hi" },
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

  it("passes cwd / model / permissionMode / settingSources to the injected queryFn", async () => {
    const recorded: Array<{ prompt: string; options: unknown }> = [];
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      recorded.push({ prompt: params.prompt, options: params.options });
      const fake = new FakeQueryHandle();
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new NullPermissionBroker(),
      logger: SILENT_LOGGER,
    });
    const spy = new SpyRenderer();
    const outcome = await session.submit(
      { kind: "run", text: "hi" },
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
    expect(recorded[0]!.options).toEqual({
      cwd: "/tmp/cfc-test",
      model: "claude-opus-4-6",
      permissionMode: "default",
      settingSources: ["project"],
    });
  });

  it("rejects the per-input `done` promise when the turn ends with subtype=error", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "boom" },
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
      { kind: "run", text: "incomplete" },
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
      { kind: "run", text: "one" },
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
      { kind: "run", text: "two" },
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
      { kind: "run", text: "one" },
      spy1.emit,
    );
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(1);
    expect(first.kind).toBe("started");

    const second = await h.session.submit(
      { kind: "run", text: "two" },
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
      { kind: "run", text: "one" },
      spy1.emit,
    );
    await flushMicrotasks();
    await h.session.submit({ kind: "run", text: "two" }, spy2.emit);
    const third = await h.session.submit(
      { kind: "run", text: "three" },
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
      { kind: "run", text: "one" },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      { kind: "run", text: "two" },
      spy2.emit,
    );
    const third = await h.session.submit(
      { kind: "run", text: "three" },
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
      { kind: "run", text: "bad" },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      { kind: "run", text: "good" },
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
    expect(spy.events).toEqual([{ type: "text", text: "🛑 已停止" }]);
  });

  it("stop in generating interrupts the current turn, clears the queue, and returns to idle", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const stopSpy = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one" },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      { kind: "run", text: "two" },
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
    expect(stopSpy.events).toEqual([{ type: "text", text: "🛑 已停止" }]);
  });

  it("two /stop calls in a row are idempotent — second is a no-op ack", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    await h.session.stop(spy.emit);
    await h.session.stop(spy.emit);
    expect(h.session._testGetState()).toBe("idle");
    expect(spy.events).toEqual([
      { type: "text", text: "🛑 已停止" },
      { type: "text", text: "🛑 已停止" },
    ]);
  });

  it("stop during generating does NOT lose subsequently-submitted inputs", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const stopSpy = new SpyRenderer();
    const spy2 = new SpyRenderer();

    const first = await h.session.submit(
      { kind: "run", text: "one" },
      spy1.emit,
    );
    if (first.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    await h.session.stop(stopSpy.emit);
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");

    const second = await h.session.submit(
      { kind: "run", text: "two" },
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

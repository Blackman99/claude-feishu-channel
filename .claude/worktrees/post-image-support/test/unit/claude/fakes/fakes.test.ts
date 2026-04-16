import { describe, it, expect } from "vitest";
import { FakeQueryHandle } from "./fake-query-handle.js";
import { SpyRenderer } from "./spy-renderer.js";
import type { SDKMessageLike } from "../../../../src/claude/session.js";

describe("FakeQueryHandle", () => {
  it("yields emitted messages in order to the consumer", async () => {
    const fake = new FakeQueryHandle();
    const consumed: SDKMessageLike[] = [];
    const consumer = (async () => {
      for await (const m of fake.messages) consumed.push(m);
    })();

    fake.emitMessage({ type: "system", subtype: "init" });
    fake.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    fake.finishWithSuccess({
      result: "hi",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
    });

    await consumer;
    expect(consumed).toHaveLength(3);
    expect(consumed[0]).toEqual({ type: "system", subtype: "init" });
    expect(consumed[2]?.type).toBe("result");
  });

  it("interrupt() marks the handle as interrupted and ends the iterator", async () => {
    const fake = new FakeQueryHandle();
    const consumed: SDKMessageLike[] = [];
    const consumer = (async () => {
      for await (const m of fake.messages) consumed.push(m);
    })();

    fake.emitMessage({ type: "system", subtype: "init" });
    await fake.interrupt();

    await consumer;
    expect(fake.interrupted).toBe(true);
    expect(consumed).toHaveLength(1);
  });

  it("interrupt() is idempotent — second call is a no-op that still resolves", async () => {
    const fake = new FakeQueryHandle();
    const consumer = (async () => {
      for await (const _ of fake.messages) {
        /* drain */
      }
    })();
    await fake.interrupt();
    await fake.interrupt();
    await consumer;
    expect(fake.interrupted).toBe(true);
  });

  it("finishWithError yields a result message with subtype=error", async () => {
    const fake = new FakeQueryHandle();
    const consumed: SDKMessageLike[] = [];
    const consumer = (async () => {
      for await (const m of fake.messages) consumed.push(m);
    })();
    fake.finishWithError({
      subtype: "error_during_execution",
      errors: ["boom"],
    });
    await consumer;
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      errors: ["boom"],
    });
  });
});

describe("SpyRenderer", () => {
  it("records emitted events in order", async () => {
    const spy = new SpyRenderer();
    await spy.emit({ type: "text", text: "one" });
    await spy.emit({ type: "text", text: "two" });
    expect(spy.events).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
  });

  it("failNextEmitWith makes the next emit reject, then behaves normally", async () => {
    const spy = new SpyRenderer();
    spy.failNextEmitWith(new Error("render boom"));
    await expect(spy.emit({ type: "text", text: "x" })).rejects.toThrow(
      /render boom/,
    );
    // Subsequent emits work normally.
    await spy.emit({ type: "text", text: "y" });
    expect(spy.events).toEqual([{ type: "text", text: "y" }]);
  });
});

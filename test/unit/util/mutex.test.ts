import { describe, it, expect } from "vitest";
import { Mutex } from "../../../src/util/mutex.js";
import { createDeferred } from "../../../src/util/deferred.js";

describe("Mutex", () => {
  it("runs a single task immediately", async () => {
    const mutex = new Mutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  it("serializes concurrent tasks in submission order", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const taskA = mutex.run(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
    });
    const taskB = mutex.run(async () => {
      order.push(3);
    });

    await Promise.all([taskA, taskB]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("propagates task errors to the caller", async () => {
    const mutex = new Mutex();
    await expect(
      mutex.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("continues running subsequent tasks after one throws", async () => {
    const mutex = new Mutex();
    await mutex.run(async () => {
      throw new Error("first");
    }).catch(() => {});
    const result = await mutex.run(async () => "second");
    expect(result).toBe("second");
  });

  it("third task waits for first two in order", async () => {
    const mutex = new Mutex();
    const d1 = createDeferred<void>();
    const d2 = createDeferred<void>();
    const order: string[] = [];

    const t1 = mutex.run(async () => {
      order.push("t1-start");
      await d1.promise;
      order.push("t1-end");
    });
    const t2 = mutex.run(async () => {
      order.push("t2-start");
      await d2.promise;
      order.push("t2-end");
    });
    const t3 = mutex.run(async () => {
      order.push("t3");
    });

    // t1 is running, t2 and t3 are queued
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["t1-start"]);

    d1.resolve();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["t1-start", "t1-end", "t2-start"]);

    d2.resolve();
    await Promise.all([t1, t2, t3]);
    expect(order).toEqual(["t1-start", "t1-end", "t2-start", "t2-end", "t3"]);
  });
});

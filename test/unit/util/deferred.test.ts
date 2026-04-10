import { describe, it, expect } from "vitest";
import { createDeferred } from "../../../src/util/deferred.js";

describe("createDeferred", () => {
  it("resolves with the given value", async () => {
    const d = createDeferred<number>();
    d.resolve(42);
    await expect(d.promise).resolves.toBe(42);
  });

  it("rejects with the given error", async () => {
    const d = createDeferred<number>();
    const err = new Error("boom");
    d.reject(err);
    await expect(d.promise).rejects.toBe(err);
  });

  it("exposes settled flag after resolve", async () => {
    const d = createDeferred<string>();
    expect(d.settled).toBe(false);
    d.resolve("ok");
    await d.promise;
    expect(d.settled).toBe(true);
  });

  it("exposes settled flag after reject", async () => {
    const d = createDeferred<string>();
    expect(d.settled).toBe(false);
    d.reject(new Error("x"));
    await d.promise.catch(() => {});
    expect(d.settled).toBe(true);
  });

  it("second resolve is ignored", async () => {
    const d = createDeferred<number>();
    d.resolve(1);
    d.resolve(2);
    await expect(d.promise).resolves.toBe(1);
  });
});

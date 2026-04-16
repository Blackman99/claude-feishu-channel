import { describe, it, expect, vi } from "vitest";
import { RealClock, FakeClock } from "../../../src/util/clock.js";

describe("RealClock", () => {
  it("now() returns a value close to Date.now()", () => {
    const clock = new RealClock();
    const before = Date.now();
    const value = clock.now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it("setTimeout fires after real delay", async () => {
    const clock = new RealClock();
    const fn = vi.fn();
    clock.setTimeout(fn, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("clearTimeout cancels a pending timeout", async () => {
    const clock = new RealClock();
    const fn = vi.fn();
    const handle = clock.setTimeout(fn, 10);
    clock.clearTimeout(handle);
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("FakeClock", () => {
  it("now() starts at the given value", () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it("advance() moves time forward", () => {
    const clock = new FakeClock(0);
    clock.advance(500);
    expect(clock.now()).toBe(500);
  });

  it("advance() fires pending timeouts whose deadline was reached", () => {
    const clock = new FakeClock(0);
    const fn = vi.fn();
    clock.setTimeout(fn, 100);
    clock.advance(50);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(50);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("advance() fires multiple timeouts in scheduled order", () => {
    const clock = new FakeClock(0);
    const order: number[] = [];
    clock.setTimeout(() => order.push(2), 200);
    clock.setTimeout(() => order.push(1), 100);
    clock.advance(300);
    expect(order).toEqual([1, 2]);
  });

  it("clearTimeout prevents a pending callback from firing", () => {
    const clock = new FakeClock(0);
    const fn = vi.fn();
    const handle = clock.setTimeout(fn, 100);
    clock.clearTimeout(handle);
    clock.advance(200);
    expect(fn).not.toHaveBeenCalled();
  });
});

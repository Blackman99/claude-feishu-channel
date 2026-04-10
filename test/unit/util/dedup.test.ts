import { describe, it, expect } from "vitest";
import { LruDedup } from "../../../src/util/dedup.js";

describe("LruDedup", () => {
  it("reports a new id as not seen", () => {
    const dedup = new LruDedup(10);
    expect(dedup.check("id-1")).toBe(false);
  });

  it("reports a previously seen id as seen", () => {
    const dedup = new LruDedup(10);
    dedup.check("id-1");
    expect(dedup.check("id-1")).toBe(true);
  });

  it("evicts the oldest id when capacity is exceeded", () => {
    const dedup = new LruDedup(3);
    dedup.check("a");
    dedup.check("b");
    dedup.check("c");
    dedup.check("d"); // evicts "a"
    expect(dedup.check("a")).toBe(false); // re-inserted as fresh, evicts "b"
    expect(dedup.check("b")).toBe(false); // "b" was evicted when "a" was re-inserted
  });

  it("re-seeing an id promotes it (LRU)", () => {
    const dedup = new LruDedup(3);
    dedup.check("a");
    dedup.check("b");
    dedup.check("a"); // promotes a
    dedup.check("c");
    dedup.check("d"); // evicts b (not a)
    expect(dedup.check("a")).toBe(true);
    expect(dedup.check("b")).toBe(false);
  });

  it("size() returns current entry count", () => {
    const dedup = new LruDedup(10);
    expect(dedup.size()).toBe(0);
    dedup.check("a");
    dedup.check("b");
    expect(dedup.size()).toBe(2);
    dedup.check("a"); // re-promote, no growth
    expect(dedup.size()).toBe(2);
  });
});

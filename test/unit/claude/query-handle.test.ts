import { describe, it, expect } from "vitest";
import type { QueryHandle, QueryFn } from "../../../src/claude/query-handle.js";

describe("QueryHandle shape", () => {
  it("is a plain object with .messages AsyncIterable and .interrupt() method", () => {
    // Smoke test — if the types don't compile, this file fails at build time.
    // The runtime assertion is just that we can construct a handle literal
    // without the test importing `session.ts` (the circular import that
    // used to exist in Phase 3 when QueryFn was declared there).
    const handle: QueryHandle = {
      messages: (async function* () {})(),
      interrupt: async () => {},
    };
    expect(typeof handle.interrupt).toBe("function");
    expect(Symbol.asyncIterator in handle.messages).toBe(true);
  });

  it("QueryFn is a function returning a QueryHandle", () => {
    const fn: QueryFn = () => ({
      messages: (async function* () {})(),
      interrupt: async () => {},
    });
    const h = fn({
      prompt: "x",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
    });
    expect(typeof h.interrupt).toBe("function");
  });
});

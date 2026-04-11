import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSdkQueryFn } from "../../../src/claude/sdk-query.js";
import { createLogger } from "../../../src/util/logger.js";
import type { CanUseToolFn } from "../../../src/claude/query-handle.js";

const SILENT = createLogger({ level: "error", pretty: false });

// Mock the SDK module. The factory must return a `query` export that
// tests can inspect and drive.
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const setPermissionMode = vi.fn<(mode: string) => void>();
  const abortMocks: AbortController[] = [];
  const sessions: Array<{
    prompt: string;
    options: Record<string, unknown>;
    setPermissionMode: typeof setPermissionMode;
    pending: Array<{ msg: unknown } | { end: true }>;
    resolveNext?: (v: IteratorResult<unknown>) => void;
  }> = [];

  const query = vi.fn((params: { prompt: string; options: Record<string, unknown> }) => {
    const session: {
      prompt: string;
      options: Record<string, unknown>;
      setPermissionMode: typeof setPermissionMode;
      pending: Array<{ msg: unknown } | { end: true }>;
      resolveNext?: (v: IteratorResult<unknown>) => void;
    } = {
      prompt: params.prompt,
      options: params.options,
      setPermissionMode,
      pending: [],
    };
    sessions.push(session);
    if (params.options["abortController"] instanceof AbortController) {
      abortMocks.push(params.options["abortController"] as AbortController);
    }

    const iterator: AsyncIterator<unknown> = {
      next: async () => {
        const head = session.pending.shift();
        if (head) {
          if ("end" in head) return { value: undefined, done: true };
          return { value: head.msg, done: false };
        }
        return new Promise<IteratorResult<unknown>>((resolve) => {
          session.resolveNext = resolve;
        });
      },
    };

    const q: AsyncIterable<unknown> & {
      setPermissionMode: (m: string) => void;
    } = {
      [Symbol.asyncIterator]: () => iterator,
      setPermissionMode,
    };
    return q;
  });

  return {
    query,
    __testAccess: { sessions, abortMocks, setPermissionMode },
  };
});

// Import after vi.mock so vitest hoisting gives us the mock
import * as sdkMod from "@anthropic-ai/claude-agent-sdk";

type TestSession = {
  prompt: string;
  options: Record<string, unknown>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  pending: Array<{ msg: unknown } | { end: true }>;
  resolveNext: ((v: IteratorResult<unknown>) => void) | undefined;
};

type TestAccess = {
  sessions: TestSession[];
  abortMocks: AbortController[];
  setPermissionMode: ReturnType<typeof vi.fn>;
};

const __testAccess = (sdkMod as unknown as { __testAccess: TestAccess }).__testAccess;
const mockedQuery = sdkMod.query as ReturnType<typeof vi.fn>;

const noopCanUseTool: CanUseToolFn = async () => ({ behavior: "allow" });

beforeEach(() => {
  __testAccess.sessions.length = 0;
  __testAccess.abortMocks.length = 0;
  __testAccess.setPermissionMode.mockClear();
  mockedQuery.mockClear();
});

describe("createSdkQueryFn", () => {
  it("passes prompt, options, canUseTool, and pathToClaudeCodeExecutable through to query()", () => {
    const fn = createSdkQueryFn({ cliPath: "/usr/bin/claude", logger: SILENT });
    fn({
      prompt: "hello",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });
    expect(__testAccess.sessions).toHaveLength(1);
    const s = __testAccess.sessions[0]!;
    expect(s.prompt).toBe("hello");
    expect(s.options["cwd"]).toBe("/tmp");
    expect(s.options["model"]).toBe("claude-opus-4-6");
    expect(s.options["permissionMode"]).toBe("default");
    expect(s.options["settingSources"]).toEqual(["project"]);
    expect(s.options["canUseTool"]).toBe(noopCanUseTool);
    expect(s.options["pathToClaudeCodeExecutable"]).toBe("/usr/bin/claude");
    expect(s.options["abortController"]).toBeInstanceOf(AbortController);
  });

  it("yields messages from the SDK iterator", async () => {
    const fn = createSdkQueryFn({ cliPath: "claude", logger: SILENT });
    const handle = fn({
      prompt: "hi",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });
    const s = __testAccess.sessions[0]!;
    s.pending.push({ msg: { type: "assistant" } });
    s.pending.push({ msg: { type: "result", subtype: "success" } });
    s.pending.push({ end: true });

    const got: unknown[] = [];
    for await (const msg of handle.messages) got.push(msg);
    expect(got).toEqual([
      { type: "assistant" },
      { type: "result", subtype: "success" },
    ]);
  });

  it("interrupt() aborts the underlying controller and is idempotent", async () => {
    const fn = createSdkQueryFn({ cliPath: "claude", logger: SILENT });
    const handle = fn({
      prompt: "hi",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });
    await handle.interrupt();
    await handle.interrupt();
    expect(__testAccess.abortMocks[0]!.signal.aborted).toBe(true);
  });

  it("setPermissionMode forwards to the SDK query object", () => {
    const fn = createSdkQueryFn({ cliPath: "claude", logger: SILENT });
    const handle = fn({
      prompt: "hi",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });
    handle.setPermissionMode("acceptEdits");
    expect(__testAccess.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
  });
});

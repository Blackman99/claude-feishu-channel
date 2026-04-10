import { describe, it, expect, vi } from "vitest";
import { ClaudeSession, type QueryFn, type SDKMessageLike } from "../../../src/claude/session.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
};

function fakeQueryReturning(msgs: SDKMessageLike[]): QueryFn {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m;
    },
  });
}

describe("ClaudeSession", () => {
  it("returns concatenated assistant text on a successful turn", async () => {
    const queryFn = fakeQueryReturning([
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello from Claude" }] },
      },
      { type: "result", subtype: "success", result: "hello from Claude" },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    const reply = await session.handleMessage("hi");
    expect(reply).toBe("hello from Claude");
  });

  it("joins multiple assistant messages", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "part one" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "part two" }] },
      },
      { type: "result", subtype: "success", result: "ignored" },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    expect(await session.handleMessage("hi")).toBe("part one\npart two");
  });

  it("ignores assistant messages that have no text (tool_use only)", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "final answer" }] },
      },
      { type: "result", subtype: "success", result: "final answer" },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    expect(await session.handleMessage("hi")).toBe("final answer");
  });

  it("throws when the result is an error subtype", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom", "kaboom"],
      },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    await expect(session.handleMessage("hi")).rejects.toThrow(/boom.*kaboom/);
  });

  it("throws when the iterator ends without a result", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "oops" }] },
      },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    await expect(session.handleMessage("hi")).rejects.toThrow(/without a result/);
  });

  it("passes cwd, model, permissionMode, and settingSources to queryFn", async () => {
    const queryFn = vi.fn<QueryFn>(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "ok" }] },
        } satisfies SDKMessageLike;
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
        } satisfies SDKMessageLike;
      },
    }));
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: {
        defaultCwd: "/a/b",
        defaultPermissionMode: "acceptEdits",
        defaultModel: "claude-sonnet-4-6",
      },
      queryFn,
      logger: SILENT_LOGGER,
    });
    await session.handleMessage("hi");
    expect(queryFn).toHaveBeenCalledOnce();
    const call = queryFn.mock.calls[0]![0];
    expect(call.prompt).toBe("hi");
    expect(call.options.cwd).toBe("/a/b");
    expect(call.options.model).toBe("claude-sonnet-4-6");
    expect(call.options.permissionMode).toBe("acceptEdits");
    expect(call.options.settingSources).toEqual(["project"]);
  });

  it("serializes concurrent handleMessage calls via the mutex", async () => {
    const events: string[] = [];
    let release1!: () => void;
    const gate1 = new Promise<void>((r) => (release1 = r));
    let callCount = 0;
    const queryFn: QueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        callCount += 1;
        const label = callCount === 1 ? "A" : "B";
        events.push(`${label}:start`);
        if (label === "A") await gate1;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: label }] },
        } as SDKMessageLike;
        yield {
          type: "result",
          subtype: "success",
          result: label,
        } as SDKMessageLike;
        events.push(`${label}:end`);
      },
    });
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    const p1 = session.handleMessage("first");
    const p2 = session.handleMessage("second");
    // Give the event loop a chance to let p2 race past if the mutex weren't there.
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["A:start"]);
    release1();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });
});

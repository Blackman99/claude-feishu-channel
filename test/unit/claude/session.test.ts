import { describe, it, expect, vi } from "vitest";
import {
  ClaudeSession,
  type QueryFn,
  type SDKMessageLike,
} from "../../../src/claude/session.js";
import type { RenderEvent } from "../../../src/claude/render-event.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
};

function fakeQueryReturning(msgs: SDKMessageLike[]): QueryFn {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m;
    },
  });
}

function collectEvents(
  queryFn: QueryFn,
  prompt = "hi",
): { session: ClaudeSession; run: () => Promise<RenderEvent[]> } {
  const session = new ClaudeSession({
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    logger: SILENT_LOGGER,
  });
  const run = async (): Promise<RenderEvent[]> => {
    const events: RenderEvent[] = [];
    await session.handleMessage(prompt, async (e) => {
      events.push(e);
    });
    return events;
  };
  return { session, run };
}

describe("ClaudeSession", () => {
  it("emits one text event per text block on a successful turn", async () => {
    const queryFn = fakeQueryReturning([
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "part one\npart two",
        duration_ms: 1234,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);
    const { run } = collectEvents(queryFn);
    const events = await run();
    expect(events).toEqual([
      { type: "text", text: "part one" },
      { type: "text", text: "part two" },
      { type: "turn_end", durationMs: 1234, inputTokens: 100, outputTokens: 50 },
    ]);
  });

  it("emits a thinking event with the `thinking` field (not `text`)", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me think...", signature: "sig" },
            { type: "text", text: "answer" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 100,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events).toEqual([
      { type: "thinking", text: "let me think..." },
      { type: "text", text: "answer" },
      { type: "turn_end", durationMs: 100, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("emits a tool_use event with id, name, input", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 50,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events).toContainEqual({
      type: "tool_use",
      id: "tu_1",
      name: "Bash",
      input: { command: "ls" },
    });
  });

  it("emits a tool_result event from a user-type SDK message", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              is_error: false,
              content: "42 files",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 50,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tu_1",
      isError: false,
      text: "42 files",
    });
  });

  it("emits tool_result with isError=true on error flag", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_2",
              is_error: true,
              content: "permission denied",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events.find((e) => e.type === "tool_result")).toEqual({
      type: "tool_result",
      toolUseId: "tu_2",
      isError: true,
      text: "permission denied",
    });
  });

  it("handles tool_result content as an array of blocks", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_3",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events.find((e) => e.type === "tool_result")).toEqual({
      type: "tool_result",
      toolUseId: "tu_3",
      isError: false,
      text: "line 1\nline 2",
    });
  });

  it("throws when result subtype is an error", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom", "kaboom"],
      },
    ]);
    const { run } = collectEvents(queryFn);
    await expect(run()).rejects.toThrow(/boom.*kaboom/);
  });

  it("throws when the iterator ends without a result", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "oops" }] },
      },
    ]);
    const { run } = collectEvents(queryFn);
    await expect(run()).rejects.toThrow(/without a result/);
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
          duration_ms: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
        } satisfies SDKMessageLike;
      },
    }));
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: {
        defaultCwd: "/a/b",
        defaultPermissionMode: "acceptEdits",
        defaultModel: "claude-sonnet-4-6",
        cliPath: "claude",
      },
      queryFn,
      logger: SILENT_LOGGER,
    });
    await session.handleMessage("hi", async () => {});
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
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
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
    const p1 = session.handleMessage("first", async () => {});
    const p2 = session.handleMessage("second", async () => {});
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["A:start"]);
    release1();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("releases the mutex after a throwing turn so the session stays usable", async () => {
    let callCount = 0;
    const queryFn: QueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        callCount += 1;
        if (callCount === 1) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["first turn boom"],
          } satisfies SDKMessageLike;
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "recovered" }] },
        } satisfies SDKMessageLike;
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
        } satisfies SDKMessageLike;
      },
    });
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    await expect(session.handleMessage("first", async () => {})).rejects.toThrow(
      /first turn boom/,
    );
    const events: RenderEvent[] = [];
    await session.handleMessage("second", async (e) => {
      events.push(e);
    });
    expect(events).toContainEqual({ type: "text", text: "recovered" });
    expect(callCount).toBe(2);
  });
});

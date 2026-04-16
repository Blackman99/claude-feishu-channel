import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../src/util/logger.js";
import {
  checkCodexSdkInstalled,
  createCodexQueryFn,
} from "../../../src/codex/sdk-run.js";
import type { CanUseToolFn } from "../../../src/claude/query-handle.js";

const SILENT = createLogger({ level: "error", pretty: false });
const noopCanUseTool: CanUseToolFn = async () => ({ behavior: "allow" });

type FakeEvent = {
  type: string;
  [key: string]: unknown;
};

function makeSdk(events: FakeEvent[], hooks?: {
  threadId?: string | null;
  onCtor?: ReturnType<typeof vi.fn>;
  onStartThread?: ReturnType<typeof vi.fn>;
  onResumeThread?: ReturnType<typeof vi.fn>;
  onRunStreamed?: ReturnType<typeof vi.fn>;
}) {
  const runStreamed = hooks?.onRunStreamed ?? vi.fn(async (_input, _turnOptions) => ({
    events: (async function* () {
      for (const event of events) yield event;
    })(),
  }));
  const thread = {
    id: hooks?.threadId ?? null,
    runStreamed,
  };
  const startThread = hooks?.onStartThread ?? vi.fn(() => thread);
  const resumeThread = hooks?.onResumeThread ?? vi.fn(() => thread);
  const ctor = hooks?.onCtor ?? vi.fn();

  return {
    Codex: class FakeCodex {
      constructor(options?: unknown) {
        void (ctor as (options?: unknown) => unknown)(options);
      }

      startThread(options?: unknown) {
        return (startThread as (options?: unknown) => typeof thread)(options);
      }

      resumeThread(id: string, options?: unknown) {
        return (resumeThread as (id: string, options?: unknown) => typeof thread)(
          id,
          options,
        );
      }
    },
    ctor,
    startThread,
    resumeThread,
    runStreamed,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createCodexQueryFn", () => {
  it("starts or resumes a real Codex thread and maps streamed events into session messages", async () => {
    const sdk = makeSdk(
      [
        { type: "thread.started", thread_id: "thread_abc" },
        {
          type: "item.started",
          item: {
            id: "reason_1",
            type: "reasoning",
            text: "thinking",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "msg_1",
            type: "agent_message",
            text: "codex result",
          },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 12,
            cached_input_tokens: 0,
            output_tokens: 34,
          },
        },
      ],
      { threadId: null },
    );
    const fn = createCodexQueryFn({
      cliPath: "/opt/homebrew/bin/codex",
      logger: SILENT,
      loadSdk: async () => sdk as unknown as typeof import("@openai/codex-sdk"),
    });

    const handle = fn({
      prompt: "hello codex",
      options: {
        cwd: "/tmp/project",
        model: "gpt-5.4",
        permissionMode: "default",
        settingSources: ["project"],
        resumeId: "thread_abc",
      },
      canUseTool: noopCanUseTool,
    });

    const got: unknown[] = [];
    for await (const msg of handle.messages) got.push(msg);

    expect(sdk.ctor).toHaveBeenCalledWith({
      codexPathOverride: "/opt/homebrew/bin/codex",
    });
    expect(sdk.resumeThread).toHaveBeenCalledWith(
      "thread_abc",
      expect.objectContaining({
        model: "gpt-5.4",
        workingDirectory: "/tmp/project",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      }),
    );
    expect(sdk.startThread).not.toHaveBeenCalled();
    expect(sdk.runStreamed).toHaveBeenCalledWith(
      "hello codex",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(got).toEqual([
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "thinking" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "codex result" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "thread_abc",
        usage: {
          input_tokens: 12,
          output_tokens: 34,
        },
      },
    ]);
  });

  it("passes structured run options and aborts via the streamed turn signal", async () => {
    let seenSignal: AbortSignal | undefined;
    const runStreamed = vi.fn(async (_input, turnOptions?: { signal?: AbortSignal }) => {
      seenSignal = turnOptions?.signal;
      return {
        events: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 0));
        })(),
      };
    });
    const sdk = makeSdk([], { onRunStreamed: runStreamed, threadId: "thread_live" });
    const fn = createCodexQueryFn({
      cliPath: "codex",
      logger: SILENT,
      loadSdk: async () => sdk as unknown as typeof import("@openai/codex-sdk"),
    });

    const handle = fn({
      prompt: "hello",
      options: {
        cwd: "/tmp/project",
        model: "gpt-5.4",
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });

    const consume = (async () => {
      for await (const _ of handle.messages) {
        void _;
      }
    })();

    await Promise.resolve();
    await handle.interrupt();
    await consume;

    expect(sdk.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        workingDirectory: "/tmp/project",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      }),
    );
    expect(seenSignal?.aborted).toBe(true);
  });

  it("checks Codex SDK availability through the shared loader helper", async () => {
    const sdk = makeSdk([]);
    await expect(
      checkCodexSdkInstalled(async () => sdk as unknown as typeof import("@openai/codex-sdk")),
    ).resolves.toBeUndefined();
  });

  it("materializes base64 image blocks to local temp files and passes them to Codex", async () => {
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef,
    ]);
    const pngBase64 = pngBytes.toString("base64");

    let capturedInput: unknown;
    const runStreamed = vi.fn(async (input) => {
      capturedInput = input;
      return {
        events: (async function* () {
          yield {
            type: "turn.completed",
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          };
        })(),
      };
    });
    const sdk = makeSdk([], { onRunStreamed: runStreamed, threadId: "thread_img" });
    const fn = createCodexQueryFn({
      cliPath: "codex",
      logger: SILENT,
      loadSdk: async () => sdk as unknown as typeof import("@openai/codex-sdk"),
    });

    const prompt: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: pngBase64 },
              },
              { type: "text", text: "describe this" },
            ],
          },
        };
      },
    };

    const handle = fn({
      prompt: prompt as Parameters<typeof fn>[0]["prompt"],
      options: {
        cwd: "/tmp/project",
        model: "gpt-5.4",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });

    for await (const _ of handle.messages) void _;

    expect(Array.isArray(capturedInput)).toBe(true);
    const arr = capturedInput as Array<
      { type: "local_image"; path: string } | { type: "text"; text: string }
    >;
    expect(arr).toHaveLength(2);
    expect(arr[0]?.type).toBe("local_image");
    expect(arr[1]).toEqual({ type: "text", text: "describe this" });

    const imagePath = (arr[0] as { path: string }).path;
    expect(imagePath.endsWith(".png")).toBe(true);
    // temp dir is cleaned up after the turn completes
    expect(existsSync(path.dirname(imagePath))).toBe(false);
  });

  it("writes correct bytes and extension per MIME, and omits image when base64 source is missing", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const jpegBase64 = jpegBytes.toString("base64");

    let capturedInput: unknown;
    let capturedDuringRun: { path: string; bytes: Buffer } | undefined;
    const runStreamed = vi.fn(async (input) => {
      capturedInput = input;
      // Capture bytes while the temp file still exists (before cleanup runs).
      if (Array.isArray(input)) {
        const img = (input as Array<{ type: string; path?: string }>).find(
          (p) => p.type === "local_image",
        );
        if (img?.path) {
          capturedDuringRun = { path: img.path, bytes: readFileSync(img.path) };
        }
      }
      return {
        events: (async function* () {
          yield {
            type: "turn.completed",
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          };
        })(),
      };
    });
    const sdk = makeSdk([], { onRunStreamed: runStreamed, threadId: "thread_img2" });
    const fn = createCodexQueryFn({
      cliPath: "codex",
      logger: SILENT,
      loadSdk: async () => sdk as unknown as typeof import("@openai/codex-sdk"),
    });

    const prompt: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: jpegBase64 },
              },
              { type: "image" }, // malformed: no source
              { type: "text", text: "two images" },
            ],
          },
        };
      },
    };

    const handle = fn({
      prompt: prompt as Parameters<typeof fn>[0]["prompt"],
      options: {
        cwd: "/tmp/project",
        model: "gpt-5.4",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });

    for await (const _ of handle.messages) void _;

    expect(Array.isArray(capturedInput)).toBe(true);
    const arr = capturedInput as Array<{ type: string; path?: string; text?: string }>;
    expect(arr[0]?.type).toBe("local_image");
    expect((arr[0] as { path: string }).path.endsWith(".jpg")).toBe(true);
    expect(arr[1]).toEqual({
      type: "text",
      text: "[image omitted: missing base64 source]",
    });
    expect(arr[2]).toEqual({ type: "text", text: "two images" });

    expect(capturedDuringRun).toBeDefined();
    expect(capturedDuringRun!.bytes.equals(jpegBytes)).toBe(true);
  });

  it("cleans up temp image files even when the turn fails", async () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

    let capturedImagePath: string | undefined;
    const runStreamed = vi.fn(async (input) => {
      if (Array.isArray(input)) {
        const img = (input as Array<{ type: string; path?: string }>).find(
          (p) => p.type === "local_image",
        );
        capturedImagePath = img?.path;
      }
      return {
        events: (async function* () {
          yield { type: "turn.failed", error: { message: "boom" } };
        })(),
      };
    });
    const sdk = makeSdk([], { onRunStreamed: runStreamed, threadId: "thread_fail" });
    const fn = createCodexQueryFn({
      cliPath: "codex",
      logger: SILENT,
      loadSdk: async () => sdk as unknown as typeof import("@openai/codex-sdk"),
    });

    const prompt: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: pngBase64 },
              },
              { type: "text", text: "describe" },
            ],
          },
        };
      },
    };

    const handle = fn({
      prompt: prompt as Parameters<typeof fn>[0]["prompt"],
      options: {
        cwd: "/tmp/project",
        model: "gpt-5.4",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });

    await expect(
      (async () => {
        for await (const _ of handle.messages) void _;
      })(),
    ).rejects.toThrow(/boom/);

    expect(capturedImagePath).toBeDefined();
    expect(existsSync(path.dirname(capturedImagePath!))).toBe(false);
  });

  it("keeps setPermissionMode as a safe no-op in the current adapter", () => {
    const sdk = makeSdk([]);
    const fn = createCodexQueryFn({
      cliPath: "codex",
      logger: SILENT,
      loadSdk: async () => sdk as unknown as typeof import("@openai/codex-sdk"),
    });

    const handle = fn({
      prompt: "hello",
      options: {
        cwd: "/tmp/project",
        model: "gpt-5.4",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });

    expect(() => handle.setPermissionMode("acceptEdits")).not.toThrow();
  });
});

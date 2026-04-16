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
        model: "gpt-5-codex",
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
        model: "gpt-5-codex",
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
        model: "gpt-5-codex",
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
        model: "gpt-5-codex",
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
        model: "gpt-5-codex",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });

    expect(() => handle.setPermissionMode("acceptEdits")).not.toThrow();
  });
});

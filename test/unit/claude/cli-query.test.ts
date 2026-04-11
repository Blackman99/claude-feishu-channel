import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  createCliQueryFn,
  type SpawnFn,
} from "../../../src/claude/cli-query.js";
import type {
  CanUseToolFn,
  ClaudeQueryOptions,
} from "../../../src/claude/query-handle.js";
import type {
  SDKMessageLike,
} from "../../../src/claude/session.js";
import type { QueryHandle } from "../../../src/claude/query-handle.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_OPTIONS: ClaudeQueryOptions = {
  cwd: "/tmp/cfc-test",
  model: "claude-opus-4-6",
  permissionMode: "bypassPermissions",
  settingSources: ["project"],
};

/**
 * Stub permission callback for tests (Phase 5 transition).
 */
const STUB_CAN_USE_TOOL: CanUseToolFn = async () => ({
  behavior: "deny",
  message: "Permission denied (test stub)",
});

/**
 * A minimal ChildProcess-like fake driven by an in-memory script. The
 * test schedules the script via `setImmediate` so the async iterator
 * in the implementation gets a chance to attach listeners first.
 */
interface FakeChildScript {
  stdoutLines?: readonly string[];
  stderr?: string;
  exitCode?: number | null;
  /** If set, emits this error (ENOENT etc.) instead of running the script. */
  spawnError?: Error;
  /** Delay (ms) between stdout lines — useful for ordering tests. */
  lineDelayMs?: number;
}

function makeFakeChild(script: FakeChildScript): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess & {
    exitCode: number | null;
    killed: boolean;
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ChildProcess["kill"];
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.stdin = stdin;
  emitter.exitCode = null;
  emitter.killed = false;
  emitter.kill = ((_signal?: number | NodeJS.Signals) => {
    emitter.killed = true;
    return true;
  }) as ChildProcess["kill"];

  void (async () => {
    // Yield a microtask so the consumer attaches its listeners.
    await new Promise((r) => setImmediate(r));

    if (script.spawnError) {
      emitter.emit("error", script.spawnError);
      stdout.end();
      stderr.end();
      emitter.exitCode = null;
      emitter.emit("close", null);
      return;
    }

    for (const line of script.stdoutLines ?? []) {
      stdout.write(line + "\n");
      if (script.lineDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, script.lineDelayMs));
      }
    }
    if (script.stderr) {
      stderr.write(script.stderr);
    }
    stdout.end();
    stderr.end();
    const code = script.exitCode ?? 0;
    emitter.exitCode = code;
    emitter.emit("close", code);
  })();

  return emitter;
}

async function collectMessages(
  handle: QueryHandle,
): Promise<SDKMessageLike[]> {
  const out: SDKMessageLike[] = [];
  for await (const msg of handle.messages) out.push(msg);
  return out;
}

describe("createCliQueryFn", () => {
  it("parses NDJSON from stdout into SDKMessageLike values", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 123,
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    ];
    const spawnFn: SpawnFn = vi.fn(() =>
      makeFakeChild({ stdoutLines: lines, exitCode: 0 }),
    );
    const queryFn = createCliQueryFn({
      cliPath: "claude",
      logger: SILENT_LOGGER,
      spawnFn,
    });
    const messages = await collectMessages(
      queryFn({ prompt: "hi", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL }),
    );
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ type: "system", subtype: "init" });
    expect(messages[1]!.type).toBe("assistant");
    expect(messages[2]).toMatchObject({
      type: "result",
      subtype: "success",
      duration_ms: 123,
    });
  });

  it("skips empty and whitespace-only lines", async () => {
    const lines = [
      "",
      "   ",
      JSON.stringify({ type: "result", subtype: "success", duration_ms: 0 }),
      "",
    ];
    const spawnFn: SpawnFn = vi.fn(() =>
      makeFakeChild({ stdoutLines: lines, exitCode: 0 }),
    );
    const queryFn = createCliQueryFn({
      cliPath: "claude",
      logger: SILENT_LOGGER,
      spawnFn,
    });
    const messages = await collectMessages(
      queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("result");
  });

  it("logs a warning and skips malformed JSON lines without aborting", async () => {
    const lines = [
      "{not json",
      JSON.stringify({ type: "result", subtype: "success", duration_ms: 0 }),
    ];
    const warns: unknown[] = [];
    const loggerSpy = {
      ...SILENT_LOGGER,
      warn: (obj: unknown) => warns.push(obj),
    } as unknown as typeof SILENT_LOGGER;
    const spawnFn: SpawnFn = vi.fn(() =>
      makeFakeChild({ stdoutLines: lines, exitCode: 0 }),
    );
    const queryFn = createCliQueryFn({
      cliPath: "claude",
      logger: loggerSpy,
      spawnFn,
    });
    const messages = await collectMessages(
      queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL }),
    );
    expect(messages).toHaveLength(1);
    expect(warns.length).toBe(1);
  });

  it("throws when the CLI exits with a non-zero code, including stderr tail", async () => {
    const spawnFn: SpawnFn = vi.fn(() =>
      makeFakeChild({
        stdoutLines: [],
        stderr: "Error: auth failed\nTry `claude login`\n",
        exitCode: 1,
      }),
    );
    const queryFn = createCliQueryFn({
      cliPath: "claude",
      logger: SILENT_LOGGER,
      spawnFn,
    });
    await expect(
      collectMessages(queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL })),
    ).rejects.toThrow(/exited with code 1.*auth failed/s);
  });

  it("falls back to stdout tail when exit is non-zero and stderr is empty", async () => {
    // Simulates the silent-failure case: CLI dies with no stderr and no
    // result message. We want the error to surface whatever stdout we
    // did see so the failure is debuggable.
    const spawnFn: SpawnFn = vi.fn(() =>
      makeFakeChild({
        stdoutLines: [
          JSON.stringify({ type: "system", subtype: "init" }),
          "some unstructured warning before crash",
        ],
        exitCode: 1,
      }),
    );
    const queryFn = createCliQueryFn({
      cliPath: "claude",
      logger: SILENT_LOGGER,
      spawnFn,
    });
    await expect(
      collectMessages(queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL })),
    ).rejects.toThrow(
      /exited with code 1.*stdout tail.*some unstructured warning before crash/s,
    );
  });

  it("defers to the consumer when a result message was yielded, even if exit is non-zero", async () => {
    // If a `result` message has already been yielded, session.ts will
    // throw its own richer "Claude turn failed (subtype)" error. We must
    // NOT shadow that by throwing our bare "exited with code 1" error —
    // session.ts's post-loop code never runs if we do.
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        errors: ["model refused"],
      }),
    ];
    const warns: unknown[] = [];
    const loggerSpy = {
      ...SILENT_LOGGER,
      warn: (obj: unknown) => warns.push(obj),
    } as unknown as typeof SILENT_LOGGER;
    const spawnFn: SpawnFn = vi.fn(() =>
      makeFakeChild({ stdoutLines: lines, exitCode: 1 }),
    );
    const queryFn = createCliQueryFn({
      cliPath: "claude",
      logger: loggerSpy,
      spawnFn,
    });
    const messages = await collectMessages(
      queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL }),
    );
    // Iterator completes cleanly — all messages delivered, no throw.
    expect(messages).toHaveLength(2);
    expect(messages[1]!.subtype).toBe("error_during_execution");
    // But we logged a warn about the exit mismatch so it's still visible
    // in the logs for debugging.
    expect(warns.length).toBe(1);
  });

  it("throws a clear error when the spawn itself fails (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    });
    const spawnFn: SpawnFn = vi.fn(() => makeFakeChild({ spawnError: err }));
    const queryFn = createCliQueryFn({
      cliPath: "claude",
      logger: SILENT_LOGGER,
      spawnFn,
    });
    await expect(
      collectMessages(queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL })),
    ).rejects.toThrow(/Failed to spawn claude CLI.*ENOENT/);
  });

  it("passes --print --output-format stream-json --verbose and model/mode/sources", async () => {
    let receivedArgs: readonly string[] | undefined;
    let receivedOptions: { cwd?: string } | undefined;
    const spawnFn: SpawnFn = vi.fn((_cmd, args, options) => {
      receivedArgs = args;
      receivedOptions = options as { cwd?: string };
      return makeFakeChild({
        stdoutLines: [
          JSON.stringify({
            type: "result",
            subtype: "success",
            duration_ms: 0,
          }),
        ],
        exitCode: 0,
      });
    });
    const queryFn = createCliQueryFn({
      cliPath: "/usr/local/bin/claude",
      logger: SILENT_LOGGER,
      spawnFn,
    });
    await collectMessages(
      queryFn({
        prompt: "what time is it?",
        options: {
          cwd: "/work/dir",
          model: "claude-sonnet-4-6",
          permissionMode: "acceptEdits",
          settingSources: ["project", "user"],
        },
        canUseTool: STUB_CAN_USE_TOOL,
      }),
    );
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      expect.any(Array),
      expect.objectContaining({ cwd: "/work/dir" }),
    );
    expect(receivedArgs).toContain("--print");
    expect(receivedArgs).toContain("--output-format");
    expect(receivedArgs).toContain("stream-json");
    expect(receivedArgs).toContain("--verbose");
    expect(receivedArgs).toContain("--model");
    expect(receivedArgs).toContain("claude-sonnet-4-6");
    expect(receivedArgs).toContain("--permission-mode");
    expect(receivedArgs).toContain("acceptEdits");
    expect(receivedArgs).toContain("--setting-sources");
    expect(receivedArgs).toContain("project,user");
    expect(receivedOptions?.cwd).toBe("/work/dir");
  });

  it("passes the prompt as the final positional argument (after `--`)", async () => {
    let receivedArgs: readonly string[] | undefined;
    const spawnFn: SpawnFn = vi.fn((_cmd, args) => {
      receivedArgs = args;
      return makeFakeChild({
        stdoutLines: [
          JSON.stringify({
            type: "result",
            subtype: "success",
            duration_ms: 0,
          }),
        ],
        exitCode: 0,
      });
    });
    const queryFn = createCliQueryFn({
      cliPath: "claude",
      logger: SILENT_LOGGER,
      spawnFn,
    });
    const prompt = "--this-looks-like-a-flag but is a prompt";
    await collectMessages(queryFn({ prompt, options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL }));
    expect(receivedArgs).toBeDefined();
    // The prompt must appear after `--` so the CLI cannot parse it as a flag.
    const dashIdx = receivedArgs!.indexOf("--");
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    expect(receivedArgs!.slice(dashIdx + 1)).toEqual([prompt]);
  });

  describe("interrupt()", () => {
    it("sends SIGTERM to the child and resolves after close", async () => {
      // Use a long-running child (lineDelayMs) so we can interrupt mid-stream.
      let killedWithSignal: string | number | undefined;
      const spawnFn: SpawnFn = vi.fn(() => {
        const child = makeFakeChild({
          stdoutLines: [
            JSON.stringify({ type: "system", subtype: "init" }),
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "partial" }] },
            }),
            // This line never gets read because we kill first.
            JSON.stringify({
              type: "result",
              subtype: "success",
              duration_ms: 9999,
            }),
          ],
          lineDelayMs: 50,
          exitCode: 143, // 128 + SIGTERM(15)
        });
        const origKill = child.kill.bind(child);
        child.kill = ((signal?: number | NodeJS.Signals) => {
          killedWithSignal = signal;
          return origKill(signal);
        }) as ChildProcess["kill"];
        return child;
      });
      const queryFn = createCliQueryFn({
        cliPath: "claude",
        logger: SILENT_LOGGER,
        spawnFn,
      });
      const handle = queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL });
      // Start iterating in the background; we interrupt after the first
      // message lands so the generator is mid-loop when interrupt hits.
      const received: SDKMessageLike[] = [];
      const iterPromise = (async () => {
        for await (const m of handle.messages) {
          received.push(m);
          if (received.length === 1) {
            // Interrupt after first message — don't await inside the loop
            // so the kill races with readline.
            void handle.interrupt();
          }
        }
      })();
      await iterPromise;
      expect(killedWithSignal).toBe("SIGTERM");
      // The iterator must have ended without throwing (interrupt swallows
      // the non-zero exit). At minimum we saw the first message.
      expect(received.length).toBeGreaterThanOrEqual(1);
    });

    it("is idempotent — second call is a no-op and still resolves", async () => {
      let killCount = 0;
      const spawnFn: SpawnFn = vi.fn(() => {
        const child = makeFakeChild({
          stdoutLines: [
            JSON.stringify({
              type: "result",
              subtype: "success",
              duration_ms: 0,
            }),
          ],
          lineDelayMs: 20,
          exitCode: 143,
        });
        const origKill = child.kill.bind(child);
        child.kill = ((signal?: number | NodeJS.Signals) => {
          killCount += 1;
          return origKill(signal);
        }) as ChildProcess["kill"];
        return child;
      });
      const queryFn = createCliQueryFn({
        cliPath: "claude",
        logger: SILENT_LOGGER,
        spawnFn,
      });
      const handle = queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL });
      // Start draining so the generator attaches readline.
      const drain = collectMessages(handle).catch(() => {});
      // Fire interrupt twice in rapid succession.
      await Promise.all([handle.interrupt(), handle.interrupt()]);
      await drain;
      // kill() was called at most once — second interrupt short-circuited.
      expect(killCount).toBeLessThanOrEqual(1);
    });

    it("is a no-op after the child has exited naturally", async () => {
      let killCount = 0;
      const spawnFn: SpawnFn = vi.fn(() => {
        const child = makeFakeChild({
          stdoutLines: [
            JSON.stringify({
              type: "result",
              subtype: "success",
              duration_ms: 0,
            }),
          ],
          exitCode: 0,
        });
        const origKill = child.kill.bind(child);
        child.kill = ((signal?: number | NodeJS.Signals) => {
          killCount += 1;
          return origKill(signal);
        }) as ChildProcess["kill"];
        return child;
      });
      const queryFn = createCliQueryFn({
        cliPath: "claude",
        logger: SILENT_LOGGER,
        spawnFn,
      });
      const handle = queryFn({ prompt: "x", options: BASE_OPTIONS, canUseTool: STUB_CAN_USE_TOOL });
      const messages = await collectMessages(handle);
      expect(messages).toHaveLength(1);
      // Now interrupt — must not throw and must not call kill().
      await handle.interrupt();
      expect(killCount).toBe(0);
    });
  });
});

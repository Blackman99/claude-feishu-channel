# Phase 4: State Machine + Queue + Interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each task is a fresh subagent dispatch with the task text + file context + TDD steps copied verbatim. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 3's implicit `Mutex.run` serialization with an explicit per-chat state machine (`idle` / `generating` / `awaiting_permission`), a FIFO input queue, a working `/stop` command, and a `!` prefix that interrupts the current turn. After this phase, multiple messages arriving during a running turn queue cleanly, the user can stop a runaway turn, and a `!`-prefixed message drops the queue and takes over — matching the concurrency model D documented in design spec §4–5.

**Architecture:** `QueryFn` is reshaped from "returns an `AsyncIterable`" to "returns a `QueryHandle` object with `.messages` (the iterable) and `.interrupt()` (a method)" — this is the only way the session can ask the currently-running CLI subprocess to terminate without relying on the consumer breaking out of the loop. `cli-query.ts` implements `interrupt()` as a `SIGTERM` + `await exit` on the child process. `ClaudeSession` is rewritten around an explicit state enum + FIFO queue + a single-slot `currentTurn` handle, all guarded by the existing `Mutex`. A background `processLoop` drains the queue serially: each queued input carries its own `emit` callback and a `Deferred<void>` that resolves when that specific input's turn has ended (so callers still get backpressure on their own message, even though the session is no longer serializing whole `handleMessage` calls). A new `src/commands/router.ts` parses inputs into `{ kind: "run" | "stop" | "interrupt_and_run", text? }` — Phase 6 will extend it with the full command set, Phase 4 only adds what's needed for interrupt semantics. The `awaiting_permission` state is scaffolded with a `PermissionBroker` interface + a test-only entry seam; real entry via `canUseTool` arrives in Phase 5.

**Tech Stack:** TypeScript strict, vitest, existing `src/util/{mutex,deferred,clock}.ts` primitives, Node `child_process` (already used in Phase 3's `cli-query.ts`). No new runtime dependencies.

**Out of scope (deferred):**
- Real `awaiting_permission` entry via `canUseTool` — Phase 5. Phase 4 only scaffolds the state enum + a test seam + exit transitions (`/stop` / `!` out of `awaiting_permission`).
- Permission request cards / timeout timers / "always allow" button — Phase 5.
- Other commands (`/new` / `/cd` / `/project` / `/resume` / `/mode` / `/model` / `/status` / `/help` / `/sessions` / `/config`) — Phase 6. Phase 4 only adds `/stop`.
- Persistence of queue / current turn across restart — Phase 7.
- Graceful re-draining of the queue after an abrupt cli-query failure — Phase 4 fails the in-flight turn's Deferred and lets the queue keep draining; richer recovery is Phase 8 polish.
- `/fork` session branching — permanently YAGNI per design §17.
- `clock` injection beyond what's needed for the state machine (no timers are scheduled in Phase 4 — that's Phase 5) — we still pass `Clock` to the session constructor so Phase 5 can add timers without churning the signature again.

**Known tech facts (baked in from recon):**
- Current `QueryFn` signature (`src/claude/session.ts:49`) is `(params) => AsyncIterable<SDKMessageLike>`. Consumers call `for await (const msg of iter)` directly. There is no handle object, so the session has no way to ask the iterator to terminate — the only termination path today is the consumer `break`-ing out of the loop, which triggers the `try/finally` in `cli-query.ts:143` to `SIGTERM` the child. Phase 4 converts this into an explicit `interrupt()` method that the state machine can call without breaking its iteration loop.
- `cli-query.ts` already tracks `child` + `exitPromise` + uses `createInterface({ input: child.stdout })`, so the interrupt implementation is: call `child.kill("SIGTERM")`, close the readline interface, await `exitPromise`. The existing `finally` block on consumer break already does the first step — we're just making it callable from outside.
- `src/util/mutex.ts` has `Mutex.run(task)` which runs `task` serially against prior `run` calls. Phase 4 uses this to guard every state transition (but NOT the turn execution itself — turns run outside the lock so new inputs can still be queued while a turn runs).
- `src/util/deferred.ts` has `createDeferred<T>()` returning `{ promise, resolve, reject, settled }`. Phase 4 uses one `Deferred<void>` per queued input to give the `enqueue` caller backpressure on their specific input.
- `src/util/clock.ts` already has `Clock` + `RealClock` + `FakeClock` with `advance(ms)`. Phase 4 passes `Clock` through the session constructor even though no timers are scheduled yet — this prevents a second refactor of the constructor signature in Phase 5.
- The CLI transport (`--print --output-format stream-json`) does **not** support the SDK's `canUseTool` callback. Phase 5 will have to decide between (a) running permission checks out-of-band via `--permission-prompt-tool`, (b) a hybrid where permission-sensitive turns use the SDK instead of the CLI, or (c) something else. Phase 4 must not lock in any of these — it only ensures the `awaiting_permission` state exists in the enum and that the exit transitions (`!` / `/stop` while in this state) are tested against a direct test seam (`session._testEnterAwaitingPermission(deferred)`).
- The existing `ClaudeSession.handleMessage(text, emit): Promise<void>` contract must be **replaced**, not extended — the Phase 3 dispatcher in `src/index.ts` calls this once per inbound message and relies on the Phase 3 mutex for serialization. Phase 4 replaces the call with `session.submit(input, emit)` where `input` is the parsed `CommandRouterResult`, and the return value carries the per-input `Promise<void>` the dispatcher awaits.
- vitest's `describe.each` / `it.concurrent` are NOT useful here — the state machine tests are order-sensitive and frequently need to interleave `enqueue` / `query.emit` / `advance` calls in a specific sequence. Keep them as individual `it` blocks.

---

## File structure

**New files:**
- `src/claude/query-handle.ts` — `QueryHandle` interface + `QueryFn` type (moved out of `session.ts`). Keeps `session.ts` from re-exporting query-shape types that callers need.
- `src/claude/permission-broker.ts` — `PermissionBroker` / `PermissionRequest` / `PermissionResponse` interfaces + `NullPermissionBroker` stub. Phase 4 only uses the stub; Phase 5 replaces it with the real broker.
- `src/commands/router.ts` — pure `parseInput(text): CommandRouterResult` function. Phase 4 only emits `run` / `stop` / `interrupt_and_run`; Phase 6 will add the other command kinds.
- `src/commands/router.test.ts` → actually `test/unit/commands/router.test.ts` — pure unit tests for `parseInput`.
- `test/unit/claude/fakes/fake-query-handle.ts` — `FakeQueryHandle` test fixture: scriptable `.emitMessage(msg)`, `.finishWithSuccess(result)`, `.finishWithError(subtype, errs)`, `.interrupt()` that resolves after marking the handle as interrupted. Used by every state machine test.
- `test/unit/claude/fakes/spy-renderer.ts` — `SpyRenderer` helper: wraps a `RenderEvent[]` array and exposes `.emit` + `.events` + `.errors` + a `.failNextEmitWith(err)` hook for testing error paths.
- `test/unit/claude/session-state-machine.test.ts` — the new strict-TDD test file for the rewritten `ClaudeSession`. Separate from `session.test.ts` so the old Phase 3 tests can be deleted in one clean step.
- `test/unit/commands/router.test.ts` — unit tests for `parseInput`.

**Modified files:**
- `src/claude/session.ts` — complete rewrite. `QueryFn` type moves to `query-handle.ts`. New public API: `submit(result: CommandRouterResult, emit): Promise<SubmitOutcome>`, `stop(emit): Promise<void>`. Internal state machine with `state`, `inputQueue`, `currentTurn`, `processLoop`, guarded by the existing mutex. The old `handleMessage` is removed.
- `src/claude/cli-query.ts` — `createCliQueryFn` now returns a `QueryFn` that produces `QueryHandle` (with `.messages` and `.interrupt()`) instead of bare `AsyncIterable`. `interrupt()` calls `child.kill("SIGTERM")` + closes the readline interface + awaits exit. Existing error / happy paths unchanged.
- `src/claude/session-manager.ts` — `getOrCreate` signature accepts a `Clock` (wired from `src/index.ts`). No other changes.
- `src/claude/render-event.ts` — add two new variants: `{ type: "queued", position: number }` (out-of-band notice when an input lands in a non-empty queue) and `{ type: "interrupted", reason: "stop" | "bang_prefix" }` (rejected queue entries get this as their last emit before the `Deferred` rejects). Existing variants unchanged.
- `src/feishu/messages.ts` — add `formatQueuedTip(position)` and `formatStopAck()` and `formatInterruptDropAck()` plain-text helpers (consumed by the dispatcher to render the new RenderEvent variants).
- `src/index.ts` — parse every inbound `msg.text` through `parseInput` before dispatching, call `session.submit(...)` / `session.stop(...)` instead of `session.handleMessage(...)`, wire `new SpyRenderer`-compatible emit, wire `RealClock` into the session manager. Banner log line updated to "Phase 4 ready" with queue / state-machine config.
- `test/unit/claude/session.test.ts` → **deleted** and replaced by `session-state-machine.test.ts`. Phase 3's tests assume the old `handleMessage` contract; they cannot be incrementally migrated without losing TDD discipline.
- `test/unit/claude/cli-query.test.ts` — add interrupt() tests, update existing tests to unwrap `.messages` instead of iterating the return value directly.
- `test/unit/claude/session-manager.test.ts` — update constructor calls to pass a `FakeClock` / `RealClock`.
- `README.md` — Phase 4 status line, queue + `/stop` + `!` docs, updated `src/` layout.

**Deleted files:**
- `test/unit/claude/session.test.ts` — replaced by `session-state-machine.test.ts`.

---

## Task 1: `QueryHandle` interface + `cli-query.ts` interrupt

**Files:**
- Create: `src/claude/query-handle.ts`
- Modify: `src/claude/session.ts` (re-export from new module — interim, will be fully rewritten in Task 5)
- Modify: `src/claude/cli-query.ts`
- Modify: `test/unit/claude/cli-query.test.ts`

**Design decision:** `QueryHandle` is a plain object exposing `.messages: AsyncIterable<SDKMessageLike>` and `.interrupt(): Promise<void>`. No class — consumers (including fakes) just build the object literal. This keeps fakes trivial and avoids inheritance mess. `interrupt()` returns a Promise that resolves once the underlying turn has fully ended (either via a naturally-arriving `result` message before the SIGTERM reaches the process, or via the child exiting after the signal).

- [ ] **Step 1: Write failing interface test**

Create `test/unit/claude/query-handle.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/claude/query-handle.test.ts`
Expected: FAIL with "Cannot find module '../../../src/claude/query-handle.js'".

- [ ] **Step 3: Create `src/claude/query-handle.ts`**

```typescript
import type { AppConfig } from "../types.js";
import type { SDKMessageLike } from "./session.js";

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  permissionMode: AppConfig["claude"]["defaultPermissionMode"];
  settingSources: readonly ("project" | "user" | "local")[];
}

/**
 * Handle exposed by a `QueryFn` for one turn. Consumers iterate
 * `.messages` to receive the stream-json events and can call
 * `.interrupt()` at any point to terminate the turn early (used by
 * `ClaudeSession` for `/stop` and `!` prefix).
 *
 * `interrupt()` MUST be idempotent — the state machine may call it
 * during the narrow window between a result message arriving and the
 * iterator ending naturally, and we don't want the second call to
 * throw or spawn a second signal.
 *
 * `interrupt()` resolves only after the turn has fully settled (child
 * exited / iterator ended), so the state machine can safely assume
 * that once the returned Promise resolves, no more messages will be
 * emitted for this turn.
 */
export interface QueryHandle {
  readonly messages: AsyncIterable<SDKMessageLike>;
  interrupt(): Promise<void>;
}

/**
 * Structural signature of the function that creates a per-turn
 * `QueryHandle`. `src/claude/cli-query.ts` implements this for the
 * real CLI subprocess; tests inject `FakeQueryHandle` via this same
 * type.
 */
export type QueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
}) => QueryHandle;
```

- [ ] **Step 4: Remove duplicate declarations from `session.ts`**

Edit `src/claude/session.ts`: delete the local `ClaudeQueryOptions` and `QueryFn` declarations (lines ~37–52), and re-export them from the new module so the existing Phase 3 imports in `src/index.ts` and `src/claude/cli-query.ts` continue to resolve without churn. Add at the top of `session.ts`:

```typescript
export type { ClaudeQueryOptions, QueryFn, QueryHandle } from "./query-handle.js";
```

The `SDKMessageLike` and `SDKContentBlock` interfaces stay in `session.ts` for now (they're still the session's public contract) — the new `query-handle.ts` imports them back via `import type { SDKMessageLike } from "./session.js"`. That's the one circular-looking import but it's type-only so TypeScript resolves it without runtime side effects.

- [ ] **Step 5: Run the interface test to verify it passes**

Run: `pnpm vitest run test/unit/claude/query-handle.test.ts`
Expected: 2/2 PASS.

- [ ] **Step 6: Write failing cli-query interrupt test**

Append to `test/unit/claude/cli-query.test.ts` (inside the existing `describe("createCliQueryFn")` or a new sub-describe):

```typescript
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

describe("createCliQueryFn interrupt()", () => {
  // Helper to build a fake child process that we can drive explicitly.
  function makeFakeChild() {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: null;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
      exitCode: number | null;
      pid: number;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null;
    child.killed = false;
    child.exitCode = null;
    child.pid = 12345;
    child.kill = vi.fn((_signal?: string) => {
      child.killed = true;
      // Simulate OS shutting the process down.
      setImmediate(() => {
        child.exitCode = 143; // SIGTERM
        child.emit("close", 143);
      });
      return true;
    });
    return child;
  }

  it("interrupt() calls child.kill('SIGTERM') and resolves after the child exits", async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild as never);
    const logger = createLogger({ level: "error", pretty: false });
    const queryFn = createCliQueryFn({ cliPath: "claude", logger, spawnFn });

    const handle = queryFn({
      prompt: "test",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
    });

    // Kick off the iterator in the background — cli-query doesn't start
    // reading stdout until something awaits `.messages`.
    const iterPromise = (async () => {
      const msgs: SDKMessageLike[] = [];
      for await (const m of handle.messages) msgs.push(m);
      return msgs;
    })();

    // Give the generator a tick to hook up readline.
    await new Promise((r) => setImmediate(r));

    // Push one init message before interrupting.
    fakeChild.stdout.push(JSON.stringify({ type: "system", subtype: "init" }) + "\n");

    // Interrupt from the state machine.
    await handle.interrupt();

    // The generator should have observed child close and returned.
    const msgs = await iterPromise;
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fakeChild.killed).toBe(true);
    expect(msgs).toEqual([{ type: "system", subtype: "init" }]);
  });

  it("interrupt() is idempotent — second call does not re-signal", async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild as never);
    const logger = createLogger({ level: "error", pretty: false });
    const queryFn = createCliQueryFn({ cliPath: "claude", logger, spawnFn });

    const handle = queryFn({
      prompt: "test",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
    });

    // Start iterator, then interrupt twice.
    const iterPromise = (async () => {
      for await (const _ of handle.messages) { /* drain */ }
    })();
    await new Promise((r) => setImmediate(r));

    await handle.interrupt();
    await handle.interrupt();
    await iterPromise;
    expect(fakeChild.kill).toHaveBeenCalledTimes(1);
  });

  it("interrupt() after natural completion is a no-op that still resolves", async () => {
    const fakeChild = makeFakeChild();
    const spawnFn = vi.fn(() => fakeChild as never);
    const logger = createLogger({ level: "error", pretty: false });
    const queryFn = createCliQueryFn({ cliPath: "claude", logger, spawnFn });

    const handle = queryFn({
      prompt: "test",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
    });

    const iterPromise = (async () => {
      const msgs: SDKMessageLike[] = [];
      for await (const m of handle.messages) msgs.push(m);
      return msgs;
    })();
    await new Promise((r) => setImmediate(r));

    // Push a result + EOF so the generator ends naturally.
    fakeChild.stdout.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 10,
        usage: { input_tokens: 1, output_tokens: 1 },
      }) + "\n",
    );
    fakeChild.stdout.push(null); // EOF
    fakeChild.exitCode = 0;
    fakeChild.emit("close", 0);

    const msgs = await iterPromise;
    expect(msgs).toHaveLength(1);

    // Interrupt AFTER completion — should resolve without throwing or
    // double-killing.
    await expect(handle.interrupt()).resolves.toBeUndefined();
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/claude/cli-query.test.ts -t "interrupt"`
Expected: 3 FAIL (`handle.interrupt is not a function` / TypeError).

- [ ] **Step 8: Rewrite `cli-query.ts` to return a `QueryHandle`**

Full replacement for `src/claude/cli-query.ts`:

```typescript
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Logger } from "pino";
import type { SDKMessageLike } from "./session.js";
import type {
  ClaudeQueryOptions,
  QueryFn,
  QueryHandle,
} from "./query-handle.js";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CliQueryFnOptions {
  cliPath: string;
  logger: Logger;
  spawnFn?: SpawnFn;
}

function buildArgs(options: ClaudeQueryOptions, prompt: string): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--permission-mode",
    options.permissionMode,
    "--setting-sources",
    options.settingSources.join(","),
    "--",
    prompt,
  ];
}

const STDOUT_TAIL_MAX_LINES = 10;
const STDOUT_TAIL_LINE_CAP = 400;

/**
 * Adapter implementing `QueryFn` by spawning the local `claude` CLI
 * in `--print --output-format stream-json` mode.
 *
 * The returned `QueryHandle` exposes:
 * - `messages`: an AsyncIterable that yields one `SDKMessageLike` per
 *   parsed stdout line. The iterable terminates naturally when the
 *   child's stdout closes; post-iteration the generator validates
 *   exit code and throws a diagnostic error if the child exited
 *   non-zero without having yielded a result message.
 * - `interrupt()`: sends `SIGTERM` to the child (idempotent — no-op
 *   if already dead) and resolves after the child's `close` event
 *   has fired. The state machine calls this from its `stop()` /
 *   `interrupt()` handlers without breaking out of the iterator loop.
 *
 * Error semantics (unchanged from Phase 3):
 * - Spawn failure (e.g. ENOENT) → iterator throws "Failed to spawn..."
 * - Non-zero exit AFTER a result message → warn-log + swallow
 *   (session owns the error path via result.subtype).
 * - Non-zero exit WITHOUT a result message → iterator throws with
 *   exit code + stderr tail + stdout tail fallback.
 * - Malformed JSON lines → warn-log + skip.
 */
export function createCliQueryFn(opts: CliQueryFnOptions): QueryFn {
  const spawn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  return (params) => {
    const args = buildArgs(params.options, params.prompt);
    const child = spawn(opts.cliPath, args, {
      cwd: params.options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let spawnError: Error | undefined;
    child.on("error", (err: Error) => {
      spawnError = err;
    });

    let stderrBuf = "";
    const STDERR_CAP = 16 * 1024;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuf +=
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stderrBuf.length > STDERR_CAP) {
        stderrBuf = stderrBuf.slice(-STDERR_CAP);
      }
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    if (!child.stdout) {
      throw new Error("claude CLI spawned without a stdout pipe");
    }

    // Shared state between the async generator and `interrupt()`.
    // `rl` is set once the generator hooks up readline; `interrupted`
    // ensures `interrupt()` is idempotent and makes the post-iteration
    // exit-code check aware that the non-zero exit was expected.
    let rl: ReadlineInterface | null = null;
    let interrupted = false;

    const interrupt = async (): Promise<void> => {
      if (interrupted) return;
      if (child.exitCode !== null || child.killed) {
        // Child already dead — nothing to signal, but we still await
        // the exit promise so the caller has the same post-condition
        // as a fresh interrupt call: "after this resolves, the turn
        // is fully settled".
        await exitPromise;
        return;
      }
      interrupted = true;
      try {
        child.kill("SIGTERM");
      } catch (err) {
        // `kill()` can throw if the process vanished between the
        // exit-code check and the signal call. Ignore — we just want
        // to wait for the exit event below.
        opts.logger.warn({ err }, "cli-query interrupt() kill threw");
      }
      if (rl !== null) {
        try {
          rl.close();
        } catch {
          // readline `close` is safe to call multiple times, but in
          // tests where we mock the stream it may throw.
        }
      }
      await exitPromise;
    };

    const messages: AsyncIterable<SDKMessageLike> = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessageLike, void, void> {
        const stdoutTail: string[] = [];
        let sawResultMessage = false;

        rl = createInterface({ input: child.stdout! });
        try {
          for await (const rawLine of rl) {
            const line = rawLine.trim();
            if (line.length === 0) continue;
            stdoutTail.push(
              line.length > STDOUT_TAIL_LINE_CAP
                ? `${line.slice(0, STDOUT_TAIL_LINE_CAP)}…`
                : line,
            );
            if (stdoutTail.length > STDOUT_TAIL_MAX_LINES) stdoutTail.shift();

            let parsed: SDKMessageLike;
            try {
              parsed = JSON.parse(line) as SDKMessageLike;
            } catch (err) {
              opts.logger.warn(
                { err, line: line.slice(0, 200) },
                "Failed to parse CLI stream-json line",
              );
              continue;
            }
            if (parsed.type === "result") sawResultMessage = true;
            yield parsed;
          }
        } finally {
          try {
            rl?.close();
          } catch {
            // ok
          }
          // If the consumer broke early AND interrupt() wasn't called,
          // we still want to reap the child to avoid zombies. Don't
          // re-kill if `interrupted` is already true — that path owns
          // the signal.
          if (!interrupted && !child.killed && child.exitCode === null) {
            child.kill("SIGTERM");
          }
        }

        const exitCode = await exitPromise;
        if (spawnError) {
          throw new Error(
            `Failed to spawn claude CLI (${opts.cliPath}): ${spawnError.message}`,
          );
        }
        if (interrupted) {
          // Expected non-zero exit after a SIGTERM — not an error from
          // the session's perspective. Swallow and end the iterator.
          opts.logger.debug(
            { exitCode },
            "claude CLI exited after interrupt — not reporting as error",
          );
          return;
        }
        if (exitCode !== 0) {
          if (sawResultMessage) {
            opts.logger.warn(
              { exitCode, stderrLen: stderrBuf.length },
              "claude CLI exited non-zero after result message — deferring to session error handler",
            );
            return;
          }
          const stderrTail = stderrBuf.trim().split("\n").slice(-5).join("\n");
          const diagnostics: string[] = [];
          if (stderrTail) {
            diagnostics.push(`stderr:\n${stderrTail}`);
          } else if (stdoutTail.length > 0) {
            diagnostics.push(`stdout tail:\n${stdoutTail.join("\n")}`);
          } else {
            diagnostics.push("(no stdout or stderr output)");
          }
          throw new Error(
            `claude CLI exited with code ${exitCode}:\n${diagnostics.join("\n")}`,
          );
        }
      },
    };

    const handle: QueryHandle = { messages, interrupt };
    return handle;
  };
}
```

- [ ] **Step 9: Update existing cli-query tests that assumed the old shape**

Run the existing cli-query tests: `pnpm vitest run test/unit/claude/cli-query.test.ts`. Any test that iterates the return value of `queryFn(...)` directly must be updated to iterate `.messages`:

```typescript
// Before
const iter = queryFn({ prompt, options });
for await (const m of iter) { ... }

// After
const handle = queryFn({ prompt, options });
for await (const m of handle.messages) { ... }
```

Grep for these: `rg "for await \(const.*of.*queryFn" test/unit/claude/cli-query.test.ts` — patch every hit.

- [ ] **Step 10: Run tests to verify cli-query is green**

Run: `pnpm vitest run test/unit/claude/cli-query.test.ts`
Expected: All existing tests PASS + 3 new interrupt tests PASS.

- [ ] **Step 11: Commit**

```bash
git add src/claude/query-handle.ts src/claude/cli-query.ts src/claude/session.ts \
  test/unit/claude/query-handle.test.ts test/unit/claude/cli-query.test.ts
git commit -m "refactor(claude): QueryFn returns QueryHandle with interrupt()"
```

---

## Task 2: Command router

**Files:**
- Create: `src/commands/router.ts`
- Create: `test/unit/commands/router.test.ts`

**Design decision:** `parseInput` is a pure function — no state, no I/O. It takes the raw inbound text and returns one of three shapes. Phase 4 ONLY implements `run` / `stop` / `interrupt_and_run`; adding more kinds in Phase 6 is a matter of extending the union and the switch. Whitespace-only text is treated as `{ kind: "run", text: "" }` (an empty run) rather than being rejected at the parser layer — the session has its own rules for empty inputs.

- [ ] **Step 1: Write failing tests**

Create `test/unit/commands/router.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseInput } from "../../../src/commands/router.js";

describe("parseInput", () => {
  it("plain text → run", () => {
    expect(parseInput("hello world")).toEqual({
      kind: "run",
      text: "hello world",
    });
  });

  it("preserves leading/trailing whitespace inside a run", () => {
    // Trimming is the session's concern, not the parser's.
    expect(parseInput("  hi  ")).toEqual({ kind: "run", text: "  hi  " });
  });

  it("'/stop' → stop", () => {
    expect(parseInput("/stop")).toEqual({ kind: "stop" });
  });

  it("'/stop' followed by whitespace is still stop", () => {
    expect(parseInput("/stop  ")).toEqual({ kind: "stop" });
    expect(parseInput("/stop\n")).toEqual({ kind: "stop" });
  });

  it("'/stop' with trailing text is NOT stop — it's a run", () => {
    // Phase 6 may reserve `/stop <reason>`, but Phase 4 only accepts
    // bare `/stop`. Anything else falls through to `run` so the user
    // isn't surprised by a silent stop when they mistype.
    expect(parseInput("/stop now")).toEqual({
      kind: "run",
      text: "/stop now",
    });
  });

  it("'/STOP' uppercase → stop (case-insensitive)", () => {
    expect(parseInput("/STOP")).toEqual({ kind: "stop" });
    expect(parseInput("/Stop")).toEqual({ kind: "stop" });
  });

  it("'!foo' → interrupt_and_run with text='foo'", () => {
    expect(parseInput("!foo")).toEqual({
      kind: "interrupt_and_run",
      text: "foo",
    });
  });

  it("'! foo' (with space after !) → interrupt_and_run with text='foo'", () => {
    // Leading whitespace after `!` is consumed so the rewritten
    // input doesn't carry the separator the user used to delimit.
    expect(parseInput("! foo")).toEqual({
      kind: "interrupt_and_run",
      text: "foo",
    });
  });

  it("'!' on its own (no payload) is NOT interrupt_and_run — it's a plain run", () => {
    // Interrupt semantics without a replacement message is ambiguous:
    // does the user mean "stop" or "run nothing"? We pick the
    // least-surprising interpretation and treat it as literal text,
    // letting the session reject empty input if it wants.
    expect(parseInput("!")).toEqual({ kind: "run", text: "!" });
    expect(parseInput("!   ")).toEqual({ kind: "run", text: "!   " });
  });

  it("'!!foo' → interrupt_and_run with text='!foo' (only the FIRST ! is consumed)", () => {
    // Double-bang would be a Phase 6 feature ("interrupt without
    // dropping queue"); for now we just take the first ! and let the
    // rest of the string through.
    expect(parseInput("!!foo")).toEqual({
      kind: "interrupt_and_run",
      text: "!foo",
    });
  });

  it("empty string → run with empty text", () => {
    expect(parseInput("")).toEqual({ kind: "run", text: "" });
  });

  it("whitespace only → run with whitespace text", () => {
    expect(parseInput("   ")).toEqual({ kind: "run", text: "   " });
    expect(parseInput("\n\t")).toEqual({ kind: "run", text: "\n\t" });
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run test/unit/commands/router.test.ts`
Expected: FAIL with "Cannot find module '../../../src/commands/router.js'".

- [ ] **Step 3: Implement `src/commands/router.ts`**

```typescript
/**
 * Result of parsing one inbound chat message.
 *
 * - `run`: deliver `text` to the current Claude session as a new turn
 *   or as a queue entry, depending on session state.
 * - `stop`: interrupt the current turn (if any) and drop the queue.
 *   Does not deliver any text.
 * - `interrupt_and_run`: interrupt the current turn, drop the queue,
 *   THEN deliver `text` as the next turn. The `!` prefix form.
 *
 * Phase 6 will extend this union with `{ kind: "new" }`, `{ kind:
 * "cd", path }`, etc. — keep the discriminated-union shape so new
 * kinds are exhaustiveness-checked at every call site.
 */
export type CommandRouterResult =
  | { kind: "run"; text: string }
  | { kind: "stop" }
  | { kind: "interrupt_and_run"; text: string };

/**
 * Parse raw inbound text into a `CommandRouterResult`. Pure function —
 * no I/O, no state.
 *
 * Recognition rules:
 * - `/stop` (case-insensitive, trailing whitespace allowed, NO other
 *   trailing content) → `{ kind: "stop" }`
 * - `!<payload>` or `! <payload>` where `<payload>` is non-empty after
 *   trimming the leading `!` and one optional space → `{ kind:
 *   "interrupt_and_run", text: <payload> }`
 * - everything else → `{ kind: "run", text: <raw text unchanged> }`
 *
 * Whitespace-only and empty strings fall through to `run`; the
 * session decides whether to ignore them. This way the parser stays
 * dumb and only makes decisions based on syntactic prefixes.
 */
export function parseInput(text: string): CommandRouterResult {
  // /stop (case-insensitive, optional trailing whitespace, nothing else)
  if (/^\/stop\s*$/i.test(text)) {
    return { kind: "stop" };
  }

  // ! prefix interrupt. The payload is the substring after the first
  // `!`, with at most one leading space consumed. An empty payload
  // (bare "!" or "!   ") falls through to a plain run so the user
  // isn't accidentally interrupting with nothing to say.
  if (text.startsWith("!")) {
    let payload = text.slice(1);
    if (payload.startsWith(" ")) payload = payload.slice(1);
    if (payload.length > 0 && payload.trim().length > 0) {
      return { kind: "interrupt_and_run", text: payload };
    }
    // Empty payload → fall through
  }

  return { kind: "run", text };
}
```

- [ ] **Step 4: Run to verify green**

Run: `pnpm vitest run test/unit/commands/router.test.ts`
Expected: 12/12 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/router.ts test/unit/commands/router.test.ts
git commit -m "feat(commands): add parseInput for /stop and ! prefix"
```

---

## Task 3: `PermissionBroker` interface + `NullPermissionBroker` stub

**Files:**
- Create: `src/claude/permission-broker.ts`
- Create: `test/unit/claude/permission-broker.test.ts`

**Design decision:** Phase 4 declares the interface the real Phase 5 broker will implement, plus a `NullPermissionBroker` that throws on use. The null broker is what the production wiring injects in Phase 4 — nothing should call it, and if something does (e.g. a premature test seam), we want a loud error rather than silent nonsense. The test seam (`session._testEnterAwaitingPermission`) will accept a `Deferred<PermissionResponse>` directly and bypass the broker entirely.

- [ ] **Step 1: Write failing tests**

Create `test/unit/claude/permission-broker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  NullPermissionBroker,
  type PermissionRequest,
} from "../../../src/claude/permission-broker.js";

describe("NullPermissionBroker", () => {
  it("throws on request() with a clear 'Phase 5 not wired' error", async () => {
    const broker = new NullPermissionBroker();
    const req: PermissionRequest = {
      toolName: "Bash",
      input: { command: "rm -rf /" },
      chatId: "oc_x",
    };
    await expect(broker.request(req)).rejects.toThrow(
      /Phase 5|not wired|NullPermissionBroker/i,
    );
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run test/unit/claude/permission-broker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/claude/permission-broker.ts`**

```typescript
/**
 * A pending permission check — Phase 5 will construct one of these
 * from the SDK's `canUseTool` callback parameters.
 */
export interface PermissionRequest {
  /** Name of the tool Claude wants to call, e.g. "Bash", "Edit". */
  toolName: string;
  /** Raw tool input (the session does NOT validate the shape). */
  input: unknown;
  /** Feishu chat that owns this request (for card routing). */
  chatId: string;
}

/**
 * The response the broker returns to Claude. "allow" lets the tool
 * run (optionally with a modified input); "deny" aborts with a user-
 * visible message that Claude will see as the tool_result.
 */
export type PermissionResponse =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

/**
 * Bridges between the SDK's `canUseTool` callback and the Feishu
 * permission card UX. Phase 5 will ship the real implementation that
 * creates a `Deferred<PermissionResponse>`, sends a permission card,
 * and resolves the deferred on button click / timeout.
 *
 * Phase 4 only declares the interface + a stub that throws. The
 * `ClaudeSession` constructor takes a `PermissionBroker` so the
 * Phase 5 wiring is a drop-in replacement with no session-side churn.
 */
export interface PermissionBroker {
  /**
   * Request permission for a tool call. Resolves with the user's
   * decision. The returned promise MUST NOT reject under normal
   * operation — timeouts resolve with `deny`, cancellations resolve
   * with `deny`. Only programming bugs should reject.
   */
  request(req: PermissionRequest): Promise<PermissionResponse>;
}

/**
 * Placeholder broker that throws on use. Phase 4 production wiring
 * injects this — if anything actually calls it, that's a bug (the
 * CLI transport doesn't surface canUseTool yet, and the Phase 4 test
 * seam bypasses the broker entirely via `_testEnterAwaitingPermission`).
 */
export class NullPermissionBroker implements PermissionBroker {
  async request(_req: PermissionRequest): Promise<PermissionResponse> {
    throw new Error(
      "NullPermissionBroker.request called — permission bridge not wired yet (Phase 5)",
    );
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `pnpm vitest run test/unit/claude/permission-broker.test.ts`
Expected: 1/1 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/claude/permission-broker.ts test/unit/claude/permission-broker.test.ts
git commit -m "feat(claude): add PermissionBroker interface + NullPermissionBroker stub"
```

---

## Task 4: Extend `RenderEvent` with `queued` and `interrupted` variants

**Files:**
- Modify: `src/claude/render-event.ts`
- Modify: `src/feishu/messages.ts`
- Modify: `test/unit/feishu/messages.test.ts`
- Modify: `src/index.ts` (add exhaustive `case "queued"` / `case "interrupted"` to the emit dispatcher)

**Design decision:** These two new variants are "out-of-band notices" — they are not tied to Claude's stream of text/thinking/tool blocks. They exist so the session can use the same emit channel the dispatcher already owns, instead of forcing the dispatcher to grow new callback parameters. The `queued` variant is emitted exactly once per queued input, immediately after the enqueue lock releases. The `interrupted` variant is emitted exactly once per queued input that gets dropped (via `!` or `/stop`) before its turn ran.

- [ ] **Step 1: Write failing tests for the new RenderEvent variants**

Append to `test/unit/feishu/messages.test.ts`:

```typescript
import { formatQueuedTip, formatStopAck, formatInterruptDropAck } from "../../../src/feishu/messages.js";

describe("formatQueuedTip", () => {
  it("renders the queue position with a hint that the user can /stop", () => {
    expect(formatQueuedTip(1)).toBe("📥 已加入队列 #1（当前有一个轮次在运行，发 `/stop` 可取消）");
  });

  it("renders higher positions without shifting", () => {
    expect(formatQueuedTip(5)).toBe("📥 已加入队列 #5（当前有一个轮次在运行，发 `/stop` 可取消）");
  });

  it("throws on position < 1 — queue positions are 1-indexed", () => {
    expect(() => formatQueuedTip(0)).toThrow(/position/);
    expect(() => formatQueuedTip(-1)).toThrow(/position/);
  });
});

describe("formatStopAck", () => {
  it("renders a neutral stop acknowledgement", () => {
    expect(formatStopAck()).toBe("🛑 已停止");
  });
});

describe("formatInterruptDropAck", () => {
  it("renders a neutral 'your message was dropped' ack", () => {
    expect(formatInterruptDropAck()).toBe(
      "⚠️ 你之前的消息在被 Claude 处理前已被后续指令打断丢弃",
    );
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run test/unit/feishu/messages.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Add the formatter functions to `src/feishu/messages.ts`**

Append to `src/feishu/messages.ts`:

```typescript
/**
 * Notice rendered when an incoming message lands in a non-empty
 * queue because the session is already running a turn. The hint
 * tells the user how to cancel without having to look up /help.
 *
 * Position is 1-indexed (the first queued message is #1, not #0).
 */
export function formatQueuedTip(position: number): string {
  if (position < 1 || !Number.isFinite(position)) {
    throw new Error(`formatQueuedTip: position must be >= 1, got ${position}`);
  }
  return `📥 已加入队列 #${position}（当前有一个轮次在运行，发 \`/stop\` 可取消）`;
}

/**
 * Acknowledgement sent after `/stop` successfully interrupted a turn
 * or was received while idle (both paths end up in the same state,
 * so the user gets the same confirmation either way).
 */
export function formatStopAck(): string {
  return "🛑 已停止";
}

/**
 * Sent as the final emit for any queued input that was dropped by a
 * `!` prefix or `/stop` before its turn ran. The user's original
 * message context is theirs — they know which message this was
 * replying to, so we don't repeat it.
 */
export function formatInterruptDropAck(): string {
  return "⚠️ 你之前的消息在被 Claude 处理前已被后续指令打断丢弃";
}
```

- [ ] **Step 4: Add the new variants to `RenderEvent`**

Edit `src/claude/render-event.ts` — extend the discriminated union:

```typescript
export type RenderEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      isError: boolean;
      text: string;
    }
  | {
      type: "turn_end";
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
    }
  // Phase 4: out-of-band notices
  | { type: "queued"; position: number }
  | { type: "interrupted"; reason: "stop" | "bang_prefix" };
```

- [ ] **Step 5: Update `src/index.ts` emit dispatcher to handle the new variants**

Add two new cases to the `emit` switch in `src/index.ts` (before the existing `default` exhaustiveness check):

```typescript
case "queued":
  // Out-of-band notice from the session: the user's input landed in
  // a non-empty queue. Rendered as a plain text message so it
  // doesn't get lost inside a card.
  try {
    await feishuClient.sendText(msg.chatId, formatQueuedTip(event.position));
  } catch (err) {
    logger.warn({ err, chat_id: msg.chatId }, "queued notice send failed");
  }
  return;
case "interrupted":
  // The session is telling us this input was dropped before it ran.
  // Only the "bang_prefix" branch actually needs a user notice —
  // "stop" already goes through the /stop ack path in the
  // dispatcher. Keep both in the switch so the enum is exhaustive
  // and the ack is explicit.
  if (event.reason === "bang_prefix") {
    try {
      await feishuClient.sendText(msg.chatId, formatInterruptDropAck());
    } catch (err) {
      logger.warn({ err, chat_id: msg.chatId }, "interrupted notice send failed");
    }
  }
  return;
```

Add `formatQueuedTip` and `formatInterruptDropAck` to the existing `formatErrorText, formatResultTip` import from `./feishu/messages.js`.

- [ ] **Step 6: Run tests to verify green**

Run: `pnpm vitest run` and `pnpm typecheck`
Expected: All tests pass, strict exhaustiveness check still compiles (the `_exhaustive: never` guard is happy with the new cases).

- [ ] **Step 7: Commit**

```bash
git add src/claude/render-event.ts src/feishu/messages.ts src/index.ts \
  test/unit/feishu/messages.test.ts
git commit -m "feat(render): add queued and interrupted out-of-band events"
```

---

## Task 5: Test fixtures — `FakeQueryHandle` and `SpyRenderer`

**Files:**
- Create: `test/unit/claude/fakes/fake-query-handle.ts`
- Create: `test/unit/claude/fakes/spy-renderer.ts`
- Create: `test/unit/claude/fakes/fakes.test.ts` (smoke tests for the fakes themselves)

**Design decision:** The state machine tests need to drive three things deterministically:
1. When the CLI iterator yields a message
2. When the turn ends (naturally or via interrupt)
3. When emit is called (so we can assert on the sequence of RenderEvents)

`FakeQueryHandle` uses an internal `Deferred<SDKMessageLike | "end">` queue — each call to `.emitMessage(msg)` settles the next-pending deferred with the message; `.finishWithSuccess(...)` / `.finishWithError(...)` / `.interrupt()` all settle with `"end"` after storing the turn outcome for the session to observe (via result message or abnormal termination). This way the test author controls exactly when the async generator yields.

`SpyRenderer` is simpler — just a `RenderEvent[]` push buffer with `.assertSequence(expected)` helper and a `.failNextEmitWith(err)` hook to simulate a render-layer crash.

- [ ] **Step 1: Write smoke tests for the fakes**

Create `test/unit/claude/fakes/fakes.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { FakeQueryHandle } from "./fake-query-handle.js";
import { SpyRenderer } from "./spy-renderer.js";
import type { SDKMessageLike } from "../../../../src/claude/session.js";

describe("FakeQueryHandle", () => {
  it("yields emitted messages in order to the consumer", async () => {
    const fake = new FakeQueryHandle();
    const consumed: SDKMessageLike[] = [];
    const consumer = (async () => {
      for await (const m of fake.messages) consumed.push(m);
    })();

    fake.emitMessage({ type: "system", subtype: "init" });
    fake.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    fake.finishWithSuccess({
      result: "hi",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
    });

    await consumer;
    expect(consumed).toHaveLength(3);
    expect(consumed[0]).toEqual({ type: "system", subtype: "init" });
    expect(consumed[2]?.type).toBe("result");
  });

  it("interrupt() marks the handle as interrupted and ends the iterator", async () => {
    const fake = new FakeQueryHandle();
    const consumed: SDKMessageLike[] = [];
    const consumer = (async () => {
      for await (const m of fake.messages) consumed.push(m);
    })();

    fake.emitMessage({ type: "system", subtype: "init" });
    await fake.interrupt();

    await consumer;
    expect(fake.interrupted).toBe(true);
    expect(consumed).toHaveLength(1);
  });

  it("interrupt() is idempotent — second call is a no-op that still resolves", async () => {
    const fake = new FakeQueryHandle();
    const consumer = (async () => {
      for await (const _ of fake.messages) {
        /* drain */
      }
    })();
    await fake.interrupt();
    await fake.interrupt();
    await consumer;
    expect(fake.interrupted).toBe(true);
  });

  it("finishWithError yields a result message with subtype=error", async () => {
    const fake = new FakeQueryHandle();
    const consumed: SDKMessageLike[] = [];
    const consumer = (async () => {
      for await (const m of fake.messages) consumed.push(m);
    })();
    fake.finishWithError({ subtype: "error_during_execution", errors: ["boom"] });
    await consumer;
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      errors: ["boom"],
    });
  });
});

describe("SpyRenderer", () => {
  it("records emitted events in order", async () => {
    const spy = new SpyRenderer();
    await spy.emit({ type: "text", text: "one" });
    await spy.emit({ type: "text", text: "two" });
    expect(spy.events).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
  });

  it("failNextEmitWith makes the next emit reject, then behaves normally", async () => {
    const spy = new SpyRenderer();
    spy.failNextEmitWith(new Error("render boom"));
    await expect(spy.emit({ type: "text", text: "x" })).rejects.toThrow(/render boom/);
    // Subsequent emits work normally.
    await spy.emit({ type: "text", text: "y" });
    expect(spy.events).toEqual([{ type: "text", text: "y" }]);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run test/unit/claude/fakes/fakes.test.ts`
Expected: module-not-found failures.

- [ ] **Step 3: Implement `fake-query-handle.ts`**

```typescript
import { createDeferred, type Deferred } from "../../../../src/util/deferred.js";
import type {
  SDKMessageLike,
  SDKContentBlock,
} from "../../../../src/claude/session.js";
import type { QueryHandle } from "../../../../src/claude/query-handle.js";

type PendingValue = { kind: "msg"; msg: SDKMessageLike } | { kind: "end" };

/**
 * Scriptable `QueryHandle` implementation for state-machine tests.
 *
 * Usage pattern (from a test):
 *   const fake = new FakeQueryHandle();
 *   session.submit(...); // kicks off a turn that consumes fake.messages
 *   fake.emitMessage({ type: "system", subtype: "init" });
 *   fake.emitMessage({ type: "assistant", ... });
 *   fake.finishWithSuccess({ ... });
 *
 * The internal channel is a FIFO of Deferreds — each `emitMessage`
 * resolves the next pending pull (or enqueues a value if nothing is
 * pulling yet). `finishWith*` / `interrupt()` all push a terminal
 * sentinel that ends the async iterator the next time the consumer
 * pulls.
 *
 * Observation points for assertions:
 * - `interrupted`: true iff `interrupt()` has been called
 * - `lastFinishReason`: the most recent end cause ("success" / "error" /
 *   "interrupted" / null if still running)
 * - `messagesConsumed`: how many values the iterator has yielded
 */
export class FakeQueryHandle implements QueryHandle {
  interrupted = false;
  lastFinishReason: "success" | "error" | "interrupted" | null = null;
  messagesConsumed = 0;

  private readonly queue: PendingValue[] = [];
  private readonly waiters: Deferred<PendingValue>[] = [];
  private ended = false;

  readonly messages: AsyncIterable<SDKMessageLike> = {
    [Symbol.asyncIterator]: () => this.makeIterator(),
  };

  emitMessage(msg: SDKMessageLike): void {
    if (this.ended) {
      throw new Error("FakeQueryHandle: cannot emitMessage after end");
    }
    this.push({ kind: "msg", msg });
  }

  /** Finalize with an SDKResultSuccess-shaped message. */
  finishWithSuccess(opts: {
    result?: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
  }): void {
    if (this.ended) return;
    this.push({
      kind: "msg",
      msg: {
        type: "result",
        subtype: "success",
        result: opts.result,
        duration_ms: opts.durationMs,
        usage: {
          input_tokens: opts.inputTokens,
          output_tokens: opts.outputTokens,
        },
      },
    });
    this.lastFinishReason = "success";
    this.pushEnd();
  }

  /** Finalize with an error-variant result message. */
  finishWithError(opts: {
    subtype: "error_during_execution" | "error_max_turns";
    errors: readonly string[];
    durationMs?: number;
  }): void {
    if (this.ended) return;
    this.push({
      kind: "msg",
      msg: {
        type: "result",
        subtype: opts.subtype,
        errors: opts.errors,
        duration_ms: opts.durationMs ?? 0,
      },
    });
    this.lastFinishReason = "error";
    this.pushEnd();
  }

  async interrupt(): Promise<void> {
    if (this.interrupted) return;
    this.interrupted = true;
    if (!this.ended) {
      this.lastFinishReason = "interrupted";
      this.pushEnd();
    }
  }

  // --- internals ---

  private push(value: PendingValue): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.queue.push(value);
    }
  }

  private pushEnd(): void {
    if (this.ended) return;
    this.ended = true;
    this.push({ kind: "end" });
  }

  private async pull(): Promise<PendingValue> {
    const head = this.queue.shift();
    if (head) return head;
    const waiter = createDeferred<PendingValue>();
    this.waiters.push(waiter);
    return waiter.promise;
  }

  private makeIterator(): AsyncIterator<SDKMessageLike> {
    return {
      next: async (): Promise<IteratorResult<SDKMessageLike>> => {
        const value = await this.pull();
        if (value.kind === "end") {
          return { value: undefined, done: true };
        }
        this.messagesConsumed += 1;
        return { value: value.msg, done: false };
      },
    };
  }
}
```

- [ ] **Step 4: Implement `spy-renderer.ts`**

```typescript
import type { RenderEvent } from "../../../../src/claude/render-event.js";

export type EmitFn = (event: RenderEvent) => Promise<void>;

/**
 * Records RenderEvents emitted by the session under test.
 *
 * - `events`: chronological list of everything the session emitted
 * - `emit`: the callback to pass to `session.submit(...)`
 * - `failNextEmitWith(err)`: arm the spy so the next emit call
 *   rejects — lets tests exercise the session's "emit threw" branch
 *   without smuggling in production Feishu-client errors
 */
export class SpyRenderer {
  readonly events: RenderEvent[] = [];
  private pendingError: unknown | null = null;

  readonly emit: EmitFn = async (event: RenderEvent) => {
    if (this.pendingError !== null) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    this.events.push(event);
  };

  failNextEmitWith(err: unknown): void {
    this.pendingError = err;
  }

  eventsOfType<T extends RenderEvent["type"]>(
    type: T,
  ): Extract<RenderEvent, { type: T }>[] {
    return this.events.filter(
      (e): e is Extract<RenderEvent, { type: T }> => e.type === type,
    );
  }
}
```

- [ ] **Step 5: Run smoke tests**

Run: `pnpm vitest run test/unit/claude/fakes/fakes.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add test/unit/claude/fakes/
git commit -m "test(claude): add FakeQueryHandle + SpyRenderer fixtures"
```

---

## Task 6: `ClaudeSession` state machine core — types, constructor, idle → generating happy path

**Files:**
- Modify: `src/claude/session.ts` (complete rewrite, but keep the existing exports `SDKMessageLike`, `SDKContentBlock`, `RenderEventEmitter` so dependent modules don't break mid-refactor)
- Create: `test/unit/claude/session-state-machine.test.ts`
- Delete: `test/unit/claude/session.test.ts` (replaced)

**Design decision:** Rewrite the session from scratch. The new public API:

```typescript
class ClaudeSession {
  constructor(opts: ClaudeSessionOptions);
  submit(input: CommandRouterResult, emit: EmitFn): Promise<SubmitOutcome>;
  stop(emit: EmitFn): Promise<void>;
  // Test-only seams (mangled name):
  _testGetState(): SessionState;
  _testGetQueueLength(): number;
}
```

Where `SubmitOutcome` is `{ kind: "started"; done: Promise<void> } | { kind: "queued"; position: number; done: Promise<void> } | { kind: "rejected"; reason: string }` and `done` is the per-input promise the dispatcher awaits so it can see failures.

Task 6 only implements the **idle → generating → idle happy path** for `submit({ kind: "run", text })`. Queueing, interrupt, stop, and the awaiting_permission transitions all come in later tasks.

- [ ] **Step 1: Delete the old session test file**

```bash
rm test/unit/claude/session.test.ts
```

(Its tests covered the Phase 3 `handleMessage` contract which no longer exists.)

- [ ] **Step 2: Write failing state-machine test for the happy path**

Create `test/unit/claude/session-state-machine.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ClaudeSession, type ClaudeSessionOptions } from "../../../src/claude/session.js";
import { FakeQueryHandle } from "./fakes/fake-query-handle.js";
import { SpyRenderer } from "./fakes/spy-renderer.js";
import { NullPermissionBroker } from "../../../src/claude/permission-broker.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import type { QueryFn, QueryHandle } from "../../../src/claude/query-handle.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
};

interface Harness {
  session: ClaudeSession;
  fakes: FakeQueryHandle[];
  queryFn: QueryFn;
  clock: FakeClock;
}

/**
 * Build a session with a queryFn that hands out a fresh
 * FakeQueryHandle per invocation. Tests grab successive fakes out of
 * `harness.fakes[i]` to drive each turn.
 */
function makeHarness(): Harness {
  const fakes: FakeQueryHandle[] = [];
  const queryFn: QueryFn = () => {
    const fake = new FakeQueryHandle();
    fakes.push(fake);
    return fake as QueryHandle;
  };
  const clock = new FakeClock();
  const opts: ClaudeSessionOptions = {
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    clock,
    permissionBroker: new NullPermissionBroker(),
    logger: SILENT_LOGGER,
  };
  return { session: new ClaudeSession(opts), fakes, queryFn, clock };
}

/** Tick the event loop so queued microtasks (processLoop kicks) run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("ClaudeSession — happy path (idle → generating → idle)", () => {
  it("transitions to generating on first submit and kicks off a turn", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    expect(h.session._testGetState()).toBe("idle");
    const outcome = await h.session.submit(
      { kind: "run", text: "hello" },
      spy.emit,
    );
    expect(outcome.kind).toBe("started");
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("generating");
    expect(h.fakes).toHaveLength(1);
    expect(h.fakes[0]!.messagesConsumed).toBe(0); // turn still waiting on first emit
  });

  it("forwards a text assistant block through the emit callback", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    const outcome = await h.session.submit(
      { kind: "run", text: "hi" },
      spy.emit,
    );
    expect(outcome.kind).toBe("started");
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    fake.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    });
    fake.finishWithSuccess({
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
    });
    if (outcome.kind !== "started") throw new Error("unreachable");
    await outcome.done;

    expect(spy.events).toEqual([
      { type: "text", text: "hello world" },
      { type: "turn_end", durationMs: 100, inputTokens: 10, outputTokens: 20 },
    ]);
    expect(h.session._testGetState()).toBe("idle");
  });

  it("passes cwd / model / permissionMode / settingSources to the injected queryFn", async () => {
    const recorded: Array<{ prompt: string; options: unknown }> = [];
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      recorded.push({ prompt: params.prompt, options: params.options });
      const fake = new FakeQueryHandle();
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new NullPermissionBroker(),
      logger: SILENT_LOGGER,
    });
    const spy = new SpyRenderer();
    const outcome = await session.submit({ kind: "run", text: "hi" }, spy.emit);
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    fakes[0]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.prompt).toBe("hi");
    expect(recorded[0]!.options).toEqual({
      cwd: "/tmp/cfc-test",
      model: "claude-opus-4-6",
      permissionMode: "default",
      settingSources: ["project"],
    });
  });

  it("rejects the per-input `done` promise when the turn ends with subtype=error", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "boom" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    h.fakes[0]!.finishWithError({
      subtype: "error_during_execution",
      errors: ["kaboom"],
    });
    await expect(outcome.done).rejects.toThrow(/kaboom|error_during_execution/);
    expect(h.session._testGetState()).toBe("idle");
  });

  it("rejects the per-input `done` promise when the turn ends without a result message", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "run", text: "incomplete" },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    // Interrupt ends the iterator WITHOUT a result message.
    await h.fakes[0]!.interrupt();
    await expect(outcome.done).rejects.toThrow(/without a result/);
  });

  it("returns to idle after the turn, ready to accept a second submit", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "one" }, spy.emit);
    if (first.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    h.fakes[0]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await first.done;
    expect(h.session._testGetState()).toBe("idle");

    const second = await h.session.submit({ kind: "run", text: "two" }, spy.emit);
    expect(second.kind).toBe("started");
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("generating");
    if (second.kind !== "started") throw new Error("unreachable");
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await second.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});
```

- [ ] **Step 3: Run to confirm fail**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: import-error fails because the new session shape doesn't exist yet.

- [ ] **Step 4: Rewrite `src/claude/session.ts` — scaffolding only**

Replace `src/claude/session.ts` with:

```typescript
import type { Logger } from "pino";
import { Mutex } from "../util/mutex.js";
import { createDeferred, type Deferred } from "../util/deferred.js";
import type { Clock } from "../util/clock.js";
import type { AppConfig } from "../types.js";
import type { RenderEvent } from "./render-event.js";
import type { QueryFn, QueryHandle } from "./query-handle.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { CommandRouterResult } from "../commands/router.js";
import { extractToolResultText, type ToolResultBlock } from "../feishu/tool-result.js";

// Preserved from Phase 3 — kept here because query-handle.ts and
// callers (cli-query.ts, dispatcher, tests) all import these.
export interface SDKMessageLike {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: readonly SDKContentBlock[] };
  result?: string;
  errors?: readonly string[];
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface SDKContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | readonly ToolResultBlock[];
}

export type { QueryFn, QueryHandle, ClaudeQueryOptions } from "./query-handle.js";

export type EmitFn = (event: RenderEvent) => Promise<void>;
export type RenderEventEmitter = EmitFn;

export type SessionState = "idle" | "generating" | "awaiting_permission";

export interface ClaudeSessionOptions {
  chatId: string;
  config: AppConfig["claude"];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  logger: Logger;
}

/**
 * Result of `session.submit(input, emit)`. The caller (dispatcher) uses
 * the shape to decide what to send back to the user immediately, and
 * awaits `done` for per-input backpressure and error propagation.
 */
export type SubmitOutcome =
  | { kind: "started"; done: Promise<void> }
  | { kind: "queued"; position: number; done: Promise<void> }
  | { kind: "rejected"; reason: string };

/**
 * Per-queue-entry state.  Each submitted input owns one of these
 * until its turn runs to completion (or is dropped by `!` / `/stop`).
 */
interface QueuedInput {
  readonly text: string;
  readonly emit: EmitFn;
  readonly done: Deferred<void>;
  /** Monotonic id for logging — not exposed to the outside. */
  readonly seq: number;
}

export class ClaudeSession {
  private readonly chatId: string;
  private readonly config: AppConfig["claude"];
  private readonly queryFn: QueryFn;
  // `clock` and `permissionBroker` are dependencies Phase 5 will use
  // (timers + canUseTool). Phase 4 only keeps them in the constructor
  // signature so Phase 5 is a drop-in addition without another
  // constructor churn.
  private readonly clock: Clock;
  private readonly permissionBroker: PermissionBroker;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();

  private state: SessionState = "idle";
  private readonly inputQueue: QueuedInput[] = [];
  private currentTurn: {
    input: QueuedInput;
    handle: QueryHandle;
  } | null = null;
  private nextSeq = 1;
  /**
   * Has a `processLoop` invocation been scheduled but not yet finished?
   * Used to avoid double-scheduling when multiple `submit`s race to
   * kick off a drain.
   */
  private loopRunning = false;

  constructor(opts: ClaudeSessionOptions) {
    this.chatId = opts.chatId;
    this.config = opts.config;
    this.queryFn = opts.queryFn;
    this.clock = opts.clock;
    this.permissionBroker = opts.permissionBroker;
    this.logger = opts.logger.child({ chat_id: opts.chatId });
    // Touch the unused-for-now deps so the compiler doesn't warn.
    void this.clock;
    void this.permissionBroker;
  }

  /**
   * Submit a parsed command to the session. Phase 4 wires `run` only;
   * `stop` and `interrupt_and_run` arrive in Tasks 8 and 9.
   */
  async submit(
    input: CommandRouterResult,
    emit: EmitFn,
  ): Promise<SubmitOutcome> {
    if (input.kind === "stop") {
      throw new Error("submit({kind:'stop'}) not implemented yet (Task 8)");
    }
    if (input.kind === "interrupt_and_run") {
      throw new Error("submit({kind:'interrupt_and_run'}) not implemented yet (Task 9)");
    }

    const handle: QueuedInput = {
      text: input.text,
      emit,
      done: createDeferred<void>(),
      seq: this.nextSeq++,
    };

    return await this.mutex.run(async () => {
      this.inputQueue.push(handle);
      if (this.state === "idle") {
        this.state = "generating";
        this.kickProcessLoop();
        return { kind: "started", done: handle.done.promise };
      }
      // Task 7 will flip this to return { kind: "queued", ... }; for
      // now, the happy-path tests only exercise the idle branch.
      throw new Error("queue branch not implemented yet (Task 7)");
    });
  }

  /** Phase 4 Task 8 will implement this. */
  async stop(_emit: EmitFn): Promise<void> {
    throw new Error("stop() not implemented yet (Task 8)");
  }

  // --- internals ---

  private kickProcessLoop(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    // Fire-and-forget. The loop is responsible for catching its own
    // errors and resolving each input's Deferred.
    void (async () => {
      try {
        await this.processLoop();
      } catch (err) {
        this.logger.error({ err }, "processLoop crashed — state machine may be inconsistent");
      } finally {
        this.loopRunning = false;
      }
    })();
  }

  private async processLoop(): Promise<void> {
    while (true) {
      const next = await this.mutex.run(async () => {
        const head = this.inputQueue.shift();
        if (!head) {
          this.state = "idle";
          this.currentTurn = null;
          return null;
        }
        return head;
      });
      if (next === null) return;

      const handle = this.queryFn({
        prompt: next.text,
        options: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode: this.config.defaultPermissionMode,
          settingSources: ["project"],
        },
      });
      this.currentTurn = { input: next, handle };

      try {
        await this.runTurn(next, handle);
        next.done.resolve();
      } catch (err) {
        this.logger.error({ err, seq: next.seq }, "Claude turn failed");
        next.done.reject(err);
      } finally {
        this.currentTurn = null;
      }
    }
  }

  private async runTurn(input: QueuedInput, handle: QueryHandle): Promise<void> {
    this.logger.info({ len: input.text.length, seq: input.seq }, "Claude turn start");
    let resultMsg: SDKMessageLike | undefined;

    for await (const msg of handle.messages) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          await this.emitAssistantBlock(block, input.emit);
        }
      } else if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            await input.emit({
              type: "tool_result",
              toolUseId: block.tool_use_id ?? "",
              isError: block.is_error === true,
              text: extractToolResultText(block.content),
            });
          }
        }
      } else if (msg.type === "result") {
        resultMsg = msg;
      }
    }

    if (resultMsg === undefined) {
      throw new Error("Claude turn ended without a result message");
    }
    if (resultMsg.subtype !== "success") {
      const errs = resultMsg.errors?.join("; ") ?? "unknown error";
      this.logger.error(
        { subtype: resultMsg.subtype, errors: resultMsg.errors, seq: input.seq },
        "Claude turn errored",
      );
      throw new Error(`Claude turn failed (${resultMsg.subtype}): ${errs}`);
    }

    await input.emit({
      type: "turn_end",
      durationMs: resultMsg.duration_ms ?? 0,
      inputTokens: resultMsg.usage?.input_tokens ?? 0,
      outputTokens: resultMsg.usage?.output_tokens ?? 0,
    });
    this.logger.info({ durationMs: resultMsg.duration_ms, seq: input.seq }, "Claude turn complete");
  }

  private async emitAssistantBlock(
    block: SDKContentBlock,
    emit: EmitFn,
  ): Promise<void> {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      await emit({ type: "text", text: block.text });
      return;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      await emit({ type: "thinking", text: block.thinking });
      return;
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      await emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      return;
    }
  }

  // --- test seams ---

  /** @internal */
  _testGetState(): SessionState {
    return this.state;
  }

  /** @internal */
  _testGetQueueLength(): number {
    return this.inputQueue.length;
  }
}
```

- [ ] **Step 5: Fix the `src/index.ts` / `src/claude/session-manager.ts` call sites that broke**

`src/index.ts` still calls `session.handleMessage(msg.text, emit)` — this file will be fully rewired in Task 10. For now, just make it compile by switching the call to the new `submit` API (it will still work end-to-end for single-turn traffic):

```typescript
// Replace this line in src/index.ts onMessage:
//   await session.handleMessage(msg.text, emit);
// with:
import { parseInput } from "./commands/router.js";
// ...
const parsed = parseInput(msg.text);
if (parsed.kind === "stop") {
  // Task 10 will wire the real /stop handler; for now treat it as a run
  // to keep the compile green.
  await session.submit({ kind: "run", text: msg.text }, emit);
} else if (parsed.kind === "interrupt_and_run") {
  await session.submit({ kind: "run", text: parsed.text }, emit);
} else {
  const outcome = await session.submit(parsed, emit);
  if (outcome.kind === "started" || outcome.kind === "queued") {
    await outcome.done;
  }
}
```

This is placeholder wiring — Task 10 replaces it with the full router integration.

Update `src/claude/session-manager.ts` to pass `clock` and `permissionBroker`:

```typescript
import type { Logger } from "pino";
import { ClaudeSession, type QueryFn } from "./session.js";
import type { Clock } from "../util/clock.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { AppConfig } from "../types.js";

export interface ClaudeSessionManagerOptions {
  config: AppConfig["claude"];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  logger: Logger;
}

export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly opts: ClaudeSessionManagerOptions;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  getOrCreate(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (session === undefined) {
      session = new ClaudeSession({
        chatId,
        config: this.opts.config,
        queryFn: this.opts.queryFn,
        clock: this.opts.clock,
        permissionBroker: this.opts.permissionBroker,
        logger: this.opts.logger,
      });
      this.sessions.set(chatId, session);
    }
    return session;
  }
}
```

And `src/index.ts` must pass `clock` + `permissionBroker` to the session manager constructor:

```typescript
import { RealClock } from "./util/clock.js";
import { NullPermissionBroker } from "./claude/permission-broker.js";
// ...
const sessionManager = new ClaudeSessionManager({
  config: config.claude,
  queryFn,
  clock: new RealClock(),
  permissionBroker: new NullPermissionBroker(),
  logger,
});
```

Update `test/unit/claude/session-manager.test.ts` similarly — pass a `new FakeClock()` and `new NullPermissionBroker()` to every `ClaudeSessionManager` constructor call.

- [ ] **Step 6: Run tests to verify happy-path tests pass**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: 6/6 PASS.

Run: `pnpm vitest run` (full suite)
Expected: All existing tests still pass, including session-manager tests.

Run: `pnpm typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/claude/session.ts src/claude/session-manager.ts src/index.ts \
  test/unit/claude/session-state-machine.test.ts test/unit/claude/session-manager.test.ts
git rm test/unit/claude/session.test.ts
git commit -m "refactor(claude): rewrite ClaudeSession with explicit state + processLoop"
```

---

## Task 7: FIFO queue behavior — submit while generating

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `test/unit/claude/session-state-machine.test.ts`

**Design decision:** When `submit({ kind: "run" })` lands while state is `generating`, the input is appended to the queue and the outcome is `{ kind: "queued", position: queue.length }`. The session also calls `emit({ type: "queued", position })` exactly once, inside the `submit` call (so the "queued #N" notice races with no other emits for that input). The input's `done` Promise resolves only when its specific turn runs to completion later, so the caller blocks as long as they do for a non-queued submit — preserving the Phase 3 backpressure contract for ordered delivery.

- [ ] **Step 1: Add failing tests for queue behavior**

Append to `session-state-machine.test.ts`:

```typescript
describe("ClaudeSession — FIFO queue", () => {
  it("second submit while generating returns queued #1 without consuming a new turn", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "one" }, spy1.emit);
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(1);
    expect(first.kind).toBe("started");

    const second = await h.session.submit({ kind: "run", text: "two" }, spy2.emit);
    expect(second.kind).toBe("queued");
    if (second.kind !== "queued") throw new Error("unreachable");
    expect(second.position).toBe(1);
    expect(h.session._testGetQueueLength()).toBe(1);
    // Still only one turn has been created.
    expect(h.fakes).toHaveLength(1);
    // And the queued emit was delivered.
    expect(spy2.events).toEqual([{ type: "queued", position: 1 }]);
  });

  it("third submit lands at position 2", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spy3 = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "one" }, spy1.emit);
    await flushMicrotasks();
    await h.session.submit({ kind: "run", text: "two" }, spy2.emit);
    const third = await h.session.submit({ kind: "run", text: "three" }, spy3.emit);

    expect(third.kind).toBe("queued");
    if (third.kind !== "queued") throw new Error("unreachable");
    expect(third.position).toBe(2);
    expect(spy3.events).toEqual([{ type: "queued", position: 2 }]);
    void first;
  });

  it("drains the queue in FIFO order after each turn ends", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spy3 = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "one" }, spy1.emit);
    await flushMicrotasks();
    const second = await h.session.submit({ kind: "run", text: "two" }, spy2.emit);
    const third = await h.session.submit({ kind: "run", text: "three" }, spy3.emit);
    if (first.kind !== "started" || second.kind !== "queued" || third.kind !== "queued") {
      throw new Error("unreachable");
    }

    // End turn 1 → drain pulls "two"
    h.fakes[0]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply one" }] },
    });
    h.fakes[0]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await first.done;
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(2);

    // End turn 2 → drain pulls "three"
    h.fakes[1]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply two" }] },
    });
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await second.done;
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(3);

    // End turn 3 → back to idle
    h.fakes[2]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply three" }] },
    });
    h.fakes[2]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await third.done;
    expect(h.session._testGetState()).toBe("idle");

    // Each turn's reply landed on the right emit.
    expect(spy1.events.some((e) => e.type === "text" && e.text === "reply one")).toBe(true);
    expect(spy2.events.some((e) => e.type === "text" && e.text === "reply two")).toBe(true);
    expect(spy3.events.some((e) => e.type === "text" && e.text === "reply three")).toBe(true);
  });

  it("a turn that fails still allows the next queued input to run", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "bad" }, spy1.emit);
    await flushMicrotasks();
    const second = await h.session.submit({ kind: "run", text: "good" }, spy2.emit);
    if (first.kind !== "started" || second.kind !== "queued") throw new Error("unreachable");

    h.fakes[0]!.finishWithError({
      subtype: "error_during_execution",
      errors: ["boom"],
    });
    await expect(first.done).rejects.toThrow(/boom/);
    await flushMicrotasks();

    // Drain picked up turn 2 despite turn 1's error.
    expect(h.fakes).toHaveLength(2);
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await second.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts -t "FIFO queue"`
Expected: FAIL with "queue branch not implemented yet (Task 7)".

- [ ] **Step 3: Implement the queue branch in `submit`**

Replace the `submit` method body in `src/claude/session.ts`:

```typescript
async submit(
  input: CommandRouterResult,
  emit: EmitFn,
): Promise<SubmitOutcome> {
  if (input.kind === "stop") {
    throw new Error("submit({kind:'stop'}) not implemented yet (Task 8)");
  }
  if (input.kind === "interrupt_and_run") {
    throw new Error("submit({kind:'interrupt_and_run'}) not implemented yet (Task 9)");
  }

  const handle: QueuedInput = {
    text: input.text,
    emit,
    done: createDeferred<void>(),
    seq: this.nextSeq++,
  };

  const outcome = await this.mutex.run(async (): Promise<SubmitOutcome> => {
    this.inputQueue.push(handle);
    if (this.state === "idle") {
      this.state = "generating";
      this.kickProcessLoop();
      return { kind: "started", done: handle.done.promise };
    }
    // state is "generating" or "awaiting_permission" — the input
    // sits in the queue until the current turn (and anything already
    // queued ahead of it) has drained. Position is 1-indexed and
    // reflects how many entries are ahead of us PLUS this one — so
    // the first queued input is #1, the second is #2, etc.
    const position = this.inputQueue.length - 1; // entries ahead of us
    return {
      kind: "queued",
      // We want position to be "nth queued", which is how many things
      // are ahead of us (we just pushed, so length is ahead + 1). Add
      // 1 if we want 1-based, which we do: "queued #1" for the first
      // backlogged input. Readjust:
      position: position, // hmm, recalc below
      done: handle.done.promise,
    };
  });

  // Fire the out-of-band "queued" notice after releasing the lock.
  // Doing this OUTSIDE the lock keeps the mutex fast, and since emit
  // is per-input there's no concurrency issue (this input's emit
  // hasn't been used yet).
  if (outcome.kind === "queued") {
    try {
      await emit({ type: "queued", position: outcome.position });
    } catch (err) {
      this.logger.warn(
        { err, seq: handle.seq },
        "emit({type:'queued'}) threw — continuing",
      );
    }
  }
  return outcome;
}
```

Wait — the position calculation above is wrong. Let me think again. The queue has `[already-running-head, ..., this new input]`. `this.inputQueue` only holds QUEUED inputs (the currently running turn was already shifted out by `processLoop` — it lives in `currentTurn`, not in `inputQueue`). So after pushing, `this.inputQueue.length` IS the 1-indexed position of this new input.

Correct the code:

```typescript
const outcome = await this.mutex.run(async (): Promise<SubmitOutcome> => {
  this.inputQueue.push(handle);
  if (this.state === "idle") {
    this.state = "generating";
    this.kickProcessLoop();
    return { kind: "started", done: handle.done.promise };
  }
  // The currently-running turn lives in `currentTurn`, not in
  // `inputQueue`. Pushing to the queue means this input is at
  // position `inputQueue.length` (1-indexed, since the running turn
  // is not in the queue).
  return {
    kind: "queued",
    position: this.inputQueue.length,
    done: handle.done.promise,
  };
});
```

Also, there's still a subtle race: `kickProcessLoop` runs the drain in a background async function. Between the mutex release and the first iteration of `processLoop`, the input is in the queue. A second `submit` could land in that window and correctly get `queued #1`... but wait, `processLoop` acquires the mutex to shift, so the second submit's push happens inside the same mutex cycle as the first submit's push OR inside `processLoop`'s shift — they can't interleave. Good.

Verify the fix compiles. Delete the incorrect `position: position` block and use the recalculated form.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: All 10 tests PASS (6 happy path + 4 queue).

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): FIFO queue when submit lands while generating"
```

---

## Task 8: `stop()` — all three states

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `test/unit/claude/session-state-machine.test.ts`
- Modify: `src/index.ts`

**Design decision:** `session.stop(emit)` is separate from `submit({ kind: "stop" })` so the dispatcher can call it without building a fake `QueuedInput`. Behavior:
- `idle`: emit `{ type: "text", text: formatStopAck() }` via the caller's emit (so the user still sees "🛑 已停止" even when nothing was running), return. No state change.
- `generating`: clear the queue (each dropped entry rejects its `done` with an `InterruptedError`), call `currentTurn.handle.interrupt()` OUTSIDE the mutex, emit stop ack. State returns to idle once the in-flight turn's iterator drains (the processLoop handles this naturally).
- `awaiting_permission`: (Task 10 will add the permission-broker cancel wiring; Task 8 just asserts the behavior with the test seam.) Clear the queue, cancel the pending permission Deferred, interrupt, emit ack.

The `InterruptedError` class lives in `src/claude/session.ts` and carries a `reason: "stop" | "bang_prefix"` so the dispatcher can distinguish them without string-matching.

Dropping queue entries emits `{ type: "interrupted", reason: "stop" }` on each entry's own emit before rejecting its `done` — so the dispatcher renders "⚠️ 你之前的消息..." for every dropped input without special-casing.

- [ ] **Step 1: Add failing stop() tests**

Append to `session-state-machine.test.ts`:

```typescript
describe("ClaudeSession — /stop", () => {
  it("stop in idle emits stop ack and stays idle", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    await h.session.stop(spy.emit);
    expect(h.session._testGetState()).toBe("idle");
    // idle /stop is rendered as a plain text ack via the emit
    // callback — the session doesn't know how the dispatcher wants
    // to render it, so it uses `{type:"text"}` with the canonical
    // stop-ack string.
    expect(spy.events).toEqual([
      { type: "text", text: "🛑 已停止" },
    ]);
  });

  it("stop in generating interrupts the current turn, clears the queue, and returns to idle", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const stopSpy = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "one" }, spy1.emit);
    await flushMicrotasks();
    const second = await h.session.submit({ kind: "run", text: "two" }, spy2.emit);
    if (first.kind !== "started" || second.kind !== "queued") throw new Error("unreachable");

    // Fire the stop.
    await h.session.stop(stopSpy.emit);

    // The running turn's first handle was interrupted.
    expect(h.fakes[0]!.interrupted).toBe(true);
    // The queued second input got an "interrupted" out-of-band event
    // on its own emit and its done promise rejected with the stop reason.
    expect(spy2.events).toEqual([
      { type: "queued", position: 1 },
      { type: "interrupted", reason: "stop" },
    ]);
    await expect(second.done).rejects.toThrow(/stop|interrupted/i);

    // Turn 1 ends abnormally → first.done rejects.
    await expect(first.done).rejects.toThrow();

    // After the in-flight turn's iterator drains, state returns to idle.
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");

    // Stop ack was emitted via the caller's emit.
    expect(stopSpy.events).toEqual([
      { type: "text", text: "🛑 已停止" },
    ]);
  });

  it("two /stop calls in a row are idempotent — second is a no-op ack", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    await h.session.stop(spy.emit);
    await h.session.stop(spy.emit);
    expect(h.session._testGetState()).toBe("idle");
    expect(spy.events).toEqual([
      { type: "text", text: "🛑 已停止" },
      { type: "text", text: "🛑 已停止" },
    ]);
  });

  it("stop during generating does NOT lose subsequently-submitted inputs", async () => {
    // Regression guard: after stop() returns, the next submit() should
    // start a fresh turn, not be swallowed by the draining state.
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const stopSpy = new SpyRenderer();
    const spy2 = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "one" }, spy1.emit);
    await flushMicrotasks();
    await h.session.stop(stopSpy.emit);
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");

    const second = await h.session.submit({ kind: "run", text: "two" }, spy2.emit);
    expect(second.kind).toBe("started");
    if (second.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await second.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts -t "stop"`
Expected: FAIL (stop() throws "not implemented").

- [ ] **Step 3: Implement `stop()`**

Add to `src/claude/session.ts`:

```typescript
import { formatStopAck } from "../feishu/messages.js";

/**
 * Error rejected on a QueuedInput's `done` promise when its turn was
 * dropped before it ran (either by `/stop` or by a `!` prefix). The
 * `reason` field matches the RenderEvent `interrupted` variant so
 * dispatchers can render both consistently.
 */
export class InterruptedError extends Error {
  constructor(public readonly reason: "stop" | "bang_prefix") {
    super(`turn interrupted: ${reason}`);
    this.name = "InterruptedError";
  }
}
```

Replace the placeholder `stop()` method:

```typescript
async stop(emit: EmitFn): Promise<void> {
  // Gather the interrupt target + drain the queue under the lock.
  // We don't await the interrupt INSIDE the lock so other submits
  // aren't blocked on the child's exit.
  const toDrop: QueuedInput[] = [];
  let toInterrupt: QueryHandle | null = null;

  await this.mutex.run(async () => {
    if (this.state === "idle") {
      // Nothing to stop. Ack and return.
      return;
    }
    toInterrupt = this.currentTurn?.handle ?? null;
    while (this.inputQueue.length > 0) {
      toDrop.push(this.inputQueue.shift()!);
    }
    // The currentTurn's Deferred is NOT rejected here — it will
    // reject naturally when runTurn observes the interrupted iterator.
  });

  // 1. Notify each dropped input via its own emit, then reject its done.
  for (const dropped of toDrop) {
    try {
      await dropped.emit({ type: "interrupted", reason: "stop" });
    } catch (err) {
      this.logger.warn(
        { err, seq: dropped.seq },
        "emit interrupted event threw — continuing to reject done",
      );
    }
    dropped.done.reject(new InterruptedError("stop"));
  }

  // 2. Ask the in-flight turn to terminate.
  if (toInterrupt !== null) {
    try {
      await (toInterrupt as QueryHandle).interrupt();
    } catch (err) {
      this.logger.warn({ err }, "currentTurn.interrupt() threw");
    }
  }

  // 3. Ack the caller.
  try {
    await emit({ type: "text", text: formatStopAck() });
  } catch (err) {
    this.logger.warn({ err }, "stop ack emit threw");
  }
}
```

Note: when `runTurn` throws because the iterator ended without a result (interrupt case), the processLoop catches that, rejects the running turn's `done`, and continues to drain — which now finds an empty queue and sets state back to `idle`. No extra logic needed.

- [ ] **Step 4: Wire `formatStopAck` import if not already imported**

Ensure `src/claude/session.ts` imports `formatStopAck` from `src/feishu/messages.ts`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: All happy-path / queue / stop tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/claude/session.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): implement stop() across all states + InterruptedError"
```

---

## Task 9: `!` prefix interrupt

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `test/unit/claude/session-state-machine.test.ts`

**Design decision:** `submit({ kind: "interrupt_and_run", text })` in any non-idle state means: drop the queue (emit `{ type: "interrupted", reason: "bang_prefix" }` on each dropped input, reject their `done`), call `currentTurn.handle.interrupt()`, push the new input to the queue. When the current turn's iterator drains, the processLoop will naturally pick up the new input. If the session is already idle, `!foo` is equivalent to `submit({ kind: "run", text: foo })`.

The `interrupt_and_run` path returns `{ kind: "started", done }` — it never returns `queued`, because the semantics are "run this NEXT no matter what".

- [ ] **Step 1: Add failing tests**

Append to `session-state-machine.test.ts`:

```typescript
describe("ClaudeSession — ! prefix interrupt", () => {
  it("interrupt_and_run in idle is equivalent to run", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      { kind: "interrupt_and_run", text: "urgent" },
      spy.emit,
    );
    expect(outcome.kind).toBe("started");
    await flushMicrotasks();
    expect(h.fakes).toHaveLength(1);
    expect(h.session._testGetState()).toBe("generating");
  });

  it("interrupt_and_run in generating: drops queue, interrupts turn, runs new input next", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spy3 = new SpyRenderer();
    const spyBang = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "one" }, spy1.emit);
    await flushMicrotasks();
    const second = await h.session.submit({ kind: "run", text: "two" }, spy2.emit);
    const third = await h.session.submit({ kind: "run", text: "three" }, spy3.emit);
    if (first.kind !== "started" || second.kind !== "queued" || third.kind !== "queued") {
      throw new Error("unreachable");
    }

    // Fire the bang.
    const bang = await h.session.submit(
      { kind: "interrupt_and_run", text: "urgent" },
      spyBang.emit,
    );
    expect(bang.kind).toBe("started");
    expect(h.fakes[0]!.interrupted).toBe(true);

    // Previously-queued inputs are rejected with bang_prefix.
    expect(spy2.events).toContainEqual({ type: "interrupted", reason: "bang_prefix" });
    expect(spy3.events).toContainEqual({ type: "interrupted", reason: "bang_prefix" });
    await expect(second.done).rejects.toThrow(/bang_prefix|interrupted/i);
    await expect(third.done).rejects.toThrow(/bang_prefix|interrupted/i);

    // First turn's iterator drains (interrupted) → first.done rejects.
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();

    // Next turn is the bang input.
    expect(h.fakes).toHaveLength(2);
    h.fakes[1]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "urgent reply" }] },
    });
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    if (bang.kind !== "started") throw new Error("unreachable");
    await bang.done;

    expect(spyBang.events.some((e) => e.type === "text" && e.text === "urgent reply")).toBe(true);
    expect(h.session._testGetState()).toBe("idle");
  });

  it("interrupt_and_run on top of another interrupt_and_run replaces the new input", async () => {
    // Rapid double-bang: only the LAST bang's input should actually run.
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spyBang1 = new SpyRenderer();
    const spyBang2 = new SpyRenderer();

    const first = await h.session.submit({ kind: "run", text: "one" }, spy1.emit);
    await flushMicrotasks();

    const bang1 = await h.session.submit(
      { kind: "interrupt_and_run", text: "bang1" },
      spyBang1.emit,
    );
    const bang2 = await h.session.submit(
      { kind: "interrupt_and_run", text: "bang2" },
      spyBang2.emit,
    );
    if (first.kind !== "started" || bang1.kind !== "started" || bang2.kind !== "started") {
      throw new Error("unreachable");
    }

    // bang1 was dropped by bang2 (since it was queued when bang2 arrived).
    await expect(bang1.done).rejects.toThrow(/bang_prefix|interrupted/i);
    expect(spyBang1.events).toContainEqual({ type: "interrupted", reason: "bang_prefix" });

    // The in-flight first turn was interrupted by whichever bang landed first.
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();

    // Turn 2 runs bang2.
    h.fakes[1]!.emitMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "bang2 reply" }] },
    });
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await bang2.done;
    expect(spyBang2.events.some((e) => e.type === "text" && e.text === "bang2 reply")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts -t "prefix interrupt"`
Expected: FAIL (interrupt_and_run throws "not implemented").

- [ ] **Step 3: Implement `interrupt_and_run` in `submit`**

Rewrite `submit` once more to handle all three `CommandRouterResult` kinds:

```typescript
async submit(
  input: CommandRouterResult,
  emit: EmitFn,
): Promise<SubmitOutcome> {
  if (input.kind === "stop") {
    // Route through stop() for consistency — but stop() doesn't
    // return a SubmitOutcome, so synthesize a rejected outcome so
    // the dispatcher can handle it uniformly.
    await this.stop(emit);
    return { kind: "rejected", reason: "stop" };
  }

  const handle: QueuedInput = {
    text: input.text,
    emit,
    done: createDeferred<void>(),
    seq: this.nextSeq++,
  };

  if (input.kind === "interrupt_and_run") {
    return await this.submitInterruptAndRun(handle);
  }

  // Plain run.
  const outcome = await this.mutex.run(async (): Promise<SubmitOutcome> => {
    this.inputQueue.push(handle);
    if (this.state === "idle") {
      this.state = "generating";
      this.kickProcessLoop();
      return { kind: "started", done: handle.done.promise };
    }
    return {
      kind: "queued",
      position: this.inputQueue.length,
      done: handle.done.promise,
    };
  });

  if (outcome.kind === "queued") {
    try {
      await emit({ type: "queued", position: outcome.position });
    } catch (err) {
      this.logger.warn(
        { err, seq: handle.seq },
        "emit({type:'queued'}) threw — continuing",
      );
    }
  }
  return outcome;
}

private async submitInterruptAndRun(
  handle: QueuedInput,
): Promise<SubmitOutcome> {
  const toDrop: QueuedInput[] = [];
  let toInterrupt: QueryHandle | null = null;

  await this.mutex.run(async () => {
    // Drop everything currently queued.
    while (this.inputQueue.length > 0) {
      toDrop.push(this.inputQueue.shift()!);
    }
    toInterrupt = this.currentTurn?.handle ?? null;
    // Push the new input.
    this.inputQueue.push(handle);
    // If the session is idle, start the processLoop for the new input.
    if (this.state === "idle") {
      this.state = "generating";
      this.kickProcessLoop();
    }
    // If non-idle, processLoop is already draining — it will pick up
    // our new handle after the current turn's iterator drains.
  });

  // Notify dropped inputs + reject their promises.
  for (const dropped of toDrop) {
    try {
      await dropped.emit({ type: "interrupted", reason: "bang_prefix" });
    } catch (err) {
      this.logger.warn(
        { err, seq: dropped.seq },
        "emit interrupted event threw — continuing to reject done",
      );
    }
    dropped.done.reject(new InterruptedError("bang_prefix"));
  }

  // Ask the in-flight turn to terminate (if any). The new input waits
  // in the queue until runTurn throws and the processLoop drains it.
  if (toInterrupt !== null) {
    try {
      await (toInterrupt as QueryHandle).interrupt();
    } catch (err) {
      this.logger.warn({ err }, "interrupt_and_run: currentTurn.interrupt() threw");
    }
  }

  return { kind: "started", done: handle.done.promise };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: All tests PASS (happy path + queue + stop + bang prefix).

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): implement ! prefix interrupt across states"
```

---

## Task 10: `awaiting_permission` stub + exit transitions

**Files:**
- Modify: `src/claude/session.ts` (add `_testEnterAwaitingPermission(deferred)` seam + route `!`/`/stop` through it)
- Modify: `test/unit/claude/session-state-machine.test.ts`

**Design decision:** Phase 4 does not implement the real entry path into `awaiting_permission` — that requires the SDK canUseTool bridge which is Phase 5. But the state MUST exist in the enum and the `!` / `/stop` exit transitions MUST be tested, because those are the tricky ones and testing them in Phase 5 alongside the canUseTool wiring would mix concerns.

The test seam `_testEnterAwaitingPermission(permissionDeferred)` flips the state to `awaiting_permission` and stores the `Deferred<PermissionResponse>` that `stop` / `!` will reject. This simulates what Phase 5's real `canUseTool` bridge will do:

```typescript
// Phase 5 entry point (sketch — NOT implemented in Phase 4):
// async onCanUseTool(req: PermissionRequest): Promise<PermissionResponse> {
//   const d = createDeferred<PermissionResponse>();
//   this.state = "awaiting_permission";
//   this.pendingPermission = d;
//   // ... send card, start timer ...
//   const response = await d.promise;
//   this.state = "generating";
//   return response;
// }
```

When `stop` or `!` lands in `awaiting_permission`, the session:
1. Resolves `pendingPermission` with `{ behavior: "deny", message: "user_cancelled" }` — this lets the SDK callback return with deny, which tells Claude the tool call was denied, which lets the turn finish naturally. (Phase 5 will add the card ack.)
2. Interrupts the current turn (as in `generating`).
3. Drops the queue.

- [ ] **Step 1: Add failing tests**

Append to `session-state-machine.test.ts`:

```typescript
import { createDeferred } from "../../../src/util/deferred.js";
import type { PermissionResponse } from "../../../src/claude/permission-broker.js";

describe("ClaudeSession — awaiting_permission stub", () => {
  it("state is 'awaiting_permission' after the test seam flips it", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const first = await h.session.submit({ kind: "run", text: "one" }, spy.emit);
    await flushMicrotasks();
    if (first.kind !== "started") throw new Error("unreachable");

    const permissionDeferred = createDeferred<PermissionResponse>();
    h.session._testEnterAwaitingPermission(permissionDeferred);
    expect(h.session._testGetState()).toBe("awaiting_permission");

    // Clean up so the test doesn't hang: let the seam know we're done.
    permissionDeferred.resolve({ behavior: "deny", message: "test-cleanup" });
    h.session._testLeaveAwaitingPermission();
    await flushMicrotasks();
    h.fakes[0]!.interrupt();
    await expect(first.done).rejects.toThrow();
  });

  it("/stop in awaiting_permission denies the pending permission and interrupts", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();
    const stopSpy = new SpyRenderer();
    const first = await h.session.submit({ kind: "run", text: "one" }, spy.emit);
    await flushMicrotasks();
    if (first.kind !== "started") throw new Error("unreachable");

    const permissionDeferred = createDeferred<PermissionResponse>();
    h.session._testEnterAwaitingPermission(permissionDeferred);

    await h.session.stop(stopSpy.emit);

    // Permission deferred was resolved with a deny response.
    const resp = await permissionDeferred.promise;
    expect(resp).toEqual({
      behavior: "deny",
      message: "user_cancelled",
    });
    // Turn handle was interrupted.
    expect(h.fakes[0]!.interrupted).toBe(true);
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");
    expect(stopSpy.events).toEqual([
      { type: "text", text: "🛑 已停止" },
    ]);
  });

  it("! prefix in awaiting_permission denies, drops queue, interrupts, then runs the new input", async () => {
    const h = makeHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spyBang = new SpyRenderer();
    const first = await h.session.submit({ kind: "run", text: "one" }, spy1.emit);
    await flushMicrotasks();
    const second = await h.session.submit({ kind: "run", text: "two" }, spy2.emit);
    if (first.kind !== "started" || second.kind !== "queued") throw new Error("unreachable");

    const permissionDeferred = createDeferred<PermissionResponse>();
    h.session._testEnterAwaitingPermission(permissionDeferred);

    const bang = await h.session.submit(
      { kind: "interrupt_and_run", text: "urgent" },
      spyBang.emit,
    );
    if (bang.kind !== "started") throw new Error("unreachable");

    // Permission deferred was denied.
    const resp = await permissionDeferred.promise;
    expect(resp.behavior).toBe("deny");

    // Queue was cleared.
    await expect(second.done).rejects.toThrow(/bang_prefix|interrupted/i);

    // Turn interrupted → first.done rejects.
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();

    // Next turn runs bang.
    expect(h.fakes).toHaveLength(2);
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await bang.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts -t "awaiting_permission"`
Expected: FAIL (test seams don't exist).

- [ ] **Step 3: Add the test seams + permission-aware exit transitions**

Add to `src/claude/session.ts`:

```typescript
// Inside the ClaudeSession class, add:
private pendingPermission: Deferred<import("./permission-broker.js").PermissionResponse> | null = null;

/** @internal test seam — do not call from production code */
_testEnterAwaitingPermission(
  deferred: Deferred<import("./permission-broker.js").PermissionResponse>,
): void {
  this.state = "awaiting_permission";
  this.pendingPermission = deferred;
}

/** @internal test seam — exits awaiting_permission back to generating */
_testLeaveAwaitingPermission(): void {
  this.state = "generating";
  this.pendingPermission = null;
}
```

Update `stop()` to handle the awaiting_permission branch:

```typescript
async stop(emit: EmitFn): Promise<void> {
  const toDrop: QueuedInput[] = [];
  let toInterrupt: QueryHandle | null = null;
  let permissionToDeny: Deferred<import("./permission-broker.js").PermissionResponse> | null = null;

  await this.mutex.run(async () => {
    if (this.state === "idle") return;
    toInterrupt = this.currentTurn?.handle ?? null;
    if (this.state === "awaiting_permission") {
      permissionToDeny = this.pendingPermission;
      this.pendingPermission = null;
      // Flip back to generating so the processLoop's finally branch
      // can observe a consistent state during turn teardown.
      this.state = "generating";
    }
    while (this.inputQueue.length > 0) {
      toDrop.push(this.inputQueue.shift()!);
    }
  });

  // Resolve pending permission with deny.
  if (permissionToDeny !== null) {
    (permissionToDeny as Deferred<import("./permission-broker.js").PermissionResponse>).resolve({
      behavior: "deny",
      message: "user_cancelled",
    });
  }

  for (const dropped of toDrop) {
    try {
      await dropped.emit({ type: "interrupted", reason: "stop" });
    } catch (err) {
      this.logger.warn({ err, seq: dropped.seq }, "emit interrupted event threw");
    }
    dropped.done.reject(new InterruptedError("stop"));
  }

  if (toInterrupt !== null) {
    try {
      await (toInterrupt as QueryHandle).interrupt();
    } catch (err) {
      this.logger.warn({ err }, "currentTurn.interrupt() threw");
    }
  }

  try {
    await emit({ type: "text", text: formatStopAck() });
  } catch (err) {
    this.logger.warn({ err }, "stop ack emit threw");
  }
}
```

Update `submitInterruptAndRun` similarly — before interrupting, resolve any pending permission with `{ behavior: "deny", message: "user_cancelled" }`:

```typescript
private async submitInterruptAndRun(
  handle: QueuedInput,
): Promise<SubmitOutcome> {
  const toDrop: QueuedInput[] = [];
  let toInterrupt: QueryHandle | null = null;
  let permissionToDeny: Deferred<import("./permission-broker.js").PermissionResponse> | null = null;

  await this.mutex.run(async () => {
    while (this.inputQueue.length > 0) {
      toDrop.push(this.inputQueue.shift()!);
    }
    toInterrupt = this.currentTurn?.handle ?? null;
    if (this.state === "awaiting_permission") {
      permissionToDeny = this.pendingPermission;
      this.pendingPermission = null;
      this.state = "generating";
    }
    this.inputQueue.push(handle);
    if (this.state === "idle") {
      this.state = "generating";
      this.kickProcessLoop();
    }
  });

  if (permissionToDeny !== null) {
    (permissionToDeny as Deferred<import("./permission-broker.js").PermissionResponse>).resolve({
      behavior: "deny",
      message: "user_cancelled",
    });
  }

  for (const dropped of toDrop) {
    try {
      await dropped.emit({ type: "interrupted", reason: "bang_prefix" });
    } catch (err) {
      this.logger.warn({ err, seq: dropped.seq }, "emit interrupted event threw");
    }
    dropped.done.reject(new InterruptedError("bang_prefix"));
  }

  if (toInterrupt !== null) {
    try {
      await (toInterrupt as QueryHandle).interrupt();
    } catch (err) {
      this.logger.warn({ err }, "interrupt_and_run: currentTurn.interrupt() threw");
    }
  }

  return { kind: "started", done: handle.done.promise };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): awaiting_permission state + exit transitions"
```

---

## Task 11: Dispatcher integration in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Design decision:** Wire the `parseInput` router into `onMessage`, route `{ kind: "stop" }` to `session.stop(emit)`, route `{ kind: "run" }` / `{ kind: "interrupt_and_run" }` to `session.submit(...)` and await the per-input `done`. Use the existing top-level try/catch to convert any rejected `done` into the user-visible error reply — the dispatcher doesn't have to distinguish `InterruptedError` from other errors because the session already emitted the appropriate out-of-band notice before rejecting.

- [ ] **Step 1: Update the `onMessage` handler in `src/index.ts`**

Replace the Phase 3 call path:

```typescript
// Before (placeholder from Task 6 Step 5):
const parsed = parseInput(msg.text);
if (parsed.kind === "stop") {
  // Task 10 will wire the real /stop handler; for now treat it as a run
  await session.submit({ kind: "run", text: msg.text }, emit);
} else if (parsed.kind === "interrupt_and_run") {
  await session.submit({ kind: "run", text: parsed.text }, emit);
} else {
  const outcome = await session.submit(parsed, emit);
  if (outcome.kind === "started" || outcome.kind === "queued") {
    await outcome.done;
  }
}

// After:
const parsed = parseInput(msg.text);
if (parsed.kind === "stop") {
  await session.stop(emit);
  return;
}
const outcome = await session.submit(parsed, emit);
if (outcome.kind === "started" || outcome.kind === "queued") {
  try {
    await outcome.done;
  } catch (err) {
    if (err instanceof InterruptedError) {
      // The session already emitted the appropriate "interrupted"
      // notice on the same emit channel. Nothing else to do here —
      // swallow so the outer catch doesn't send a generic error reply.
      logger.info(
        { chat_id: msg.chatId, reason: err.reason },
        "turn interrupted by user",
      );
      return;
    }
    throw err;
  }
}
// kind === "rejected" (stop synthesized via submit) → nothing to do.
```

Add the necessary imports:

```typescript
import { parseInput } from "./commands/router.js";
import { InterruptedError } from "./claude/session.js";
```

Remove the placeholder block from Task 6 Step 5 if it's still there.

- [ ] **Step 2: Update the banner log line**

Change the final `logger.info(..., "claude-feishu-channel Phase 3 ready")` to `"claude-feishu-channel Phase 4 ready"` and add `queue_depth_limit` once Phase 4 decides on a queue cap (for now, omit the field — no cap).

- [ ] **Step 3: Run tests + typecheck + build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(dispatcher): route /stop + ! prefix through ClaudeSession.submit"
```

---

## Task 12: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README**

Run: `cat README.md`. Note the Phase 3 status line and the `Next phases` list.

- [ ] **Step 2: Apply these edits**

**(a)** Change the status line from "Phase 3 of 8" to "Phase 4 of 8".

**(b)** Add a new "State machine + queue" section documenting:
- The three states: `idle` / `generating` / `awaiting_permission` (with note: awaiting_permission is a stub for Phase 5).
- FIFO queue: messages during a running turn are queued and replied "📥 已加入队列 #N".
- `/stop`: interrupts current turn, clears queue, acks with "🛑 已停止".
- `!` prefix: same as /stop but also enqueues the new message as the next turn (e.g. `! 忽略之前那条, 用 Go 重写`).
- Dropped messages receive the "⚠️ 你之前的消息在被 Claude 处理前已被后续指令打断丢弃" notice.

**(c)** Update the `src/` layout tree:

```
src/
  claude/
    cli-query.ts         ← QueryHandle with interrupt()
    permission-broker.ts ← new (Phase 5 interface + Null stub)
    preflight.ts
    query-handle.ts      ← new
    render-event.ts      ← + queued / interrupted variants
    session-manager.ts   ← clock + permissionBroker deps
    session.ts           ← state machine rewrite
  commands/
    router.ts            ← new (/stop + ! parser)
  feishu/...
  persistence/
    state-store.ts
  util/
    clock.ts
    dedup.ts
    deferred.ts
    logger.ts
    mutex.ts
  access.ts
  config.ts
  index.ts
  types.ts
```

**(d)** Remove Phase 4 from the "Next phases" list. Remaining: Phase 5, 6, 7, 8.

**(e)** Update the banner log line reference to "Phase 4 ready".

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for Phase 4 (state machine + queue + /stop + !)"
```

---

## Final Review

After Task 12 is committed:

- Run the full suite + typecheck + build once more: `pnpm test && pnpm typecheck && pnpm build`
- Dispatch a final phase-wide `superpowers:code-reviewer` subagent to review all Phase 4 commits against this plan and design spec §4–5 + §16.3.
- Apply any Critical / Important fixes as follow-up commits.
- Report E2E instructions to the user. Phase 4 E2E checklist (maps to design spec §16.5):
  1. Restart the gateway — banner should say "Phase 4 ready".
  2. **Queue test**: send "写一个冒泡排序的详细分析" (long turn), then immediately send "再顺便讲讲快排" before the first finishes. Expect: first turn streams normally, second gets "📥 已加入队列 #1", and when the first finishes the second runs automatically.
  3. **/stop in idle**: send `/stop` when nothing is running. Expect: "🛑 已停止" reply, no crash.
  4. **/stop during a long turn**: start a long turn, send `/stop`. Expect: turn terminates mid-stream, "🛑 已停止" reply, next message starts a fresh turn.
  5. **! prefix during a long turn**: start a long turn ("帮我写一个 Rust HTTP 服务器"), send `! 算了 改成 Python` before it finishes. Expect: first turn gets interrupted, the `!` reply runs next, original turn's dropped queue entry (if any) gets the "⚠️ 你之前的消息..." drop notice.
  6. **Bang with nothing running**: `!hello` while idle — should be equivalent to plain "hello".
  7. **Double-bang**: fire two `!` messages in quick succession. The second should replace the first; only the second's content ends up running.
  8. **awaiting_permission state — manual test deferred to Phase 5.** (No E2E for Phase 4; unit tests cover the transitions.)
- Do NOT tag/push yet. User confirms E2E, then use `superpowers:finishing-a-development-branch` to tag `v0.4.0-phase4`, push main, push tag.

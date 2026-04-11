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

/**
 * Structural subset of `node:child_process.spawn` — narrowed to the
 * overload we actually use so tests can inject a fake without pulling
 * in the full union of signatures.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CliQueryFnOptions {
  /** Path to the `claude` CLI binary. Usually `"claude"` (found on PATH). */
  cliPath: string;
  logger: Logger;
  /** Injected spawn. Defaults to `node:child_process.spawn`. */
  spawnFn?: SpawnFn;
}

/**
 * Build the CLI argv for a single non-interactive turn. The prompt is
 * passed as the final positional argument, after `--`, so prompts that
 * happen to start with `-` are never parsed as flags.
 */
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

/** Max raw stdout lines to retain for diagnostic error messages. */
const STDOUT_TAIL_MAX_LINES = 10;
/** Per-line truncation cap when keeping a stdout tail. */
const STDOUT_TAIL_LINE_CAP = 400;

/**
 * Adapter that implements the `QueryFn` interface by spawning the local
 * `claude` CLI in `--print --output-format stream-json` mode. Each line
 * of stdout is one `SDKMessage`-shaped JSON object, which we parse and
 * yield to the consumer.
 *
 * The returned `QueryHandle` exposes:
 * - `messages`: an AsyncIterable that yields one `SDKMessageLike` per
 *   parsed stdout line. The iterable terminates naturally when the
 *   child's stdout closes; post-iteration the generator validates the
 *   exit code and throws a diagnostic error if the child exited
 *   non-zero without having yielded a result message.
 * - `interrupt()`: sends `SIGTERM` to the child (idempotent — no-op if
 *   already dead) and resolves after the child's `close` event has
 *   fired. The state machine calls this from its `stop()` / `!` prefix
 *   handlers without breaking out of the iterator loop.
 *
 * Error semantics:
 * - Spawn failure (e.g. ENOENT) → iterator throws `"Failed to spawn..."`.
 * - Non-zero exit AND a `result` message was already yielded → swallowed
 *   here (logged at warn). The consumer (session.ts) owns the error path
 *   in that case and will surface a richer "Claude turn failed (subtype)"
 *   message. Throwing here would shadow that.
 * - Non-zero exit with NO result message → throws with the exit code and
 *   a tail of stderr; falls back to a tail of stdout when stderr is empty,
 *   so silent failures are still debuggable.
 * - Non-zero exit AFTER a successful `interrupt()` → swallowed (expected).
 * - Malformed JSON lines → logged at `warn` and skipped (the turn continues).
 */
export function createCliQueryFn(opts: CliQueryFnOptions): QueryFn {
  const spawn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  return (params) => {
    // Phase 5 transition: the CLI transport does not support the
    // permission callback. Ignore it — the session won't exercise
    // this path once index.ts switches to createSdkQueryFn.
    void params.canUseTool;

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
      if (interrupted) {
        await exitPromise;
        return;
      }
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
        // Rolling tail of non-empty raw stdout lines, used only when we
        // need to build an error message and stderr is empty (silent
        // failure case). Not used on the happy path.
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
          // Session.ts already saw the result message and will throw its
          // own richer error if subtype !== "success". Don't shadow it.
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
            // Silent exit: best-effort surface the last stdout lines so
            // at least we can see what the CLI was doing before it died.
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

    const handle: QueryHandle = {
      messages,
      interrupt,
      setPermissionMode: () => {
        // CLI transport cannot change mode mid-turn; no-op.
      },
    };
    return handle;
  };
}

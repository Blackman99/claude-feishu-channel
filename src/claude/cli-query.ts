import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "pino";
import type {
  ClaudeQueryOptions,
  QueryFn,
  SDKMessageLike,
} from "./session.js";

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
 * Error semantics:
 * - Spawn failure (e.g. ENOENT) → throws `"Failed to spawn claude CLI: ..."`
 * - Non-zero exit AND a `result` message was already yielded → swallowed
 *   here (logged at warn). The consumer (session.ts) owns the error path
 *   in that case and will surface a richer "Claude turn failed (subtype)"
 *   message. Throwing here would shadow that.
 * - Non-zero exit with NO result message → throws with the exit code and
 *   a tail of stderr; falls back to a tail of stdout when stderr is empty,
 *   so silent failures are still debuggable.
 * - Malformed JSON lines → logged at `warn` and skipped (the turn continues)
 */
export function createCliQueryFn(opts: CliQueryFnOptions): QueryFn {
  const spawn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  return (params) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessageLike, void, void> {
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

      // Rolling tail of non-empty raw stdout lines, used only when we
      // need to build an error message and stderr is empty (silent
      // failure case). Not used on the happy path.
      const stdoutTail: string[] = [];
      let sawResultMessage = false;

      const rl = createInterface({ input: child.stdout });
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
        rl.close();
        // If the consumer broke early (e.g. the session threw), kill the
        // subprocess so it doesn't linger. Safe to call when already dead.
        if (!child.killed && child.exitCode === null) {
          child.kill("SIGTERM");
        }
      }

      const exitCode = await exitPromise;
      if (spawnError) {
        throw new Error(
          `Failed to spawn claude CLI (${opts.cliPath}): ${spawnError.message}`,
        );
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
  });
}

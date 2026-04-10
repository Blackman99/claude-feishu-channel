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

/**
 * Adapter that implements the `QueryFn` interface by spawning the local
 * `claude` CLI in `--print --output-format stream-json` mode. Each line
 * of stdout is one `SDKMessage`-shaped JSON object, which we parse and
 * yield to the consumer.
 *
 * Error semantics:
 * - Spawn failure (e.g. ENOENT) → throws `"Failed to spawn claude CLI: ..."`
 * - Non-zero exit code → throws with the exit code and the tail of stderr
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

      const rl = createInterface({ input: child.stdout });
      try {
        for await (const rawLine of rl) {
          const line = rawLine.trim();
          if (line.length === 0) continue;
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
        const tail = stderrBuf.trim().split("\n").slice(-5).join("\n");
        const suffix = tail ? `:\n${tail}` : "";
        throw new Error(
          `claude CLI exited with code ${exitCode}${suffix}`,
        );
      }
    },
  });
}

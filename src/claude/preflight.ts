import { access, constants as fsConstants } from "node:fs/promises";
import { spawn } from "node:child_process";

export type PreflightResult =
  | { ok: true; version: string }
  | { ok: false; reason: string };

/**
 * Verify that the local `claude` CLI is installed, executable, and
 * responds to `--version`. We intentionally do NOT probe authentication
 * state here — the CLI handles OAuth / keychain / env-var credentials
 * itself, and will emit a clear error on the first turn if it cannot
 * authenticate. Phase 3's bridge only needs to know the binary is
 * reachable before binding the Feishu gateway.
 *
 * @param cliPath  Either an absolute path, or a bare name resolved via $PATH.
 */
export async function checkClaudeCli(
  cliPath: string,
): Promise<PreflightResult> {
  // If the caller passed an absolute path, verify it exists and is
  // executable up front — that gives a much clearer error than letting
  // `spawn` fall through to ENOENT.
  if (cliPath.startsWith("/")) {
    try {
      await access(cliPath, fsConstants.X_OK);
    } catch {
      return {
        ok: false,
        reason:
          `claude CLI not found or not executable at ${cliPath}. ` +
          `Install Claude Code (https://docs.claude.com/en/docs/claude-code) ` +
          `or fix [claude].cli_path in your config.toml.`,
      };
    }
  }

  // Probe with a short-timeout `--version` run. We don't require any
  // specific version string — just a clean exit 0 means the binary is
  // launchable on this system.
  return new Promise<PreflightResult>((resolve) => {
    const child = spawn(cliPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        ok: false,
        reason: `claude CLI (${cliPath}) did not respond to --version within 3s.`,
      });
    }, 3000);
    timer.unref();

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        resolve({
          ok: false,
          reason:
            `claude CLI not found on PATH (tried "${cliPath}"). ` +
            `Install Claude Code or set [claude].cli_path in config.toml.`,
        });
        return;
      }
      resolve({
        ok: false,
        reason: `Failed to spawn claude CLI (${cliPath}): ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, version: stdoutBuf.trim() || "unknown" });
        return;
      }
      const tail = stderrBuf.trim().split("\n").slice(-3).join("\n");
      resolve({
        ok: false,
        reason:
          `claude CLI (${cliPath}) exited with code ${code ?? "null"} ` +
          `on --version${tail ? `:\n${tail}` : ""}`,
      });
    });
  });
}

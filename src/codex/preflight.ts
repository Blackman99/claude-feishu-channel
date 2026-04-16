import { access, constants as fsConstants } from "node:fs/promises";
import { spawn } from "node:child_process";

export type PreflightResult =
  | { ok: true; version: string }
  | { ok: false; reason: string };

export async function checkCodexCli(
  cliPath: string,
): Promise<PreflightResult> {
  if (cliPath.startsWith("/")) {
    try {
      await access(cliPath, fsConstants.X_OK);
    } catch {
      return {
        ok: false,
        reason:
          `codex CLI not found or not executable at ${cliPath}. ` +
          `Install Codex or fix [codex].cli_path in your config.toml.`,
      };
    }
  }

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
        reason: `codex CLI (${cliPath}) did not respond to --version within 5s.`,
      });
    }, 5000);
    timer.unref();

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        resolve({
          ok: false,
          reason:
            `codex CLI not found on PATH (tried "${cliPath}"). ` +
            `Install Codex or set [codex].cli_path in config.toml.`,
        });
        return;
      }
      resolve({
        ok: false,
        reason: `Failed to spawn codex CLI (${cliPath}): ${err.message}`,
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
          `codex CLI (${cliPath}) exited with code ${code ?? "null"} ` +
          `on --version${tail ? `:\n${tail}` : ""}`,
      });
    });
  });
}

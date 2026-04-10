import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaudeCli } from "../../../src/claude/preflight.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfc-preflight-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create an executable shell script at `<tmpDir>/<name>` that prints
 * `stdout` to stdout, `stderr` to stderr, and exits with `exitCode`.
 * Returns the absolute path, suitable to pass to `checkClaudeCli`.
 */
function makeFakeCli(
  name: string,
  opts: { stdout?: string; stderr?: string; exitCode?: number; sleepMs?: number },
): string {
  const path = join(tmpDir, name);
  const exitCode = opts.exitCode ?? 0;
  const sleep = opts.sleepMs ? `sleep ${opts.sleepMs / 1000}` : "";
  const body = `#!/bin/sh
${sleep}
${opts.stdout ? `printf '%s' ${JSON.stringify(opts.stdout)}` : ""}
${opts.stderr ? `printf '%s' ${JSON.stringify(opts.stderr)} >&2` : ""}
exit ${exitCode}
`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

describe("checkClaudeCli", () => {
  it("returns ok + version when the CLI exits 0 and prints a version line", async () => {
    const cli = makeFakeCli("claude", { stdout: "2.1.100 (Claude Code)" });
    const result = await checkClaudeCli(cli);
    expect(result).toEqual({ ok: true, version: "2.1.100 (Claude Code)" });
  });

  it("fails when the binary does not exist at an absolute path", async () => {
    const result = await checkClaudeCli(join(tmpDir, "does-not-exist"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not found or not executable/);
    }
  });

  it("fails when the file exists but is not executable", async () => {
    const path = join(tmpDir, "claude");
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o644); // no +x
    const result = await checkClaudeCli(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not found or not executable/);
    }
  });

  it("fails with a clear reason when spawn hits ENOENT (bare name not on PATH)", async () => {
    // A bare name that is essentially guaranteed not to exist on PATH.
    const result = await checkClaudeCli("claude-feishu-channel-nonexistent-xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not found on PATH/);
    }
  });

  it("fails and includes stderr tail when the CLI exits non-zero", async () => {
    const cli = makeFakeCli("claude", {
      stderr: "login required",
      exitCode: 1,
    });
    const result = await checkClaudeCli(cli);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exited with code 1/);
      expect(result.reason).toMatch(/login required/);
    }
  });
});

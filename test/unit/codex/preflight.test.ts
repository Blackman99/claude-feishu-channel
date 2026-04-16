import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCodexCli } from "../../../src/codex/preflight.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfc-codex-preflight-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFakeCli(
  name: string,
  opts: { stdout?: string; stderr?: string; exitCode?: number; sleepMs?: number },
): string {
  const path = join(tmpDir, name);
  const exitCode = opts.exitCode ?? 0;
  const body = `#!/usr/bin/env node
const wait = ${opts.sleepMs ?? 0};
const stdout = ${JSON.stringify(opts.stdout ?? "")};
const stderr = ${JSON.stringify(opts.stderr ?? "")};
const exitCode = ${exitCode};
const start = Date.now();
while (Date.now() - start < wait) {}
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);
`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

describe("checkCodexCli", () => {
  it("returns ok + version when the CLI exits 0 and prints a version line", async () => {
    const cli = makeFakeCli("codex", { stdout: "0.1.0 (Codex)" });
    const result = await checkCodexCli(cli);
    expect(result).toEqual({ ok: true, version: "0.1.0 (Codex)" });
  });

  it("fails when the binary does not exist at an absolute path", async () => {
    const result = await checkCodexCli(join(tmpDir, "does-not-exist"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not found or not executable/);
    }
  });

  it("fails with a clear reason when spawn hits ENOENT", async () => {
    const result = await checkCodexCli("codex-feishu-channel-nonexistent-xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not found on PATH/);
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliSource = join(repoRoot, "src", "cli.ts");

interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function spawnCli(
  args: string[],
  opts: { env?: Record<string, string>; entry?: string } = {},
): SpawnResult {
  const entry = opts.entry ?? cliSource;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", entry, ...args],
    {
      env: { ...process.env, ...opts.env },
      encoding: "utf-8",
      timeout: 15_000,
    },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

describe("afc CLI (E2E)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "afc-e2e-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("--version prints the package version", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf-8"),
    ) as { version: string };
    const r = spawnCli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("-v prints the package version", () => {
    const r = spawnCli(["-v"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help prints usage", () => {
    const r = spawnCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("--config");
    expect(r.stdout).toContain("--version");
  });

  it("-h prints usage", () => {
    const r = spawnCli(["-h"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  it("init creates config at $HOME/.agent-feishu-channel/config.toml", () => {
    const home = join(workDir, "home");
    mkdirSync(home, { recursive: true });
    const r = spawnCli(["init"], { env: { HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Config template created");
    const target = join(home, ".agent-feishu-channel", "config.toml");
    const template = readFileSync(
      join(repoRoot, "config.example.toml"),
      "utf-8",
    );
    expect(readFileSync(target, "utf-8")).toBe(template);
  });

  it("init skips when config already exists", () => {
    const home = join(workDir, "home");
    const dir = join(home, ".agent-feishu-channel");
    mkdirSync(dir, { recursive: true });
    const existing = "# my edits\n";
    writeFileSync(join(dir, "config.toml"), existing);

    const r = spawnCli(["init"], { env: { HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skipping");
    expect(readFileSync(join(dir, "config.toml"), "utf-8")).toBe(existing);
  });

  it("unknown subcommand exits 1 and prints Unknown command", () => {
    const r = spawnCli(["bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown command: bogus");
  });

  it("init works when invoked via a symlink (regression: #global-install)", () => {
    // Simulates `npm install -g` creating a bin symlink to dist/cli.js.
    const linkPath = join(workDir, "afc-link.ts");
    symlinkSync(cliSource, linkPath);

    const home = join(workDir, "home");
    mkdirSync(home, { recursive: true });
    const r = spawnCli(["init"], {
      env: { HOME: home },
      entry: linkPath,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Config template created");
    const target = join(home, ".agent-feishu-channel", "config.toml");
    expect(readFileSync(target, "utf-8")).toContain("[feishu]");
  });

  it("default start attempts to load config and fails loudly when missing", () => {
    // Proves the entry point actually runs main() — the pre-fix bug was a
    // silent exit 0 with no attempt to load config.
    const missingPath = join(workDir, "does-not-exist.toml");
    const r = spawnCli([], {
      env: {
        AGENT_FEISHU_CONFIG: missingPath,
        // Strip any inherited overrides.
        CLAUDE_FEISHU_CONFIG: "",
      },
    });
    expect(r.status).not.toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined.length).toBeGreaterThan(0);
    expect(combined.toLowerCase()).toMatch(/config|not found|enoent/);
  });
});

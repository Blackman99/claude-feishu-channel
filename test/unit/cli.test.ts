import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * We test the two pure-ish helper functions extracted from cli.ts:
 *   - printHelp() → returns a help string
 *   - runInit(targetDir, templatePath) → copies template to targetDir/config.toml
 *
 * The actual CLI arg parsing is thin glue over node:util parseArgs
 * and not worth unit testing separately.
 */

describe("printHelp", () => {
  it("returns a string containing usage, commands, and options", async () => {
    const { printHelp } = await import("../../src/cli.js");
    const help = printHelp();
    expect(help).toContain("Usage:");
    expect(help).toContain("cfc");
    expect(help).toContain("--config");
    expect(help).toContain("--version");
    expect(help).toContain("--help");
    expect(help).toContain("init");
  });
});

describe("runInit", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `cfc-test-${Date.now()}`);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates config dir and copies template when target does not exist", async () => {
    const { runInit } = await import("../../src/cli.js");
    const targetDir = join(tempDir, "sub", "dir");
    const templatePath = join(
      import.meta.dirname,
      "..",
      "..",
      "config.example.toml",
    );

    const result = runInit(targetDir, templatePath);

    expect(result.created).toBe(true);
    expect(existsSync(join(targetDir, "config.toml"))).toBe(true);

    const copied = readFileSync(join(targetDir, "config.toml"), "utf-8");
    const original = readFileSync(templatePath, "utf-8");
    expect(copied).toBe(original);
  });

  it("skips when config.toml already exists", async () => {
    const { runInit } = await import("../../src/cli.js");
    const templatePath = join(
      import.meta.dirname,
      "..",
      "..",
      "config.example.toml",
    );

    // Pre-create the file
    mkdirSync(tempDir, { recursive: true });
    const existing = "# existing config\n";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tempDir, "config.toml"), existing);

    const result = runInit(tempDir, templatePath);

    expect(result.created).toBe(false);
    // Verify the file was NOT overwritten
    const content = readFileSync(join(tempDir, "config.toml"), "utf-8");
    expect(content).toBe(existing);
  });
});

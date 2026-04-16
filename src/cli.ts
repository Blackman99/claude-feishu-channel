#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  readFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

export function printHelp(): string {
  return `agent-feishu-channel — Bridge Claude Code or Codex to a Feishu group chat

Usage:
  afc [options]            Start the service
  afc init                 Create a config template at ~/.agent-feishu-channel/config.toml

Options:
  -c, --config <path>      Path to config.toml (default: ~/.agent-feishu-channel/config.toml)
  -v, --version            Show version number
  -h, --help               Show this help message

Environment variables:
  AGENT_FEISHU_CONFIG      Override the default config file path
  CLAUDE_FEISHU_CONFIG     Legacy alias for AGENT_FEISHU_CONFIG (still honored)

Documentation: https://github.com/Blackman99/agent-feishu-channel`;
}

/**
 * One-time migration for users upgrading from the old `claude-feishu-channel`
 * package: if the legacy state directory exists and the new one does not,
 * rename it in place. Idempotent — no-op once migrated.
 */
export function migrateLegacyStateDir(
  legacyDir: string,
  newDir: string,
  log: (msg: string) => void = (msg: string) => console.error(msg),
): void {
  if (existsSync(newDir)) return;
  if (!existsSync(legacyDir)) return;
  try {
    renameSync(legacyDir, newDir);
    log(`[migrate] Renamed state directory: ${legacyDir} -> ${newDir}`);
  } catch (err) {
    log(
      `[migrate] Could not auto-rename ${legacyDir} -> ${newDir}: ${String(err)}\n` +
        `[migrate] Run manually: mv ${legacyDir} ${newDir}`,
    );
  }
}

export function runInit(
  targetDir: string,
  templatePath: string,
): { created: boolean; targetFile: string } {
  const targetFile = join(targetDir, "config.toml");

  if (existsSync(targetFile)) {
    return { created: false, targetFile };
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(templatePath, targetFile);
  return { created: true, targetFile };
}

// ---------------------------------------------------------------------------
// CLI entry point (only runs when executed directly, not when imported)
// ---------------------------------------------------------------------------

function resolveTemplatePath(): string {
  return new URL("../config.example.toml", import.meta.url).pathname;
}

function readVersion(): string {
  const raw = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf-8",
  );
  const pkg = JSON.parse(raw) as { version: string };
  return pkg.version;
}

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.version) {
    console.log(readVersion());
    process.exit(0);
  }

  if (values.help) {
    console.log(printHelp());
    process.exit(0);
  }

  // Auto-migrate legacy state dir once, before any subcommand that touches it.
  migrateLegacyStateDir(
    join(homedir(), ".claude-feishu-channel"),
    join(homedir(), ".agent-feishu-channel"),
  );

  const subcommand = positionals[0];

  if (subcommand === "init") {
    const targetDir = join(homedir(), ".agent-feishu-channel");
    const templatePath = resolveTemplatePath();
    const { created, targetFile } = runInit(targetDir, templatePath);

    if (created) {
      console.log(
        `Config template created at ${targetFile}\nEdit it with your Feishu credentials, then run: afc`,
      );
    } else {
      console.log(`Config already exists at ${targetFile}, skipping.`);
    }
    process.exit(0);
  }

  if (subcommand) {
    console.error(`Unknown command: ${subcommand}\n`);
    console.error(printHelp());
    process.exit(1);
  }

  // Default: start the service
  const configPath = values.config ?? undefined;
  const { main } = await import("./index.js");
  main(configPath).catch((err: unknown) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}

// Only run CLI when executed directly (not imported)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err: unknown) => {
    console.error("Unexpected CLI error:", err);
    process.exit(1);
  });
}

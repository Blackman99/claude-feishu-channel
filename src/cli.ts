#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  readFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

export function printHelp(): string {
  return `claude-feishu-channel — Bridge Claude Code to a Feishu group chat

Usage:
  cfc [options]            Start the service
  cfc init                 Create a config template at ~/.claude-feishu-channel/config.toml

Options:
  -c, --config <path>      Path to config.toml (default: ~/.claude-feishu-channel/config.toml)
  -v, --version            Show version number
  -h, --help               Show this help message

Environment variables:
  CLAUDE_FEISHU_CONFIG     Override the default config file path

Documentation: https://github.com/anthropics/claude-feishu-channel`;
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

  const subcommand = positionals[0];

  if (subcommand === "init") {
    const targetDir = join(homedir(), ".claude-feishu-channel");
    const templatePath = resolveTemplatePath();
    const { created, targetFile } = runInit(targetDir, templatePath);

    if (created) {
      console.log(
        `Config template created at ${targetFile}\nEdit it with your Feishu credentials, then run: cfc`,
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

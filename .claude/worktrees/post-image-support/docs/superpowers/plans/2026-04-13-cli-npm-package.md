# CLI + npm Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `claude-feishu-channel` installable as a global npm package with CLI command `cfc`.

**Architecture:** Add a `src/cli.ts` entry point with shebang and `util.parseArgs`, refactor `src/index.ts` to export `main()` instead of self-invoking, create a `tsconfig.build.json` for emit, and update `package.json` for npm distribution.

**Tech Stack:** TypeScript, Node.js built-in `util.parseArgs`, tsc for compilation

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `tsconfig.build.json` | **Create** | Build-specific tsconfig: emit JS to `dist/`, NodeNext module, declarations |
| `src/index.ts` | **Modify** | Export `main(configPathOverride?)` instead of self-invoking at module level |
| `src/cli.ts` | **Create** | CLI entry point: shebang, parseArgs, --version/--help/--config, `init` subcommand |
| `package.json` | **Modify** | Remove `private`, add `bin`/`files`/`main`/`types`, update scripts |
| `test/unit/cli.test.ts` | **Create** | Unit tests for CLI arg parsing and init logic |

---

### Task 1: Create `tsconfig.build.json`

**Files:**
- Create: `tsconfig.build.json`

- [ ] **Step 1: Create `tsconfig.build.json`**

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": false,
    "outDir": "dist",
    "declaration": true,
    "sourceMap": false,
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test/**/*"]
}
```

- [ ] **Step 2: Verify typecheck still passes with base tsconfig**

Run: `pnpm typecheck`
Expected: exits 0 with no errors (base tsconfig unchanged)

- [ ] **Step 3: Commit**

```bash
git add tsconfig.build.json
git commit -m "build: add tsconfig.build.json for dist/ output"
```

---

### Task 2: Refactor `src/index.ts` to export `main()`

**Files:**
- Modify: `src/index.ts:42-46` (resolveConfigPath)
- Modify: `src/index.ts:48` (main function signature)
- Modify: `src/index.ts:889-892` (remove self-invoking call)

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 2: Modify `resolveConfigPath` to accept an override**

In `src/index.ts`, change lines 42-46 from:

```typescript
function resolveConfigPath(): string {
  const envOverride = process.env["CLAUDE_FEISHU_CONFIG"];
  if (envOverride) return envOverride;
  return join(homedir(), ".claude-feishu-channel", "config.toml");
}
```

To:

```typescript
function resolveConfigPath(override?: string): string {
  if (override) return override;
  const envOverride = process.env["CLAUDE_FEISHU_CONFIG"];
  if (envOverride) return envOverride;
  return join(homedir(), ".claude-feishu-channel", "config.toml");
}
```

- [ ] **Step 3: Export `main()` and accept configPathOverride**

Change line 48 from:

```typescript
async function main(): Promise<void> {
  const configPath = resolveConfigPath();
```

To:

```typescript
export async function main(configPathOverride?: string): Promise<void> {
  const configPath = resolveConfigPath(configPathOverride);
```

- [ ] **Step 4: Remove the self-invoking call at the bottom**

Delete lines 889-892:

```typescript
main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
```

- [ ] **Step 5: Run existing tests to confirm nothing broke**

Run: `pnpm test`
Expected: all tests pass (none import `main()` directly or depend on the self-invoking call)

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: exits 0, no errors

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "refactor: export main() from index.ts, remove self-invocation"
```

---

### Task 3: Create `src/cli.ts`

**Files:**
- Create: `src/cli.ts`
- Create: `test/unit/cli.test.ts`

- [ ] **Step 1: Write tests for CLI helpers**

Create `test/unit/cli.test.ts`:

```typescript
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

// We'll import these after cli.ts is created.
// For now, define the expected behavior.

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
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm test test/unit/cli.test.ts`
Expected: FAIL — `src/cli.js` does not exist yet

- [ ] **Step 3: Create `src/cli.ts`**

```typescript
#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  readFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

run().catch((err: unknown) => {
  console.error("Unexpected CLI error:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/unit/cli.test.ts`
Expected: all 3 tests pass

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: all tests pass (old + new)

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/unit/cli.test.ts
git commit -m "feat: add CLI entry point with --version, --help, --config, and init"
```

---

### Task 4: Update `package.json` and scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove `"private": true`**

Delete the line:
```json
"private": true,
```

- [ ] **Step 2: Add `bin`, `main`, `types`, `files` fields**

After the `"description"` line, add:

```json
"main": "dist/index.js",
"types": "dist/index.d.ts",
"bin": {
  "cfc": "dist/cli.js"
},
"files": [
  "dist",
  "config.example.toml"
],
```

- [ ] **Step 3: Update scripts**

Change:
```json
"build": "tsc --noEmit",
"dev": "tsx src/index.ts",
"start": "node --import tsx src/index.ts",
```

To:
```json
"build": "tsc -p tsconfig.build.json",
"dev": "tsx src/cli.ts",
"start": "node --import tsx src/cli.ts",
"prepublishOnly": "npm run build && npm run test",
```

- [ ] **Step 4: Run typecheck to verify**

Run: `pnpm typecheck`
Expected: exits 0, no errors

- [ ] **Step 5: Run all tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "feat: configure package.json for npm publishing with cfc bin"
```

---

### Task 5: Build, verify, and E2E smoke test

**Files:** None (verification only)

- [ ] **Step 1: Clean any prior dist/ and build**

Run: `rm -rf dist && pnpm build`
Expected: exits 0, `dist/` directory created with JS files

- [ ] **Step 2: Verify dist/ contents**

Run: `ls dist/cli.js dist/index.js dist/index.d.ts dist/cli.d.ts`
Expected: all 4 files exist

- [ ] **Step 3: Verify shebang is present in dist/cli.js**

Run: `head -1 dist/cli.js`
Expected: `#!/usr/bin/env node`

- [ ] **Step 4: Test `--version`**

Run: `node dist/cli.js --version`
Expected: `0.1.0`

- [ ] **Step 5: Test `--help`**

Run: `node dist/cli.js --help`
Expected: prints help text containing "Usage:", "cfc", "--config", "init"

- [ ] **Step 6: Test unknown command**

Run: `node dist/cli.js unknown 2>&1; echo "exit: $?"`
Expected: prints "Unknown command: unknown" + help text, exit code 1

- [ ] **Step 7: Test `npm pack` contents**

Run: `npm pack --dry-run 2>&1`
Expected: lists only `dist/`, `config.example.toml`, `package.json`, `README.md` — no `src/`, `test/`, `site/`, `node_modules/`

- [ ] **Step 8: Commit (if any fixups were needed)**

```bash
git add -A
git commit -m "fix: address build verification issues"
```

(Skip this step if no changes were needed.)

---

### Task 6: Add `dist/` cleanup to build script and finalize

**Files:**
- Modify: `package.json` (scripts.build)

- [ ] **Step 1: Add `clean` script and update `build` to clean first**

In `package.json` scripts, add:
```json
"clean": "rm -rf dist",
"build": "rm -rf dist && tsc -p tsconfig.build.json",
```

- [ ] **Step 2: Verify clean build**

Run: `pnpm build`
Expected: exits 0, fresh `dist/` directory

- [ ] **Step 3: Run full test suite one final time**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: add clean step to build script"
```

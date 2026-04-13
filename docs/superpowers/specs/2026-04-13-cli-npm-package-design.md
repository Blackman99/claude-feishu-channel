# CLI + npm Package Design

**Date:** 2026-04-13
**Status:** Draft

## Goal

Make `claude-feishu-channel` installable as a global npm package with CLI command `cfc`.

```bash
npm install -g claude-feishu-channel
cfc                       # start the service
cfc --config ./my.toml    # custom config path
cfc --version             # print version
cfc --help                # show usage
cfc init                  # scaffold config template
```

## Constraints

- Zero new runtime dependencies (use Node.js built-in `util.parseArgs`)
- Zero behavioral changes to existing functionality
- Keep dev workflow (`pnpm dev`, `pnpm test`) working as before
- Publish to npm public registry
- Node.js >= 20 (already required)

## Architecture

### File Changes

| File | Action | Purpose |
|------|--------|---------|
| `src/cli.ts` | **New** | CLI entry point: shebang, arg parsing, dispatch |
| `src/index.ts` | **Modify** | Export `main(configPath?)` instead of self-invoking |
| `tsconfig.build.json` | **New** | Emit-enabled tsconfig for `dist/` output |
| `package.json` | **Modify** | Add `bin`, `files`, `main`, update scripts |

### 1. `src/cli.ts` — CLI Entry Point

```typescript
#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  );
  console.log(pkg.version);
  process.exit(0);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

const subcommand = positionals[0];

if (subcommand === "init") {
  runInit();
  process.exit(0);
}

if (subcommand) {
  console.error(`Unknown command: ${subcommand}`);
  printHelp();
  process.exit(1);
}

// Default: start the service
const configPath = values.config ?? undefined;
const { main } = await import("./index.js");
main(configPath).catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
```

**`printHelp()`** prints a concise usage block with available commands and flags.

**`runInit()`** copies `config.example.toml` to `~/.claude-feishu-channel/config.toml`, creating the directory if needed. Refuses to overwrite an existing file (prints a message instead).

### 2. `src/index.ts` — Minimal Refactor

Current (lines 42–49, 889–892):
```typescript
function resolveConfigPath(): string {
  const envOverride = process.env["CLAUDE_FEISHU_CONFIG"];
  if (envOverride) return envOverride;
  return join(homedir(), ".claude-feishu-channel", "config.toml");
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath();
  // ...
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
```

After:
```typescript
function resolveConfigPath(override?: string): string {
  if (override) return override;
  const envOverride = process.env["CLAUDE_FEISHU_CONFIG"];
  if (envOverride) return envOverride;
  return join(homedir(), ".claude-feishu-channel", "config.toml");
}

export async function main(configPathOverride?: string): Promise<void> {
  const configPath = resolveConfigPath(configPathOverride);
  // ... rest unchanged
}
// Remove the main().catch(...) call at the bottom
```

Changes:
1. `main()` becomes `export async function main(configPathOverride?)`.
2. `resolveConfigPath()` accepts an optional override (CLI `--config` value).
3. Remove the self-invoking `main().catch(...)` at the bottom.

### 3. `tsconfig.build.json` — Build Config

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

Key choices:
- **`module: "NodeNext"`** — correct ESM output for Node.js; existing `.js` import extensions are already compatible.
- **`declaration: true`** — enables programmatic import of the package.
- **`sourceMap: false`** — not needed in published package.
- **`rootDir: "src"`** — output mirrors `src/` structure inside `dist/`.

### 4. `package.json` — Changes

```diff
- "private": true,
+ "bin": {
+   "cfc": "dist/cli.js"
+ },
+ "main": "dist/index.js",
+ "types": "dist/index.d.ts",
+ "files": [
+   "dist",
+   "config.example.toml"
+ ],
  "scripts": {
-   "build": "tsc --noEmit",
-   "dev": "tsx src/index.ts",
-   "start": "node --import tsx src/index.ts",
+   "build": "tsc -p tsconfig.build.json",
+   "dev": "tsx src/cli.ts",
+   "start": "node --import tsx src/cli.ts",
+   "prepublishOnly": "npm run build && npm run test",
    // ...rest unchanged
  },
```

- **`"private": true` removed** — required for npm publish.
- **`bin.cfc`** — registers the `cfc` global command.
- **`files`** — whitelist for the published tarball: only `dist/` and the config template.
- **`main` + `types`** — enables `import { main } from "claude-feishu-channel"` for programmatic use.
- **`prepublishOnly`** — safety gate: build + test must pass before publish.

### 5. `cfc init` Subcommand

Behavior:
1. Target: `~/.claude-feishu-channel/config.toml`
2. If target exists → print "Config already exists at <path>, skipping." and exit 0.
3. If target dir doesn't exist → `mkdirSync(dir, { recursive: true })`.
4. Copy `config.example.toml` from the package (resolved via `import.meta.url`) to target.
5. Print "Config template created at <path>. Edit it with your Feishu credentials."

### 6. Published Package Contents

```
dist/
  cli.js              ← bin entry
  cli.d.ts
  index.js            ← main export
  index.d.ts
  config.js / types.js / access.js / ...
  claude/
  feishu/
  commands/
  persistence/
  util/
config.example.toml   ← template for cfc init
package.json          ← always included by npm
README.md             ← always included by npm
```

Total published size estimate: ~200 KB (JS + declarations + config template).

### 7. User Workflow After Publishing

```bash
# Install
npm install -g claude-feishu-channel

# Initialize config
cfc init
# → Config template created at ~/.claude-feishu-channel/config.toml

# Edit config with Feishu credentials
vim ~/.claude-feishu-channel/config.toml

# Start the service
cfc

# Or with a custom config
cfc --config /path/to/config.toml
```

## Testing

- Existing unit tests remain unchanged (they don't import from `cli.ts`).
- Manual verification: `pnpm build` succeeds, `node dist/cli.js --version` prints version, `node dist/cli.js --help` prints usage.
- `pnpm dev` continues to work as before.
- `npm pack` produces a tarball with only the expected files.

## Out of Scope

- `npx` support (user chose global install only)
- Daemon/background mode (keep current foreground process)
- Auto-update mechanism
- Config migration tooling

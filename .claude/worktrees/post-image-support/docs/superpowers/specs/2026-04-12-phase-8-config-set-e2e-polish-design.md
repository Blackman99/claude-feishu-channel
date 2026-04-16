# Phase 8: `/config set` + E2E Checklist + Polish

## Goal

Complete the command set with runtime configuration mutation (`/config set`),
create the E2E hand-testing checklist document, and polish
`config.example.toml` and `README.md` for release readiness.

## Scope

1. **`/config set <key> <value>`** — mutate runtime config, current process only
2. **`/config set <key> <value> --persist`** — same + write back to `config.toml`
3. **`docs/e2e-checklist.md`** — the §16.5 checklist as a standalone doc
4. **`config.example.toml`** polish — ensure all keys documented
5. **`README.md`** — complete command reference, setup guide

## 1. `/config set` — Design

### 1.1 Settable keys (whitelist)

Only these TOML keys are accepted. Everything else returns an error
listing the allowed keys.

| TOML key | AppConfig path | Type | Validation |
|---|---|---|---|
| `render.hide_thinking` | `render.hideThinking` | boolean | `true` / `false` |
| `render.show_turn_stats` | `render.showTurnStats` | boolean | `true` / `false` |
| `render.inline_max_bytes` | `render.inlineMaxBytes` | number | positive integer |
| `logging.level` | `logging.level` | enum | `trace\|debug\|info\|warn\|error` |
| `claude.default_model` | `claude.defaultModel` | string | non-empty |
| `claude.default_cwd` | `claude.defaultCwd` | string | non-empty, `~` expanded |
| `claude.default_permission_mode` | `claude.defaultPermissionMode` | enum | `default\|acceptEdits\|plan\|bypassPermissions` |
| `claude.permission_timeout_seconds` | `claude.permissionTimeoutMs` | number | positive integer, stored as `value * 1000` |
| `claude.permission_warn_before_seconds` | `claude.permissionWarnBeforeMs` | number | positive integer, stored as `value * 1000` |

Not settable (require restart): `feishu.*`, `access.*`, `persistence.*`,
`projects.*`, `claude.cli_path`.

### 1.2 Command parsing

Router recognizes `/config set <key> <value>` and
`/config set <key> <value> --persist`.

```
ParsedCommand:
  | { name: "config_set"; key: string; value: string; persist: boolean }
```

The `--persist` flag is detected at the end of the rest string and
stripped before passing `value` to the handler. Value parsing:
- `true` / `false` → boolean
- strings that parse as integers → number
- everything else → string

### 1.3 Runtime mutation

The dispatcher's `handleConfigSet` method:
1. Looks up `key` in the whitelist map
2. Parses `value` to the correct type
3. Validates (enum membership, positivity, etc.)
4. Mutates the shared `AppConfig` object via the mapped path
5. If `persist`: calls `writeConfigKey(configPath, tomlKey, rawValue)`
6. Replies: `配置已更新: ${key} = ${displayValue}` (+ ` (已持久化)` if persist)

Error cases:
- Unknown key → `不支持的配置项: ${key}，可设置的配置项: ...`
- Invalid value → `无效的值: ${value}，${key} 需要 ${expectedType}`
- Persist write failure → `运行时配置已更新，但写入 config.toml 失败: ${err.message}`

### 1.4 TOML writeback (`--persist`)

New function in `config.ts`:

```ts
export async function writeConfigKey(
  configPath: string,
  key: string,          // e.g. "render.hide_thinking"
  value: string | number | boolean,
): Promise<void>
```

Implementation:
1. Read `configPath` as UTF-8
2. `smol-toml.parse()` → mutable object
3. Split `key` by `.` → `[section, field]`
4. Set `parsed[section][field] = value`
5. `smol-toml.stringify(parsed)` → new TOML string
6. Write to `configPath + ".tmp"`, then `rename()` for atomic swap

The function needs the config file path. The dispatcher already has
`this.config` but not the file path. Add `configPath: string` to
`CommandDispatcherOptions` (set from `index.ts` where the path is known).

### 1.5 Help text update

Add `/config set` to the help output:
```
  /config show    — 显示当前配置
  /config set <key> <value> — 运行时修改配置
  /config set <key> <value> --persist — 修改配置并写入文件
```

## 2. E2E checklist doc

Create `docs/e2e-checklist.md` from §16.5 with 24 items as markdown
checkboxes. Each item gets a one-line instruction on how to verify.

## 3. Polish

### 3.1 `config.example.toml`

Already comprehensive. Only change: update comments referencing
Phase 1/Phase 6 to be phase-neutral (the bot is now feature-complete).

### 3.2 `README.md`

Currently does not exist in the project root. Create with:
- Project description (Claude Code ↔ Feishu bridge)
- Prerequisites (Node.js, pnpm, Claude CLI, Feishu bot)
- Quick start (copy config, fill credentials, `pnpm dev`)
- Full command reference table
- Configuration reference (all TOML sections)
- Architecture overview (gateway → router → dispatcher → session → SDK)
- Development (test, typecheck, lint)

## 4. Files

| Action | File |
|---|---|
| Modify | `src/commands/router.ts` — add `config_set` to `ParsedCommand` + parser |
| Modify | `src/commands/dispatcher.ts` — add `handleConfigSet`, key whitelist map, help text |
| Modify | `src/config.ts` — add `writeConfigKey()` |
| Modify | `src/index.ts` — pass `configPath` to dispatcher |
| Create | `docs/e2e-checklist.md` |
| Modify | `config.example.toml` — minor comment updates |
| Create | `README.md` |
| New test | `test/unit/commands/router.test.ts` — `/config set` parsing cases |
| New test | `test/unit/commands/dispatcher.test.ts` — `handleConfigSet` cases |
| New test | `test/unit/config.test.ts` — `writeConfigKey` cases |

## 5. Out of scope

- Hot-reload config file on change (YAGNI per §17)
- `/config set` for `projects.*` (complex nested, use TOML editor)
- `/config set` for security-sensitive keys (feishu/access)
- `/config reset` (revert to default)

<p align="center">
  <img src="assets/logo.svg" width="180" alt="AFC Logo" />
</p>

<h1 align="center">agent-feishu-channel</h1>

<p align="center">
  Claude and Codex, natively in Feishu / Lark.
  <br />
  A full coding-agent workflow — right inside your Feishu group chat.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-feishu-channel"><img src="https://img.shields.io/npm/v/agent-feishu-channel.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/agent-feishu-channel"><img src="https://img.shields.io/npm/dm/agent-feishu-channel.svg" alt="npm downloads" /></a>
  <a href="https://github.com/Blackman99/agent-feishu-channel/actions/workflows/ci.yml"><img src="https://github.com/Blackman99/agent-feishu-channel/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/node/v/agent-feishu-channel" alt="node version" />
</p>

> **Migrating from `claude-feishu-channel`?** The project was renamed to reflect multi-provider support (Claude + Codex). Run `pnpm remove claude-feishu-channel && pnpm add agent-feishu-channel` (or the npm equivalent). Command is now `afc` instead of `cfc`. On first run, the state directory at `~/.claude-feishu-channel/` will be auto-renamed to `~/.agent-feishu-channel/` — session history is preserved. Config keys are unchanged.

## Features

- **Dual providers** — switch between Claude and Codex per config or per session
- **Full coding agent** — file editing, shell commands, search, planning
- **Permission brokering** — tool calls post interactive approval cards in Feishu
- **Session persistence** — survives process restarts, auto-resumes conversations
- **Queue & interrupt** — messages queue during generation; `!` prefix interrupts
- **Interactive cards** — streaming status, tool activity, thinking blocks, permissions
- **Staged context mitigation** — warn, then hard 50MB fallback
- **Runtime config** — `/config set` to tune behavior without restart

## Quick Start

### Install

```bash
npm install -g agent-feishu-channel
```

### Initialize config

```bash
afc init
# Creates ~/.agent-feishu-channel/config.toml from template
```

Edit the config with your Feishu credentials:

```bash
vim ~/.agent-feishu-channel/config.toml
```

To discover your Feishu `open_id` on first run, temporarily set
`allowed_open_ids = []` and `unauthorized_behavior = "reject"`, then send the
bot a message. It will reply with your `open_id`; add that value to
`allowed_open_ids` and switch back to `"ignore"` for normal use.

### Run

```bash
afc
```

The bot connects to Feishu via WebSocket and starts listening for messages.

### CLI Options

```
afc [options]            Start the service
afc init                 Create config template at ~/.agent-feishu-channel/config.toml

Options:
  -c, --config <path>    Path to config.toml (overrides default location)
  -v, --version          Show version number
  -h, --help             Show help
```

## Prerequisites

- **Node.js** >= 20
- **Claude CLI** — `claude` binary in `$PATH` when using the Claude provider
- **Codex CLI + SDK** — `codex` binary in `$PATH` plus `@openai/codex-sdk` when using the Codex provider
- **Feishu bot app** — created at [open.feishu.cn](https://open.feishu.cn/app)

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (clear context) |
| `/stop` | Interrupt current generation |
| `/status` | Show session state, model, token usage |
| `/cost` | Show token usage totals (input / output / total) for this session |
| `/context` | Show context window usage and mitigation status |
| `/compact` | Reset the current session to free context (idle-only) |
| `/sessions` | List all known sessions |
| `/projects` | List all configured project aliases |
| `/resume <id>` | Resume a previous session |
| `/cd <path>` | Change working directory (with confirm card) |
| `/project <alias>` | Switch to a configured project alias |
| `/provider <claude\|codex>` | Switch the current session provider |
| `/mode <mode>` | Set permission mode: `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| `/model <name>` | Switch the current provider model |
| `/config show` | Display current configuration |
| `/config set <key> <value>` | Change a config value at runtime |
| `/config set <key> <value> --persist` | Change and write back to config.toml |
| `/memory` | Show current provider memory files (`CLAUDE.md` for Claude, `AGENTS.md` for Codex) |
| `/memory add <text>` | Append `<text>` as a bullet to the current provider's project memory file |
| `/help` | Show available commands |

**Special inputs:**

| Input | Effect |
|-------|--------|
| `!<text>` | Interrupt current turn + run `<text>` as new turn |
| Plain text | Queue as next turn (or start immediately if idle) |

## Configuration

See [`config.example.toml`](config.example.toml) for all options with comments.

### Sections

| Section | Keys | Description |
|---------|------|-------------|
| `[feishu]` | `app_id`, `app_secret`, `encrypt_key`, `verification_token` | Feishu bot credentials |
| `[access]` | `allowed_open_ids`, `unauthorized_behavior` | Who can talk to the bot |
| `[agent]` | `default_provider`, `default_cwd`, `default_permission_mode`, `permission_timeout_seconds`, `permission_warn_before_seconds` | Shared agent defaults |
| `[claude]` | `default_model`, `cli_path` | Claude provider defaults |
| `[codex]` | `default_model`, `cli_path` | Codex provider defaults |
| `[render]` | `inline_max_bytes`, `hide_thinking`, `show_turn_stats` | Card rendering options |
| `[persistence]` | `state_file`, `log_dir`, `session_ttl_days` | State and log paths |
| `[logging]` | `level` | Log level: `trace`, `debug`, `info`, `warn`, `error` |
| `[projects]` | `<alias> = "<path>"` | Project aliases for `/project` command |
| `[[mcp]]` (array) | `name`, `type` (`stdio`/`sse`), `command`/`args`/`env` or `url` | Custom MCP servers exposed to the active provider |

### Runtime-settable keys

These keys can be changed via `/config set` without restart:

`render.hide_thinking`, `render.show_turn_stats`, `render.inline_max_bytes`,
`logging.level`, `agent.default_provider`, `agent.default_cwd`,
`agent.default_permission_mode`, `agent.permission_timeout_seconds`,
`agent.permission_warn_before_seconds`, `claude.default_model`,
`codex.default_model`

## Architecture

```
Feishu WebSocket
      │
      ▼
FeishuGateway (event decryption, dedup, access control)
      │
      ├─ onMessage ──▶ parseInput (router)
      │                    │
      │                    ├─ /command ──▶ CommandDispatcher
      │                    │
      │                    └─ plain text ──▶ ClaudeSession.submit
      │                                        │
      │                                        ▼
      │                           provider queryFn (Claude or Codex)
      │                                        │
      │                                        ├─ tool_use ──▶ PermissionBroker ──▶ Feishu card
      │                                        ├─ thinking ──▶ Feishu card (streaming)
      │                                        └─ text ──▶ Feishu answer card
      │
      └─ onCardAction ──▶ PermissionBroker.resolveByCard
                          QuestionBroker.resolveByCard
                          CommandDispatcher.resolveCdConfirm
```

**Key components:**

- **`FeishuGateway`** — receives WebSocket events, verifies signatures, deduplicates, enforces access control
- **`ClaudeSession`** — shared session state machine (idle → generating → idle) with message queue, drives the selected provider runtime
- **`ClaudeSessionManager`** — `chat_id → ClaudeSession` map with persistence, provider selection, and crash recovery
- **`FeishuPermissionBroker`** — posts permission cards, tracks pending approvals, handles timeouts
- **`CommandDispatcher`** — handles slash commands (`/new`, `/cd`, `/config set`, etc.)

## Context Handling

The bot now applies staged mitigation before it hits Claude's 50MB hard request limit:

1. `warn` — notify that the session is getting large
2. `hard reset fallback` — keep the backend-driven `Request too large / max 50MB` reset-and-retry path as the last fallback

Use `/context` to inspect current window usage and see the mitigation order reflected in user-facing output.

## Development

```bash
# Clone and install
git clone https://github.com/Blackman99/agent-feishu-channel.git
cd agent-feishu-channel
pnpm install

# Run in dev mode
pnpm dev

# Run tests
pnpm test

# Type check
pnpm typecheck

# Build
pnpm build
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_FEISHU_CONFIG` | Override config file path (default: `~/.agent-feishu-channel/config.toml`) |
| `CLAUDE_FEISHU_CONFIG` | Legacy alias for `AGENT_FEISHU_CONFIG` (still honored) |
| `ANTHROPIC_BASE_URL` | Custom API endpoint for Claude SDK |
| `ANTHROPIC_AUTH_TOKEN` | Auth token for custom endpoint |

## Current Codex Limits

- Mid-turn `acceptEdits` escalation is still a provider-specific downgrade on Codex: `setPermissionMode()` is a safe no-op in the current adapter.

## License

MIT

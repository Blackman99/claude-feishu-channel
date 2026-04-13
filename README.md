<p align="center">
  <img src="assets/logo.svg" width="180" alt="CFC Logo" />
</p>

<h1 align="center">claude-feishu-channel</h1>

<p align="center">
  Bridge between <a href="https://claude.ai/claude-code">Claude Code</a> and <a href="https://www.feishu.cn/">Feishu / Lark</a> group chat.
  <br />
  Send messages in Feishu → Claude processes with full tool access → results stream back as interactive cards.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-feishu-channel"><img src="https://img.shields.io/npm/v/claude-feishu-channel.svg" alt="npm version" /></a>
  <a href="https://github.com/Blackman99/claude-feishu-channel/actions/workflows/ci.yml"><img src="https://github.com/Blackman99/claude-feishu-channel/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/node/v/claude-feishu-channel" alt="node version" />
</p>

## Features

- **Full Claude Code agent** — file editing, shell commands, search, planning
- **Permission brokering** — tool calls post interactive approval cards in Feishu
- **Session persistence** — survives process restarts, auto-resumes conversations
- **Queue & interrupt** — messages queue during generation; `!` prefix interrupts
- **Interactive cards** — streaming status, tool activity, thinking blocks, permissions
- **Runtime config** — `/config set` to tune behavior without restart

## Quick Start

### Install

```bash
npm install -g claude-feishu-channel
```

### Initialize config

```bash
cfc init
# Creates ~/.claude-feishu-channel/config.toml from template
```

Edit the config with your Feishu credentials:

```bash
vim ~/.claude-feishu-channel/config.toml
```

### Run

```bash
cfc
```

The bot connects to Feishu via WebSocket and starts listening for messages.

### CLI Options

```
cfc [options]            Start the service
cfc init                 Create config template at ~/.claude-feishu-channel/config.toml

Options:
  -c, --config <path>    Path to config.toml (overrides default location)
  -v, --version          Show version number
  -h, --help             Show help
```

## Prerequisites

- **Node.js** >= 20
- **Claude CLI** — `claude` binary in `$PATH` (or set `claude.cli_path` in config)
- **Feishu bot app** — created at [open.feishu.cn](https://open.feishu.cn/app)

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (clear context) |
| `/stop` | Interrupt current generation |
| `/status` | Show session state, model, token usage |
| `/sessions` | List all known sessions |
| `/resume <id>` | Resume a previous session |
| `/cd <path>` | Change working directory (with confirm card) |
| `/project <alias>` | Switch to a configured project alias |
| `/mode <mode>` | Set permission mode: `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| `/model <name>` | Switch Claude model |
| `/config show` | Display current configuration |
| `/config set <key> <value>` | Change a config value at runtime |
| `/config set <key> <value> --persist` | Change and write back to config.toml |
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
| `[claude]` | `default_cwd`, `default_permission_mode`, `default_model`, `cli_path`, `permission_timeout_seconds`, `permission_warn_before_seconds` | Claude agent defaults |
| `[render]` | `inline_max_bytes`, `hide_thinking`, `show_turn_stats` | Card rendering options |
| `[persistence]` | `state_file`, `log_dir`, `session_ttl_days` | State and log paths |
| `[logging]` | `level` | Log level: `trace`, `debug`, `info`, `warn`, `error` |
| `[projects]` | `<alias> = "<path>"` | Project aliases for `/project` command |

### Runtime-settable keys

These keys can be changed via `/config set` without restart:

`render.hide_thinking`, `render.show_turn_stats`, `render.inline_max_bytes`,
`logging.level`, `claude.default_model`, `claude.default_cwd`,
`claude.default_permission_mode`, `claude.permission_timeout_seconds`,
`claude.permission_warn_before_seconds`

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
      │                                  SDK query (claude-agent-sdk)
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
- **`ClaudeSession`** — state machine (idle → generating → idle) with message queue, drives the SDK query loop
- **`ClaudeSessionManager`** — `chat_id → ClaudeSession` map with persistence and crash recovery
- **`FeishuPermissionBroker`** — posts permission cards, tracks pending approvals, handles timeouts
- **`CommandDispatcher`** — handles slash commands (`/new`, `/cd`, `/config set`, etc.)

## Development

```bash
# Clone and install
git clone https://github.com/Blackman99/claude-feishu-channel.git
cd claude-feishu-channel
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
| `CLAUDE_FEISHU_CONFIG` | Override config file path (default: `~/.claude-feishu-channel/config.toml`) |
| `ANTHROPIC_BASE_URL` | Custom API endpoint for Claude SDK |
| `ANTHROPIC_AUTH_TOKEN` | Auth token for custom endpoint |

## License

MIT

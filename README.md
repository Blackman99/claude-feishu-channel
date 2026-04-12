# claude-feishu-channel

Bridge between [Claude Code](https://claude.ai/claude-code) (Anthropic's CLI agent) and [Feishu / Lark](https://www.feishu.cn/) group chat. Send messages in a Feishu group → Claude processes them with full tool access (file read/write, shell, search) → results stream back as interactive Feishu cards.

## Features

- **Full Claude Code agent** — file editing, shell commands, search, planning
- **Permission brokering** — tool calls post interactive approval cards in Feishu
- **Session persistence** — survives process restarts, auto-resumes conversations
- **Queue & interrupt** — messages queue during generation; `!` prefix interrupts
- **Interactive cards** — streaming status, tool activity, thinking blocks, permissions
- **Runtime config** — `/config set` to tune behavior without restart

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** (package manager)
- **Claude CLI** — `claude` binary in `$PATH` (or set `claude.cli_path` in config)
- **Feishu bot app** — created at [open.feishu.cn](https://open.feishu.cn/app)

## Quick Start

1. **Install dependencies:**

```bash
pnpm install
```

2. **Copy and edit config:**

```bash
mkdir -p ~/.claude-feishu-channel
cp config.example.toml ~/.claude-feishu-channel/config.toml
# Edit config.toml: fill in Feishu credentials and your open_id
```

3. **Run:**

```bash
pnpm dev
```

The bot will connect to Feishu via WebSocket and start listening for messages.

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
# Run tests
pnpm test

# Type check
pnpm typecheck

# Run in dev mode (auto-restart)
pnpm dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_FEISHU_CONFIG` | Override config file path (default: `~/.claude-feishu-channel/config.toml`) |
| `ANTHROPIC_BASE_URL` | Custom API endpoint for Claude SDK |
| `ANTHROPIC_AUTH_TOKEN` | Auth token for custom endpoint |

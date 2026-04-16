# Configuration

Claude Feishu Channel is configured via a TOML file. The default location is `~/.claude-feishu-channel/config.toml`. You can override this path by setting the `CLAUDE_FEISHU_CONFIG` environment variable.

A fully commented example is available in [`config.example.toml`](https://github.com/Blackman99/claude-feishu-channel/blob/main/config.example.toml) at the project root.

## Config File Setup

```bash
mkdir -p ~/.claude-feishu-channel
cp config.example.toml ~/.claude-feishu-channel/config.toml
```

## Config Sections

### `[feishu]` — Feishu App Credentials

| Key | Description |
|-----|-------------|
| `app_id` | Your Feishu app's App ID (from [open.feishu.cn](https://open.feishu.cn/app) > Credentials) |
| `app_secret` | Your Feishu app's App Secret |
| `encrypt_key` | Event encryption key (optional; only if encryption is enabled in the Feishu console) |
| `verification_token` | Event verification token (optional) |

### `[access]` — Access Control

| Key | Description |
|-----|-------------|
| `allowed_open_ids` | Array of `open_id` values allowed to talk to the bot |
| `unauthorized_behavior` | `"ignore"` (silently drop) or `"reject"` (reply with error) |

::: warning
The bot has full shell and file access to your machine. Always configure `allowed_open_ids` to restrict access.
:::

### `[agent]` — Shared Agent Defaults

| Key | Default | Description |
|-----|---------|-------------|
| `default_provider` | `"claude"` | Default provider for new chats: `claude` or `codex` |
| `default_cwd` | `"~/my-projects"` | Working directory for new sessions |
| `default_permission_mode` | `"default"` | Permission mode: `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| `permission_timeout_seconds` | `300` | Seconds before a permission card auto-denies |
| `permission_warn_before_seconds` | `60` | Seconds before timeout to post a reminder |
| `auto_compact_threshold` | provider default | Provider-native compact hint threshold, when supported |

### `[claude]` — Claude Runtime Defaults

| Key | Default | Description |
|-----|---------|-------------|
| `default_model` | `"claude-opus-4-6"` | Model ID passed to the CLI's `--model` flag |
| `cli_path` | `"claude"` | Path to the `claude` binary; resolves via `$PATH` by default |

### `[codex]` — Codex Runtime Defaults

| Key | Default | Description |
|-----|---------|-------------|
| `default_model` | `"gpt-5-codex"` | Model ID passed to the Codex SDK |
| `cli_path` | `"codex"` | Path to the `codex` binary; resolves via `$PATH` by default |

### `[render]` — Card Rendering Options

| Key | Default | Description |
|-----|---------|-------------|
| `inline_max_bytes` | `2048` | Max UTF-8 bytes of inline content before truncation |
| `hide_thinking` | `false` | Skip Claude's extended-thinking blocks entirely |
| `show_turn_stats` | `true` | Show token usage and timing after each turn |

### `[persistence]` — State and Log Paths

| Key | Default | Description |
|-----|---------|-------------|
| `state_file` | `"~/.claude-feishu-channel/state.json"` | Path to the session state file |
| `log_dir` | `"~/.claude-feishu-channel/logs"` | Directory for structured log files |
| `session_ttl_days` | `30` | Days to keep session records before cleanup on startup |

### `[logging]` — Log Level

| Key | Default | Description |
|-----|---------|-------------|
| `level` | `"info"` | Log level: `trace`, `debug`, `info`, `warn`, `error` |

### `[projects]` — Project Aliases

Define aliases for the `/project` command to quickly switch working directories:

```toml
[projects]
my-app = "~/projects/my-app"
infra = "~/projects/infrastructure"
```

## Runtime-Settable Keys

The following keys can be changed at runtime via `/config set` without restarting the process:

| Key | Description |
|-----|-------------|
| `render.hide_thinking` | Toggle thinking block visibility |
| `render.show_turn_stats` | Toggle turn statistics |
| `render.inline_max_bytes` | Change inline content truncation limit |
| `logging.level` | Change log verbosity |
| `agent.default_provider` | Change the default provider for new chats |
| `agent.default_cwd` | Change the shared default working directory |
| `agent.default_permission_mode` | Change the shared default permission mode |
| `agent.permission_timeout_seconds` | Adjust permission timeout |
| `agent.permission_warn_before_seconds` | Adjust the timeout warning threshold |
| `claude.default_model` | Switch the default Claude model |
| `codex.default_model` | Switch the default Codex model |

### The `--persist` Flag

By default, `/config set` only changes the value in memory for the current process. Add `--persist` to write the change back to `config.toml` so it survives restarts:

```
/config set logging.level debug --persist
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_FEISHU_CONFIG` | Override the config file path (default: `~/.claude-feishu-channel/config.toml`) |
| `ANTHROPIC_BASE_URL` | Custom API endpoint for the Claude SDK |
| `ANTHROPIC_AUTH_TOKEN` | Auth token for a custom endpoint |

::: tip
Environment variables take precedence over config file values where applicable.
:::

## Provider Notes

- Existing chats persist their chosen provider and resume with the same provider after restart.
- Switching provider in chat with `/provider <claude|codex>` starts a fresh provider-native thread for that chat.
- Codex currently treats mid-turn `acceptEdits` escalation as a no-op; all other shared session/config behavior stays aligned where possible.

# Getting Started

Claude Feishu Channel bridges [Claude Code](https://claude.ai/claude-code) (Anthropic's CLI agent) and [Feishu / Lark](https://www.feishu.cn/) group chat. Send a message in a Feishu group, and Claude processes it with full tool access — file read/write, shell commands, search — then streams results back as interactive Feishu cards.

## Prerequisites

Before you begin, make sure you have:

- **Node.js** >= 20
- **Claude CLI** — the `claude` binary must be in your `$PATH` (or you can set `claude.cli_path` in the config file)
- **A Feishu bot app** — created at [open.feishu.cn](https://open.feishu.cn/app)

## Install

Install globally via npm:

```bash
npm install -g claude-feishu-channel
```

This gives you the `cfc` command.

## Quick Start

### 1. Initialize config

```bash
cfc init
```

This creates a config template at `~/.claude-feishu-channel/config.toml`.

### 2. Edit config

```bash
vim ~/.claude-feishu-channel/config.toml
```

Fill in your Feishu credentials and allowed `open_id` values.

### 3. Run

```bash
cfc
```

The bot will connect to Feishu via WebSocket and start listening for messages.

### CLI Options

```
cfc [options]            Start the service
cfc init                 Create config template

Options:
  -c, --config <path>    Path to config.toml (overrides default)
  -v, --version          Show version number
  -h, --help             Show help
```

You can also specify a custom config file:

```bash
cfc --config /path/to/my-config.toml
```

Or use the environment variable:

```bash
CLAUDE_FEISHU_CONFIG=/path/to/config.toml cfc
```

## Setting Up Your Feishu Bot

1. Go to the [Feishu Open Platform](https://open.feishu.cn/app) and create a new custom app.
2. Under **Credentials**, copy the `App ID` and `App Secret` into your `config.toml` under `[feishu]`.
3. If you enabled event encryption in the developer console, also fill in `encrypt_key` and `verification_token`.
4. Enable the **Bot** capability for your app, and add it to the Feishu group where you want to interact with Claude.

::: tip How to find your open_id
Your `open_id` is a per-app user identifier that looks like `ou_xxxxxxxxxxxxxxxx`. To find yours, temporarily set `unauthorized_behavior = "reject"` and `allowed_open_ids = []` in your config, then send a message to the bot. The bot will log the `sender_open_id` of the incoming message. Copy that value into the `allowed_open_ids` list.
:::

::: warning
The bot has full shell and file access to your machine. Always configure `allowed_open_ids` to restrict who can interact with it.
:::

## Development Setup

If you want to develop or contribute:

```bash
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

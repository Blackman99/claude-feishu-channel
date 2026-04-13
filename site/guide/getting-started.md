# Getting Started

Claude Feishu Channel bridges [Claude Code](https://claude.ai/claude-code) (Anthropic's CLI agent) and [Feishu / Lark](https://www.feishu.cn/) group chat. Send a message in a Feishu group, and Claude processes it with full tool access — file read/write, shell commands, search — then streams results back as interactive Feishu cards.

## Prerequisites

Before you begin, make sure you have:

- **Node.js** >= 20
- **pnpm** package manager
- **Claude CLI** — the `claude` binary must be in your `$PATH` (or you can set `claude.cli_path` in the config file)
- **A Feishu bot app** — created at [open.feishu.cn](https://open.feishu.cn/app)

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Copy and edit config

```bash
mkdir -p ~/.claude-feishu-channel
cp config.example.toml ~/.claude-feishu-channel/config.toml
```

Open `~/.claude-feishu-channel/config.toml` and fill in your Feishu credentials and allowed `open_id` values.

### 3. Run

```bash
pnpm dev
```

The bot will connect to Feishu via WebSocket and start listening for messages.

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

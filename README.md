# claude-feishu-channel

Bridge a Claude Code session to a Feishu (Lark) bot so you can drive your local Claude Code from a phone chat.

**Status: Phase 2 of 8** — single-turn Claude via `@anthropic-ai/claude-agent-sdk`. No queue, no tool rendering, no permission cards yet. See `docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md` for the full design.

## Requirements

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- A Feishu developer account with a custom app
- A Feishu bot added to the custom app, with the `im:message` and `im:message.receive_v1` event subscribed
- WebSocket event delivery mode enabled (no public webhook URL required)

## Credentials

The Claude Agent SDK runs Claude Code in-process and needs an auth credential. Set one of:

- `ANTHROPIC_API_KEY` — Anthropic API key (recommended for headless use)
- `CLAUDE_CODE_OAUTH_TOKEN` — OAuth token from `claude login`
- `CLAUDE_CODE_USE_BEDROCK=1` (+ AWS creds) — Bedrock
- `CLAUDE_CODE_USE_VERTEX=1` (+ GCP creds) — Vertex

The bridge fails fast at startup if none are present.

## Setup

```bash
pnpm install
mkdir -p ~/.claude-feishu-channel
cp config.example.toml ~/.claude-feishu-channel/config.toml
# Edit the file and fill in app_id, app_secret, and allowed_open_ids
```

## Run

```bash
pnpm dev
```

You should see a banner like:
```
claude-feishu-channel Phase 2 ready
```

Send a text message to the bot from a whitelisted account in Feishu. The bot replies:
```
(Claude's actual response to your message)
```

## Test

```bash
pnpm test         # run once
pnpm test:watch   # watch mode
pnpm typecheck    # type-only check
```

## Getting your open_id

Temporarily add this to `src/index.ts` inside `onMessage`:
```ts
logger.warn({ sender_open_id: msg.senderOpenId }, "Sender open_id");
```
Send a message, copy the `open_id` from the log, add it to `allowed_open_ids` in `config.toml`, then remove the debug log.

## Layout

```
src/
  index.ts               # main entry
  config.ts              # TOML loader + zod schema
  types.ts               # shared types
  access.ts              # whitelist filter
  claude/
    session.ts           # single-turn Claude wrapper
    session-manager.ts   # chat_id → ClaudeSession
    preflight.ts         # credential check
  feishu/
    client.ts            # REST wrapper (send text)
    gateway.ts           # WSClient + event dispatch
    renderer.ts          # assistant-text extractor
  persistence/
    state-store.ts       # atomic JSON state
  util/
    logger.ts            # pino with redaction
    deferred.ts          # Promise helper
    mutex.ts             # FIFO async mutex
    dedup.ts             # LRU dedup
    clock.ts             # injectable clock
test/
  unit/                  # mirrors src/
```

## Next phases

- Phase 3: Tool call rendering as Feishu cards
- Phase 4: State machine + queue + `!` interrupt prefix
- Phase 5: Permission bridging via interactive cards
- Phase 6: Slash commands (/new, /cd, /stop, ...)
- Phase 7: Persistence of session_id + crash recovery
- Phase 8: E2E polish

See `docs/superpowers/plans/` for per-phase plans.

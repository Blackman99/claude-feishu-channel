# claude-feishu-channel

Bridge a Claude Code session to a Feishu (Lark) bot so you can drive your local Claude Code from a phone chat.

**Status: Phase 3 of 8** — single-turn Claude with streamed tool-call / tool-result Feishu cards, thinking blocks, and per-turn stats. No queue, no permission cards yet. See `docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md` for the full design.

## Requirements

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- A Feishu developer account with a custom app
- A Feishu bot added to the custom app, with the `im:message` and `im:message.receive_v1` event subscribed
- WebSocket event delivery mode enabled (no public webhook URL required)

## Credentials

The Claude Agent SDK runs Claude Code in-process and needs an auth credential. Set one of:

- `ANTHROPIC_API_KEY` — Anthropic API key (recommended for headless use)
- `ANTHROPIC_AUTH_TOKEN` — bearer token for an Anthropic-compatible endpoint (combine with `ANTHROPIC_BASE_URL`)
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
claude-feishu-channel Phase 3 ready
```

Send a text message to the bot from a whitelisted account in Feishu. Each turn now streams as multiple Feishu messages:

- A 🔧 blue card per tool call Claude makes (Bash / Read / Edit / Write / Grep / generic fallback)
- A ✅ green / ❌ red card per tool result
- A 💭 thinking message for extended-thinking blocks (unless `hide_thinking = true`)
- Assistant text as plain text
- A final `✅ 本轮耗时 ... tokens` stats tip (unless `show_turn_stats = false`)

## Configuration

Config lives at `~/.claude-feishu-channel/config.toml` (or `$CLAUDE_FEISHU_CONFIG`). See `config.example.toml` for the full template. Notable Phase 3 section:

- `[render]` — card rendering knobs:
  - `inline_max_bytes` (default `2048`): UTF-8 byte limit for inline tool params / tool output previews before truncation
  - `hide_thinking` (default `false`): skip Claude's extended-thinking blocks entirely
  - `show_turn_stats` (default `true`): append `"✅ 本轮耗时 12.3s · 输入 1.2k / 输出 3.4k tokens"` after each turn

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
  index.ts               # main entry + RenderEvent dispatcher
  config.ts              # TOML loader + zod schema
  types.ts               # shared types
  access.ts              # whitelist filter
  claude/
    session.ts           # streams RenderEvents from SDK
    session-manager.ts   # chat_id → ClaudeSession
    preflight.ts         # credential check
    render-event.ts      # RenderEvent tagged union
  feishu/
    client.ts            # REST wrapper (sendText, sendCard)
    gateway.ts           # WSClient + event dispatch
    card-types.ts        # Feishu Card v2 TypeScript types
    cards.ts             # buildToolUseCard / buildToolResultCard
    messages.ts          # thinking / stats / error text formatters
    tool-formatters.ts   # per-tool input summaries
    tool-result.ts       # tool_result content extractor
    truncate.ts          # UTF-8 byte-aware truncation
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

- Phase 4: State machine + queue + `!` interrupt prefix
- Phase 5: Permission bridging via interactive cards
- Phase 6: Slash commands (/new, /cd, /stop, ...)
- Phase 7: Persistence of session_id + crash recovery
- Phase 8: E2E polish

See `docs/superpowers/plans/` for per-phase plans.

# Architecture

Claude Feishu Channel is built around a WebSocket connection to Feishu and a per-chat session model that drives the Claude Code CLI.

## System Overview

```
Feishu WebSocket
      |
      v
FeishuGateway (event decryption, dedup, access control)
      |
      +-- onMessage --> parseInput (router)
      |                    |
      |                    +-- /command --> CommandDispatcher
      |                    |
      |                    +-- plain text --> ClaudeSession.submit
      |                                        |
      |                                        v
      |                                  SDK query (claude-agent-sdk)
      |                                        |
      |                                        +-- tool_use --> PermissionBroker --> Feishu card
      |                                        +-- thinking --> Feishu card (streaming)
      |                                        +-- text --> Feishu answer card
      |
      +-- onCardAction --> PermissionBroker.resolveByCard
                           QuestionBroker.resolveByCard
                           CommandDispatcher.resolveCdConfirm
```

## Components

### FeishuGateway

The entry point for all Feishu events. It receives WebSocket messages, verifies signatures, deduplicates events (Feishu may deliver the same event more than once), and enforces access control based on the `allowed_open_ids` list.

Incoming messages are routed through `parseInput`:
- Slash commands (e.g. `/new`, `/cd`) go to the **CommandDispatcher**.
- Plain text and `!`-prefixed interrupts go to the **ClaudeSession**.
- Card action callbacks (permission approvals/denials) go to the appropriate broker.

### ClaudeSession

A per-chat state machine that manages the conversation with Claude Code. Each Feishu chat has at most one active session.

**State machine:**

```
idle --> generating --> idle
 ^                      |
 |                      |
 +---- (on complete) ---+
```

- **idle** — waiting for user input. New messages are submitted immediately.
- **generating** — Claude is processing. Incoming messages are queued and will be submitted once the current turn completes.

The session drives the SDK query loop: it submits user text to the Claude CLI, then handles the stream of events (text chunks, tool use requests, thinking blocks) as they arrive.

### ClaudeSessionManager

Maps `chat_id` to `ClaudeSession` instances. Handles:

- Creating new sessions on first contact from a chat.
- Persisting session state to disk (`state.json`) for crash recovery.
- Restoring sessions on process restart.
- Pruning expired sessions based on `session_ttl_days`.

### FeishuPermissionBroker

Manages the permission approval flow for tool calls:

1. When Claude wants to use a tool (file write, shell command, etc.), the broker posts an interactive **permission card** to the Feishu group.
2. The card shows the tool name and parameters, with Approve / Deny buttons.
3. Only the user who sent the triggering message can click.
4. If no response is received within `permission_timeout_seconds`, the request is auto-denied.
5. A warning reminder is posted `permission_warn_before_seconds` before the deadline.

### CommandDispatcher

Handles all slash commands (`/new`, `/stop`, `/cd`, `/config set`, etc.). Each command is parsed, validated, and executed. Some commands (like `/cd`) post a confirmation card before taking effect.

## Data Flow: Message Lifecycle

A typical message flows through the system like this:

1. **User sends a message** in a Feishu group chat.
2. **FeishuGateway** receives the WebSocket event, decrypts it if needed, deduplicates, and checks if the sender's `open_id` is in `allowed_open_ids`.
3. **parseInput** determines if it is a slash command or plain text.
4. For plain text: **ClaudeSession.submit** is called.
   - If the session is **idle**, a new SDK query starts immediately.
   - If the session is **generating**, the message is queued.
5. **Claude processes** the input. As events stream back:
   - **Text** chunks are assembled and rendered into a Feishu answer card (streaming updates).
   - **Thinking** blocks are sent as separate card messages (unless `hide_thinking` is enabled).
   - **Tool use** requests trigger the **PermissionBroker**, which posts an approval card.
6. The user **approves or denies** the tool call via the Feishu card.
7. The tool result is fed back to Claude, which continues generating.
8. When the turn completes, the session returns to **idle** and processes any queued messages.

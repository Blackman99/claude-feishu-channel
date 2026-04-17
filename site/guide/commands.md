# Commands

Agent Feishu Channel supports slash commands and special input prefixes to control sessions, change settings, and manage the active agent provider.

## Command Reference

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (clear context) |
| `/stop` | Interrupt current generation |
| `/status` | Show session state, model, token usage |
| `/cost` | Show token usage totals for this session |
| `/context` | Show context window usage and mitigation status |
| `/compact` | Reset the current session to free context |
| `/sessions` | List all known sessions |
| `/projects` | List all configured project aliases |
| `/resume <id>` | Resume a previous session |
| `/cd <path>` | Change working directory (with confirm card) |
| `/project <alias>` | Switch to a configured project alias |
| `/provider <claude\|codex>` | Switch the current session provider |
| `/mode <mode>` | Set permission mode |
| `/model <name>` | Switch the current provider model |
| `/config show` | Display current configuration |
| `/config set <key> <value>` | Change a config value at runtime |
| `/config set <key> <value> --persist` | Change and write back to `config.toml` |
| `/memory` | Show global and project `CLAUDE.md` contents |
| `/memory add <text>` | Append a bullet to the project `CLAUDE.md` |
| `/help` | Show available commands |

## Special Inputs

| Input | Effect |
|-------|--------|
| `!<text>` | Interrupt the current turn and run `<text>` as a new turn |
| Plain text | Queue as next turn (or start immediately if idle) |

::: tip
Messages sent while the agent is generating are automatically queued and processed in order once the current turn completes.
:::

## Session Management

### `/new`

Starts a fresh provider session, clearing prior conversation context for the current chat.

### `/stop`

Interrupts the current generation. If the current provider is mid-response, this will halt it. You can also use the `!` prefix to interrupt and immediately submit new input.

### `/status`

Displays the current session state, active provider, active model, and token usage statistics.

### `/cost`

Prints the running token totals for the current session — total input tokens, total output tokens, and their sum. Use `/status` for a broader snapshot or `/context` for window-usage percentages.

### `/context`

Displays current context-window usage. When usage is high, the response also explains the mitigation order:

`warn -> hard reset fallback`

### `/compact`

Manually resets the current session to free context. Only runs when the session is idle; cancels any pending permission or question cards. Use this when `/context` shows the window is near full and you want to start fresh without losing the chat's session record.

### `/sessions`

Lists all known sessions for the current chat. Each session has an ID that you can use with `/resume`.

### `/projects`

Lists all project aliases defined in the `[projects]` section of `config.toml`, along with their paths and whether a session exists for each one. Use `/project <alias>` to switch to one.

### `/resume <id>`

Resumes a previously created session by its ID. This restores the full conversation context from that session and preserves the provider that session was using.

## Working Directory

### `/cd <path>`

Changes the working directory for the current session. A confirmation card is posted in the Feishu group before the change takes effect.

### `/project <alias>`

Switches the working directory to a pre-configured project alias. Project aliases are defined in the `[projects]` section of `config.toml`:

```toml
[projects]
my-app = "~/projects/my-app"
infra = "~/projects/infrastructure"
```

## Model and Permissions

### `/provider <claude|codex>`

Switches the current chat to a different provider. This starts a fresh provider-native thread for the chat, but leaves the chat-scoped session record in place.

### `/mode <mode>`

Sets the permission mode for the current session. Available modes:

| Mode | Behavior |
|------|----------|
| `default` | Tool calls post a permission card in the Feishu group; only the triggering user can approve |
| `acceptEdits` | Auto-approve file edits; shell commands still require approval via permission card |
| `plan` | Plan mode, read-only |
| `bypassPermissions` | Auto-approve everything; permission broker disabled |

::: warning
`bypassPermissions` gives the current provider unrestricted shell and file access. Use with caution.
:::

### `/model <name>`

Switches the model for the current provider. For Claude this can be values like `claude-opus-4-6`; for Codex this can be values like `gpt-5.4`.

## Configuration

### `/config show`

Displays the current runtime configuration values.

### `/config set <key> <value>`

Changes a configuration value at runtime. Only certain keys are runtime-settable — see the [Configuration](/guide/configuration) page for the full list.

Add `--persist` to write the change back to `config.toml` so it survives restarts:

```
/config set render.hide_thinking true --persist
```

## Memory

The provider reads two `CLAUDE.md` files when it starts a turn: the **global** file at `~/.claude/CLAUDE.md` (cross-project instructions) and the **project** file at `<cwd>/CLAUDE.md` (project-specific notes). These commands let you inspect and extend them without leaving Feishu.

### `/memory`

Posts the contents of the global and project `CLAUDE.md` files (whichever exist). Use this to confirm what the provider is currently seeing as standing instructions.

### `/memory add <text>`

Appends `<text>` as a new bullet to the project `CLAUDE.md` (at `<cwd>/CLAUDE.md`). Handy for quick "remember this" notes that should influence subsequent turns in the same project.

```
/memory add 统一用 pnpm，不要用 npm
```

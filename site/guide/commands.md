# Commands

Agent Feishu Channel supports slash commands and special input prefixes to control sessions, change settings, and manage the active agent provider.

## Command Reference

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (clear context) |
| `/stop` | Interrupt current generation |
| `/status` | Show session state, model, token usage |
| `/context` | Show context window usage and mitigation status |
| `/sessions` | List all known sessions |
| `/projects` | List all configured project aliases |
| `/resume <id>` | Resume a previous session |
| `/cd <path>` | Change working directory (with confirm card) |
| `/project <alias>` | Switch to a configured project alias |
| `/provider <claude|codex>` | Switch the current session provider |
| `/mode <mode>` | Set permission mode |
| `/model <name>` | Switch the current provider model |
| `/config show` | Display current configuration |
| `/config set <key> <value>` | Change a config value at runtime |
| `/config set <key> <value> --persist` | Change and write back to `config.toml` |
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

### `/context`

Displays current context-window usage. When usage is high, the response also explains the mitigation order:

`warn -> compact -> summarized new session -> hard reset fallback`

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

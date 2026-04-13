# Commands

Claude Feishu Channel supports slash commands and special input prefixes to control sessions, change settings, and manage the Claude agent.

## Command Reference

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (clear context) |
| `/stop` | Interrupt current generation |
| `/status` | Show session state, model, token usage |
| `/sessions` | List all known sessions |
| `/resume <id>` | Resume a previous session |
| `/cd <path>` | Change working directory (with confirm card) |
| `/project <alias>` | Switch to a configured project alias |
| `/mode <mode>` | Set permission mode |
| `/model <name>` | Switch Claude model |
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
Messages sent while Claude is generating are automatically queued and processed in order once the current turn completes.
:::

## Session Management

### `/new`

Starts a fresh Claude session, clearing all prior context. Use this when you want to begin a completely new conversation.

### `/stop`

Interrupts the current generation. If Claude is mid-response, this will halt it. You can also use the `!` prefix to interrupt and immediately submit new input.

### `/status`

Displays the current session state, the active model, and token usage statistics.

### `/sessions`

Lists all known sessions for the current chat. Each session has an ID that you can use with `/resume`.

### `/resume <id>`

Resumes a previously created session by its ID. This restores the full conversation context from that session.

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

### `/mode <mode>`

Sets the permission mode for the current session. Available modes:

| Mode | Behavior |
|------|----------|
| `default` | Tool calls post a permission card in the Feishu group; only the triggering user can approve |
| `acceptEdits` | Auto-approve file edits; shell commands still require approval via permission card |
| `plan` | Plan mode, read-only |
| `bypassPermissions` | Auto-approve everything; permission broker disabled |

::: warning
`bypassPermissions` gives Claude unrestricted shell and file access. Use with caution.
:::

### `/model <name>`

Switches the Claude model. Accepts any model the local `claude` CLI supports, such as `claude-opus-4-6`, `claude-sonnet-4-6`, or aliases like `opus` / `sonnet`.

## Configuration

### `/config show`

Displays the current runtime configuration values.

### `/config set <key> <value>`

Changes a configuration value at runtime. Only certain keys are runtime-settable — see the [Configuration](/guide/configuration) page for the full list.

Add `--persist` to write the change back to `config.toml` so it survives restarts:

```
/config set render.hide_thinking true --persist
```

# Codex Provider Support Design

- **Date**: 2026-04-16
- **Status**: Draft
- **Author**: zhaodongsheng x Codex
- **Upstream context**: existing Claude-centric runtime in `src/index.ts`, `src/claude/*`, `src/commands/*`
- **Downstream output**: implementation plan for dual-provider support with `@openai/codex-sdk`

---

## 1. Goal

Add dual-provider support so the Feishu bot can run either Claude or Codex per configuration and per session.

The initial Codex implementation will use `@openai/codex-sdk`, not `codex exec --json`.

**Success criteria**:
1. Global default provider can be configured as `claude` or `codex`.
2. Each session persists its provider and resumes with the same provider after restart.
3. Users can override provider at the session level with a command.
4. Claude support continues to work with existing behavior.
5. Codex support integrates into the same Feishu interaction model: session lifecycle, status output, command handling, persistence, and approval/question flows where supported by the SDK surface.
6. Project internals stop assuming that all agent sessions are Claude sessions.

**Non-goals for this phase**:
1. Renaming the npm package, repository, or project branding.
2. Guaranteeing byte-for-byte identical event semantics between Claude SDK and Codex SDK.
3. Replacing the Feishu rendering model.
4. Reworking unrelated command behavior.

---

## 2. Product Decisions

### 2.1 Provider model

The system will support two providers:

- `claude`
- `codex`

Provider selection works at two levels:

1. Global default from config
2. Session-level override via command

The effective provider for a session is sticky once chosen. A later config change does not rewrite existing sessions.

### 2.2 Session switching behavior

Switching provider in an existing chat starts a fresh provider-specific conversation context. It does not attempt cross-provider resume.

Examples:

- A session started with Claude and later switched to Codex creates a new Codex thread.
- Resuming an old Claude session restores Claude even if the current global default is Codex.

### 2.3 Compatibility target

The target is to keep the user-facing Feishu experience as aligned as practical across providers, but provider-specific limitations are allowed where SDK capabilities differ.

This means:

- command surface should feel consistent
- status and answer rendering should stay consistent
- persistence and resume semantics should stay consistent
- permission and tool-interaction behavior may be provider-aware instead of perfectly identical

---

## 3. Architecture

### 3.1 Current problem

The current codebase is Claude-centric at multiple layers:

- config shape uses `[claude]`
- startup preflight assumes Claude CLI
- query runtime is implemented as `createSdkQueryFn()` for Claude
- session manager and session status use Claude-specific names
- command and persistence layers expose `claudeSessionId` terminology

This makes Codex support expensive unless the runtime boundary is generalized first.

### 3.2 Proposed runtime boundary

Introduce a provider abstraction between session orchestration and SDK-specific execution.

Recommended internal shape:

```ts
type AgentProviderId = "claude" | "codex";

interface AgentRunOptions {
  cwd: string;
  model: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  resumeId?: string;
  mcpServers?: AppMcpServer[];
  autoCompactThreshold?: number;
}

interface AgentProvider {
  readonly id: AgentProviderId;
  preflight(): Promise<ProviderPreflightResult>;
  startRun(input: AgentRunInput): AgentRunHandle;
}
```

The session layer owns queueing, interrupts, persistence triggers, Feishu cards, and command integration.

The provider layer owns:

- spawning or constructing the SDK client
- resuming provider-native conversation state
- translating provider-native events into internal normalized events
- applying provider-native permission mode changes where supported

### 3.3 Normalized event model

Feishu and session orchestration should consume normalized internal events rather than Claude/Codex raw SDK event objects.

Minimum normalized event families:

- `status`
- `text`
- `thinking`
- `tool_activity`
- `permission_request`
- `question`
- `provider_state`
- `turn_complete`
- `turn_error`

The model does not require the two providers to emit identical raw detail. It requires each provider adapter to map what it can into this internal vocabulary.

### 3.4 Scope of renaming

Public architecture should become provider-aware, but implementation can be staged.

Required de-Claude-ification in this phase:

- session persistence fields and status objects must stop using `claudeSessionId` as the canonical provider-neutral field
- runtime interfaces should no longer be named as Claude-only concepts if used by both providers

Allowed temporary debt in this phase:

- directories such as `src/claude/` may remain while the abstraction is introduced
- some class names may stay in place if the implementation wraps them cleanly and avoids leaking Claude-only naming into new shared contracts

---

## 4. Provider Implementations

### 4.1 Claude provider

Claude remains implemented through `@anthropic-ai/claude-agent-sdk`.

This path continues to use the existing behavior:

- local Claude CLI preflight
- SDK query loop
- current permission broker integration
- current question broker integration

The Claude adapter becomes one implementation of the new provider interface.

### 4.2 Codex provider

Codex is implemented through `@openai/codex-sdk`.

Expected responsibilities of the Codex adapter:

- construct Codex SDK client
- start or resume a provider thread
- run prompts against that thread
- capture provider thread ID for persistence
- map SDK output into normalized events
- expose interruption/cancellation through the unified run handle if supported
- expose provider-side mode changes only where the SDK allows them

### 4.3 Why not use `codex exec --json`

This design intentionally does not center on CLI JSON event parsing because:

1. the user requirement is to support Codex through the official SDK path
2. SDK integration is a cleaner long-term fit for a provider abstraction
3. CLI JSON output would leak a more fragile protocol surface into the runtime design

The design may still keep room for a future Codex CLI provider, but that is not part of this phase.

---

## 5. Configuration Design

### 5.1 New config structure

Configuration should separate provider-neutral defaults from provider-specific settings.

Recommended shape:

```toml
[agent]
default_provider = "claude"
default_cwd = "~/my-project"
default_permission_mode = "default"
permission_timeout_seconds = 300
permission_warn_before_seconds = 60
auto_compact_threshold = 0.8

[claude]
default_model = "claude-opus-4-6"
cli_path = "claude"

[codex]
default_model = "gpt-5-codex"
cli_path = "codex"
```

### 5.2 Compatibility strategy

The migration should not break existing config files.

Rules:

1. If `[agent]` exists, use it as the provider-neutral source of defaults.
2. If `[agent]` does not exist, fall back to current Claude-era defaults and assume `default_provider = "claude"`.
3. Existing `[claude]` values remain valid.
4. `[codex]` is optional unless the selected provider is `codex`.

### 5.3 Validation

Schema validation must become provider-aware:

- `default_provider` must be one of `claude` or `codex`
- provider-specific required keys are only required when that provider is configured or selected
- error messages must mention the provider name so startup failures are actionable

### 5.4 Runtime-settable config

If `/config set` continues to support runtime mutation, the provider-neutral keys should move under the neutral namespace.

Example target surface:

- `agent.default_provider`
- `agent.default_cwd`
- `agent.default_permission_mode`
- `agent.permission_timeout_seconds`
- `agent.permission_warn_before_seconds`
- `agent.auto_compact_threshold`
- `claude.default_model`
- `codex.default_model`

Whether provider-specific CLI path fields are mutable at runtime is optional; they can remain config-file-only if restart is required.

---

## 6. Session Model and Persistence

### 6.1 Session identity

Each session must persist both the provider and the provider-native resume identifier.

Provider-neutral persistence record:

```ts
interface SessionRecord {
  provider: "claude" | "codex";
  providerSessionId: string;
  cwd: string;
  permissionMode: PermissionMode;
  model: string;
  createdAt: string;
  lastActiveAt: string;
}
```

The canonical field is `providerSessionId`, not `claudeSessionId`.

### 6.2 Restore behavior

On startup:

1. load records from persistence
2. rebuild session objects lazily on access
3. restore provider, model, cwd, permission mode, and provider session ID
4. choose the proper provider adapter from the restored record

### 6.3 Effective provider resolution

For a new session:

1. explicit session override if already set
2. otherwise global default provider

For a restored session:

1. persisted provider from state

The global default never overrides a restored session.

### 6.4 Session status reporting

Status objects and UI output should report:

- provider
- provider session ID or thread ID
- model
- cwd
- queue/generation state

The wording should avoid Claude-only terminology in shared surfaces.

---

## 7. Command Design

### 7.1 New command

Add:

```text
/provider <claude|codex>
```

Behavior:

1. updates the current chat session override
2. resets provider-native conversation context for that session
3. keeps the session bound to the selected provider until changed again or replaced by `/new`
4. returns a confirmation message showing the new provider and effective model

### 7.2 Existing commands

`/new`

- clears current provider-native conversation state
- creates a fresh session using the effective default provider unless a new override is set later

`/resume <id>`

- resumes the exact persisted session identified by the stored record
- restores its original provider

`/status`

- includes provider in the output

`/model <name>`

- sets the model for the current session's active provider
- does not imply provider switching

`/config show`

- includes `agent.default_provider`
- includes Codex config block if present

`/help`

- documents `/provider`
- updates wording to refer to the agent provider rather than Claude-only behavior where applicable

### 7.3 Command invariants

The following rules must hold:

1. Provider changes are explicit. `/model` never changes provider.
2. Resume restores the provider stored with the target session.
3. A session cannot resume across providers.
4. A user can switch provider and continue in the same Feishu chat, but that creates a fresh provider-native context.

---

## 8. Permissions, Questions, and Capability Mapping

### 8.1 Principle

Do not assume Claude SDK and Codex SDK expose identical hooks.

Instead, define shared internal semantics and map each provider to them as far as the SDK allows.

### 8.2 Strong-consistency behaviors

These should behave consistently across providers:

- provider selection
- session persistence and restore
- Feishu command routing
- final answer rendering
- status/error reporting

### 8.3 Best-effort behaviors

These may vary by provider implementation details:

- thinking granularity
- tool activity granularity
- permission request timing and exact shape
- runtime permission mode updates
- cost/context statistics

### 8.4 Approval broker design

If Codex SDK exposes approval or tool authorization hooks compatible with the current Feishu broker model, the Codex adapter should route through the existing broker abstraction.

If the SDK surface differs, the provider adapter should:

1. preserve the existing Feishu approval UX where possible
2. degrade in a documented and explicit way where not possible
3. avoid faking unsupported semantics

The implementation plan must validate the real Codex SDK hook surface before promising parity for every approval flow.

### 8.5 Question broker design

Similarly, if Codex SDK allows agent-initiated user questions, those should map into the existing Feishu question card flow.

If not, the first implementation may omit that provider-specific path, but the spec requires that the limitation be documented rather than hidden.

---

## 9. Startup and Preflight

### 9.1 Provider preflight

Startup should validate the binaries or runtime requirements needed by configured providers.

Baseline requirement:

- the default provider must pass preflight before the service starts

Optional stronger behavior:

- if both providers are configured, preflight both and log a warning for the inactive provider rather than hard-failing startup

### 9.2 Claude preflight

Claude keeps the current local CLI `--version` style preflight.

### 9.3 Codex preflight

Codex preflight should validate the local requirements needed by `@openai/codex-sdk`.

At minimum, the implementation plan must determine whether the SDK:

- requires a local `codex` binary
- requires only Node/npm package availability
- requires environment validation for auth or local runtime

The preflight path should only check what is needed to fail fast on a misconfigured host. It should not attempt to validate full account state beyond what the SDK can reliably expose.

---

## 10. Documentation and User-Facing Language

### 10.1 README direction

README should stop describing the product as Claude-only.

Target messaging:

- Feishu/Lark bridge for Claude Code and Codex
- provider-aware prerequisites
- provider-aware configuration examples
- new `/provider` command

### 10.2 Branding boundary

This phase does not rename:

- package name
- repository
- binary name

The package can stay `claude-feishu-channel` while documentation clarifies that it now supports both providers.

### 10.3 Help and status text

Shared UI strings should use neutral wording where they refer to both providers.

Examples:

- "provider" instead of "Claude backend"
- "session ID" or "thread ID" in a provider-neutral status field

Provider-specific names can still appear where the user explicitly selected one.

---

## 11. Risks

### 11.1 SDK capability mismatch

The biggest risk is assuming Codex SDK exposes the same permission and interaction hooks as Claude SDK.

Mitigation:

- verify actual SDK surface before implementation claims parity
- isolate provider-specific logic in the adapter
- define best-effort behavior explicitly

### 11.2 Type and naming leakage

If Claude-specific names remain embedded in shared types, the codebase will accumulate confusing dual semantics.

Mitigation:

- make new shared contracts provider-neutral
- migrate persistence/status names first

### 11.3 Config migration confusion

Users with old config files may not understand the new default provider behavior.

Mitigation:

- preserve backward compatibility
- document fallback behavior clearly
- update `config.example.toml`

### 11.4 Over-promising parity

The product target is aligned UX, not guaranteed identical underlying semantics.

Mitigation:

- document capability differences where they exist
- keep the shared interface focused on the semantics the UI actually needs

---

## 12. Open Validation Items for Planning

These are not design blockers, but they must be resolved in the implementation plan before coding begins:

1. Exact `@openai/codex-sdk` event surface for streaming output, tool activity, and interruptions
2. Whether Codex SDK exposes explicit approval hooks compatible with the current Feishu permission broker
3. Whether Codex SDK exposes user-question hooks compatible with the current question broker
4. Whether Codex SDK requires a local `codex` binary and how preflight should verify that
5. Which current Claude-specific classes should be renamed immediately versus wrapped temporarily

---

## 13. Recommended Implementation Direction

Implement this in phases:

1. Introduce provider-neutral config and persistence fields
2. Add provider abstraction and wrap current Claude runtime
3. Add Codex provider backed by `@openai/codex-sdk`
4. Add `/provider` command and provider-aware status/help/config output
5. Update README and config template

This sequence keeps Claude stable while introducing Codex behind a clean boundary.

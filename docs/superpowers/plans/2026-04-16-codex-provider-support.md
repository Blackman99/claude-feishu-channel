# Codex Provider Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dual-provider support so the Feishu bot can run either Claude or Codex, with Codex backed by `@openai/codex-sdk`, while preserving existing Claude behavior.

**Architecture:** First move shared config, session persistence, and status reporting to provider-neutral contracts. Then introduce a provider runtime abstraction that wraps the current Claude SDK path and adds a new Codex SDK implementation. Finally wire provider-aware commands, startup preflight, and docs so provider selection works globally and per session.

**Tech Stack:** TypeScript, Node.js, Vitest, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, Feishu/Lark SDK

---

## File Structure

**Create:**
- `src/agent/provider.ts` - shared provider IDs, provider run interfaces, normalized event/handle contracts
- `src/agent/manager.ts` - provider registry and selection helpers
- `src/codex/preflight.ts` - Codex runtime preflight checks
- `src/codex/sdk-run.ts` - `@openai/codex-sdk` adapter that implements the shared provider contract
- `test/unit/agent/provider.test.ts` - unit coverage for shared provider helpers
- `test/unit/codex/preflight.test.ts` - Codex preflight coverage
- `test/unit/codex/sdk-run.test.ts` - Codex adapter coverage with fakes

**Modify:**
- `package.json`
- `src/types.ts`
- `src/config.ts`
- `src/index.ts`
- `src/commands/router.ts`
- `src/commands/dispatcher.ts`
- `src/claude/preflight.ts`
- `src/claude/query-handle.ts`
- `src/claude/sdk-query.ts`
- `src/claude/session.ts`
- `src/claude/session-manager.ts`
- `src/persistence/state-store.ts`
- `src/util/i18n.ts`
- `README.md`
- `config.example.toml`
- `test/unit/config.test.ts`
- `test/unit/commands/router.test.ts`
- `test/unit/commands/dispatcher.test.ts`
- `test/unit/claude/session-manager.test.ts`
- `test/unit/claude/session-state-machine.test.ts`
- `test/unit/claude/preflight.test.ts`
- `test/unit/persistence/state-store.test.ts`

---

### Task 1: Make Config and Persistence Provider-Neutral

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/persistence/state-store.ts`
- Modify: `config.example.toml`
- Test: `test/unit/config.test.ts`

- [ ] **Step 1: Write failing config and state tests for provider-neutral fields**

Add tests in `test/unit/config.test.ts` for:
- loading `[agent] default_provider = "codex"`
- continuing to load old Claude-only config without `[agent]`
- requiring `[codex]` defaults when Codex is the selected provider

Add or update state-store tests to expect provider-neutral session records:

```ts
expect(state.sessions["oc_1"]).toEqual({
  provider: "codex",
  providerSessionId: "thread_123",
  cwd: "/tmp/cfc-test",
  createdAt: expect.any(String),
  lastActiveAt: expect.any(String),
  permissionMode: "default",
  model: "gpt-5.4",
});
```

- [ ] **Step 2: Run targeted tests to confirm the old schema fails**

Run:

```bash
pnpm test test/unit/config.test.ts test/unit/claude/session-manager.test.ts test/unit/persistence/state-store.test.ts
```

Expected:
- FAIL because `agent.default_provider`, `codex`, `provider`, and `providerSessionId` are not implemented yet

- [ ] **Step 3: Implement provider-neutral app config and state types**

Update `src/types.ts` so `AppConfig` has a neutral `agent` block and provider-specific blocks:

```ts
export type AgentProvider = "claude" | "codex";
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export interface AppConfig {
  agent: {
    defaultProvider: AgentProvider;
    defaultCwd: string;
    defaultPermissionMode: PermissionMode;
    permissionTimeoutMs: number;
    permissionWarnBeforeMs: number;
    autoCompactThreshold?: number;
  };
  claude: {
    defaultModel: string;
    cliPath: string;
  };
  codex: {
    defaultModel: string;
    cliPath: string;
  };
}
```

Update `src/persistence/state-store.ts`:

```ts
export interface SessionRecord {
  provider: "claude" | "codex";
  providerSessionId: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode?: string;
  model?: string;
}
```

Add migration support in `load()` so existing persisted records:

```ts
{
  claudeSessionId: "ses_old"
}
```

become:

```ts
{
  provider: "claude",
  providerSessionId: "ses_old"
}
```

- [ ] **Step 4: Implement config parsing and backward compatibility**

Update `src/config.ts` with:
- new `AgentSchema`
- new `CodexSchema`
- compatibility fallback from old `[claude]` defaults into `app.agent`

Core mapping target:

```ts
agent: {
  defaultProvider: data.agent?.default_provider ?? "claude",
  defaultCwd: expandHome(data.agent?.default_cwd ?? data.claude.default_cwd),
  defaultPermissionMode:
    data.agent?.default_permission_mode ?? data.claude.default_permission_mode,
  permissionTimeoutMs:
    (data.agent?.permission_timeout_seconds ?? data.claude.permission_timeout_seconds) * 1000,
  permissionWarnBeforeMs:
    (data.agent?.permission_warn_before_seconds ?? data.claude.permission_warn_before_seconds) * 1000,
  ...(threshold !== undefined ? { autoCompactThreshold: threshold } : {}),
},
codex: {
  defaultModel: data.codex?.default_model ?? "gpt-5.4",
  cliPath: data.codex?.cli_path ?? "codex",
},
```

Update `config.example.toml` to include:

```toml
[agent]
default_provider = "claude"
default_cwd = "~/my-projects/claude-feishu-channel"
default_permission_mode = "default"
permission_timeout_seconds = 300
permission_warn_before_seconds = 60

[claude]
default_model = "claude-opus-4-6"
cli_path = "claude"

[codex]
default_model = "gpt-5.4"
cli_path = "codex"
```

- [ ] **Step 5: Run targeted tests to verify config and persistence pass**

Run:

```bash
pnpm test test/unit/config.test.ts test/unit/persistence/state-store.test.ts
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts src/persistence/state-store.ts config.example.toml test/unit/config.test.ts test/unit/persistence/state-store.test.ts
git commit -m "refactor: add provider-neutral config and session state"
```

---

### Task 2: Add Provider Abstractions and Wrap the Existing Claude Runtime

**Files:**
- Create: `src/agent/provider.ts`
- Create: `src/agent/manager.ts`
- Modify: `src/claude/query-handle.ts`
- Modify: `src/claude/sdk-query.ts`
- Modify: `src/claude/session.ts`
- Modify: `src/claude/session-manager.ts`
- Test: `test/unit/agent/provider.test.ts`
- Test: `test/unit/claude/session-manager.test.ts`
- Test: `test/unit/claude/session-state-machine.test.ts`

- [ ] **Step 1: Write failing tests for provider-neutral session status and resume**

Add expectations in `test/unit/claude/session-manager.test.ts`:

```ts
expect(status.provider).toBe("claude");
expect(status.providerSessionId).toBe("ses_stale");
```

Add a new provider helper test:

```ts
expect(defaultModelForProvider(
  "codex",
  config,
)).toBe("gpt-5.4");
```

- [ ] **Step 2: Run targeted tests to confirm the old session model fails**

Run:

```bash
pnpm test test/unit/claude/session-manager.test.ts test/unit/claude/session-state-machine.test.ts test/unit/agent/provider.test.ts
```

Expected:
- FAIL because `provider`/`providerSessionId` and provider helpers do not exist

- [ ] **Step 3: Create shared provider contracts**

Create `src/agent/provider.ts`:

```ts
import type { PermissionMode, AgentProvider as AgentProviderId } from "../types.js";

export interface ProviderRunOptions {
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  resumeId?: string;
  mcpServers?: Readonly<Record<string, unknown>>;
  autoCompactThreshold?: number;
}

export interface ProviderRunHandle {
  readonly messages: AsyncIterable<unknown>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): void;
}

export interface RuntimeProvider {
  readonly id: AgentProviderId;
  startRun(params: {
    prompt: string | AsyncIterable<unknown>;
    options: ProviderRunOptions;
    canUseTool?: unknown;
  }): ProviderRunHandle;
}
```

Create `src/agent/manager.ts` with provider resolution helpers:

```ts
export function defaultModelForProvider(
  provider: AgentProvider,
  config: AppConfig,
): string {
  return provider === "claude"
    ? config.claude.defaultModel
    : config.codex.defaultModel;
}
```

- [ ] **Step 4: Update Claude query/session code to use neutral fields**

In `src/claude/session.ts`:
- move `PermissionMode` imports to `src/types.ts`
- extend `SessionStatus` with:

```ts
provider: "claude";
providerSessionId?: string;
```

- keep `session_id` capture logic, but publish it via `providerSessionId`
- add `setProviderSessionId()` as the neutral setter

In `src/claude/session-manager.ts`:
- read defaults from `opts.config.agent`
- persist and restore `provider` + `providerSessionId`
- rename record conversions from `claudeSessionId` to `providerSessionId`

Core conversion target:

```ts
private statusToRecord(status: SessionStatus): SessionRecord {
  return {
    provider: status.provider,
    providerSessionId: status.providerSessionId!,
    cwd: status.cwd,
    createdAt: status.createdAt,
    lastActiveAt: status.lastActiveAt,
    permissionMode: status.permissionMode,
    model: status.model,
  };
}
```

- [ ] **Step 5: Run targeted tests to verify the Claude path still passes with the new neutral contracts**

Run:

```bash
pnpm test test/unit/agent/provider.test.ts test/unit/claude/session-manager.test.ts test/unit/claude/session-state-machine.test.ts
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/provider.ts src/agent/manager.ts src/claude/query-handle.ts src/claude/sdk-query.ts src/claude/session.ts src/claude/session-manager.ts test/unit/agent/provider.test.ts test/unit/claude/session-manager.test.ts test/unit/claude/session-state-machine.test.ts
git commit -m "refactor: introduce provider-neutral session runtime contracts"
```

---

### Task 3: Add Provider-Aware Commands and Session Selection

**Files:**
- Modify: `src/commands/router.ts`
- Modify: `src/commands/dispatcher.ts`
- Modify: `src/util/i18n.ts`
- Modify: `src/claude/session-manager.ts`
- Test: `test/unit/commands/router.test.ts`
- Test: `test/unit/commands/dispatcher.test.ts`
- Test: `test/unit/claude/session-manager.test.ts`

- [ ] **Step 1: Write failing tests for `/provider` and provider-aware status/config output**

In `test/unit/commands/router.test.ts` add:

```ts
expect(parseInput("/provider codex")).toEqual({
  kind: "command",
  cmd: { name: "provider", provider: "codex" },
});
```

In `test/unit/commands/dispatcher.test.ts` add expectations for:
- `/status` output containing provider
- `/config show` output containing `[agent]` and `[codex]`
- `/provider codex` switching the session

- [ ] **Step 2: Run targeted tests to confirm command support is missing**

Run:

```bash
pnpm test test/unit/commands/router.test.ts test/unit/commands/dispatcher.test.ts test/unit/claude/session-manager.test.ts
```

Expected:
- FAIL because `/provider` is unknown and status/config are Claude-only

- [ ] **Step 3: Implement router and dispatcher support**

In `src/commands/router.ts`:

```ts
export type ParsedCommand =
  | { name: "provider"; provider: "claude" | "codex" }
  | { name: "new" }
  | { name: "cost" }
  | { name: "context" };
```

Add `"provider"` to `KNOWN_COMMANDS` and parse:

```ts
case "provider":
  if (rest === "claude" || rest === "codex") {
    return { name: "provider", provider: rest };
  }
  return null;
```

In `src/commands/dispatcher.ts`:
- add `handleProvider()`
- include provider in `/status`
- include `[agent]` and `[codex]` in `/config show`
- treat `/model` as provider-specific for the current session

Target status lines:

```ts
const lines = [
  s.statusState(status.state),
  `🤖 ${status.provider}`,
  s.statusCwd(status.cwd),
  s.statusPermMode(status.permissionMode),
  s.statusModel(status.model),
];
```

`handleProvider()` target:

```ts
private async handleProvider(
  provider: "claude" | "codex",
  ctx: CommandContext,
): Promise<void> {
  const session = this.sessionManager.getOrCreate(ctx.chatId);
  if (session.getState() !== "idle") {
    await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
    return;
  }
  this.sessionManager.setProviderOverride(ctx.chatId, provider);
  this.sessionManager.delete(ctx.chatId);
  await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).providerSwitched(provider));
}
```

- [ ] **Step 4: Update manager logic for per-session provider overrides**

In `src/claude/session-manager.ts`, add:
- `providerOverrides: Map<string, AgentProvider>`
- `setProviderOverride(chatId, provider)`
- `getEffectiveProvider(chatId)`

Resolution target:

```ts
const provider =
  stale?.provider ??
  this.providerOverrides.get(key) ??
  this.opts.config.agent.defaultProvider;
```

- [ ] **Step 5: Run targeted tests to verify provider switching behavior**

Run:

```bash
pnpm test test/unit/commands/router.test.ts test/unit/commands/dispatcher.test.ts test/unit/claude/session-manager.test.ts
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/router.ts src/commands/dispatcher.ts src/util/i18n.ts src/claude/session-manager.ts test/unit/commands/router.test.ts test/unit/commands/dispatcher.test.ts test/unit/claude/session-manager.test.ts
git commit -m "feat: add provider-aware command handling"
```

---

### Task 4: Add Codex Preflight and `@openai/codex-sdk` Runtime Adapter

**Files:**
- Modify: `package.json`
- Create: `src/codex/preflight.ts`
- Create: `src/codex/sdk-run.ts`
- Modify: `src/index.ts`
- Test: `test/unit/codex/preflight.test.ts`
- Test: `test/unit/codex/sdk-run.test.ts`
- Test: `test/unit/claude/preflight.test.ts`

- [ ] **Step 1: Write failing tests for Codex preflight and runtime adapter**

Create `test/unit/codex/preflight.test.ts` with cases for:
- CLI path exists and `codex --version` returns success
- missing binary returns actionable error

Create `test/unit/codex/sdk-run.test.ts` with a fake Codex SDK wrapper that verifies:
- a thread can start
- a saved `resumeId` reuses a thread
- adapter exposes `interrupt()`

Example expectation:

```ts
expect(result.options.resumeId).toBe("thread_abc");
expect(events).toContainEqual({ type: "text", text: "done" });
```

- [ ] **Step 2: Run targeted tests to confirm Codex support is absent**

Run:

```bash
pnpm test test/unit/codex/preflight.test.ts test/unit/codex/sdk-run.test.ts
```

Expected:
- FAIL because the files and dependency do not exist

- [ ] **Step 3: Add the Codex SDK dependency and preflight implementation**

Update `package.json` by adding the Codex SDK dependency with the package manager so the lockfile and manifest stay in sync:

```bash
pnpm add @openai/codex-sdk
```

Create `src/codex/preflight.ts` modeled after the Claude preflight:

```ts
export async function checkCodexCli(
  cliPath: string,
): Promise<PreflightResult> {
  if (cliPath.startsWith("/")) {
    await access(cliPath, fsConstants.X_OK);
  }

  return new Promise<PreflightResult>((resolve) => {
    const child = spawn(cliPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: stdoutBuf.trim() || "unknown" });
        return;
      }
      resolve({
        ok: false,
        reason: `codex CLI (${cliPath}) exited with code ${code ?? "null"}: ${stderrBuf.trim()}`,
      });
    });
  });
}
```

Keep the error message Codex-specific:

```ts
reason:
  `codex CLI not found on PATH (tried "${cliPath}"). ` +
  `Install Codex CLI or set [codex].cli_path in config.toml.`
```

- [ ] **Step 4: Implement the Codex runtime adapter**

First inspect the installed SDK surface so the adapter uses the real exported thread/run API and not guessed names.

Run:

```bash
rg -n "class Codex|startThread|resumeThread|run\\(" node_modules/@openai/codex-sdk -g '*.d.ts' -g '*.ts'
```

Expected:
- at least one SDK declaration showing how to construct a client, start or resume a thread, and run a prompt

Then create `src/codex/sdk-run.ts` with a wrapper around the discovered API shape:

```ts
import { Codex } from "@openai/codex-sdk";

export function createCodexRunProvider(opts: {
  cliPath: string;
  logger: Logger;
}): RuntimeProvider {
  return {
    id: "codex",
    startRun(params) {
      const codex = new Codex();
      const thread = params.options.resumeId
        ? codex.resumeThread(params.options.resumeId)
        : codex.startThread();

      const resultPromise = thread.run(params.prompt as string);

      return {
        messages: normalizeCodexRun(resultPromise),
        interrupt: async () => {
          opts.logger.debug("codex sdk interrupt is a no-op in the current adapter");
        },
        setPermissionMode: () => {},
      };
    },
  };
}
```

If the SDK inspection in the previous step shows different exported names, update the adapter and the unit tests to match the actual SDK declarations before continuing.

Keep `setPermissionMode()` a documented no-op if the SDK does not support runtime mode switching. Log once rather than throwing.

- [ ] **Step 5: Run Codex adapter tests and inspect the actual SDK surface**

Run:

```bash
pnpm test test/unit/codex/preflight.test.ts test/unit/codex/sdk-run.test.ts
```

Expected:
- PASS, or a narrowly-scoped failure that points to a mismatched SDK method name or return shape

If the failure shows the SDK surface differs from the inspected declaration, fix `src/codex/sdk-run.ts` and the test doubles before moving on.

- [ ] **Step 6: Wire provider selection in startup**

Update `src/index.ts`:
- create both provider adapters
- run preflight for the default provider
- choose the proper provider when building the session manager

Target startup shape:

```ts
const providers = {
  claude: createSdkQueryFn({ cliPath: config.claude.cliPath, logger }),
  codex: createCodexRunProvider({ cliPath: config.codex.cliPath, logger }),
};

const defaultProvider = config.agent.defaultProvider;
const preflight =
  defaultProvider === "claude"
    ? await checkClaudeCli(config.claude.cliPath)
    : await checkCodexCli(config.codex.cliPath);
```

- [ ] **Step 7: Run targeted tests to verify the Codex provider path**

Run:

```bash
pnpm test test/unit/codex/preflight.test.ts test/unit/codex/sdk-run.test.ts test/unit/claude/preflight.test.ts
pnpm typecheck
```

Expected:
- PASS

- [ ] **Step 8: Commit**

```bash
git add package.json src/codex/preflight.ts src/codex/sdk-run.ts src/index.ts test/unit/codex/preflight.test.ts test/unit/codex/sdk-run.test.ts test/unit/claude/preflight.test.ts
git commit -m "feat: add codex sdk provider runtime"
```

---

### Task 5: Finish Integration, Regression Coverage, and Docs

**Files:**
- Modify: `src/index.ts`
- Modify: `src/commands/dispatcher.ts`
- Modify: `README.md`
- Modify: `test/unit/commands/dispatcher.test.ts`
- Modify: `test/unit/cli.test.ts`

- [ ] **Step 1: Write failing integration-facing tests for provider-aware help and config output**

Add expectations in `test/unit/commands/dispatcher.test.ts` and `test/unit/cli.test.ts` for:
- help includes `/provider <claude|codex>`
- `config show` prints the new `[agent]` section
- default provider is reflected in startup and status output

Example assertion:

```ts
expect(replyText).toContain("/provider <claude|codex>");
expect(replyText).toContain("[agent]");
expect(replyText).toContain("defaultProvider: codex");
```

- [ ] **Step 2: Run targeted tests to confirm docs/help output is outdated**

Run:

```bash
pnpm test test/unit/commands/dispatcher.test.ts test/unit/cli.test.ts
```

Expected:
- FAIL because help/config output is still Claude-only

- [ ] **Step 3: Update docs, help text, and config display**

Update `src/commands/dispatcher.ts` help/config rendering to include provider-aware text.

Update `README.md` sections:
- intro
- prerequisites
- quick start
- config sections
- commands table

README command table target:

```md
| `/provider <claude|codex>` | Switch the current session provider |
| `/model <name>` | Switch the model for the current session's provider |
```

Update prerequisite text from:

```md
- **Claude CLI** — `claude` binary in `$PATH`
```

to:

```md
- **Claude CLI** for Claude sessions
- **Codex CLI / Codex SDK prerequisites** for Codex sessions
```

- [ ] **Step 4: Run full regression verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected:
- PASS

If any command cannot be run because `@openai/codex-sdk` setup or environment assumptions differ, record that explicitly in the execution notes instead of claiming success.

- [ ] **Step 5: Commit**

```bash
git add src/commands/dispatcher.ts README.md test/unit/commands/dispatcher.test.ts test/unit/cli.test.ts
git commit -m "docs: update product messaging for claude and codex providers"
```

---

## Verification Checklist

- [ ] Old Claude-only config still loads without `[agent]`
- [ ] New config with `[agent].default_provider = "codex"` loads correctly
- [ ] Persisted v2 state with `claudeSessionId` migrates to `provider = "claude"` + `providerSessionId`
- [ ] `/provider codex` parses and switches the current chat to Codex for future turns
- [ ] `/status` shows provider and model for the active session
- [ ] `/resume <id>` restores the original provider stored with the session
- [ ] Claude startup preflight still works
- [ ] Codex startup preflight works
- [ ] Claude unit tests remain green after provider abstraction
- [ ] Codex adapter unit tests cover start, resume, and cancellation behavior
- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes

---

## Deferred Follow-up Task

This work is explicitly deferred until after Tasks 1-5 complete, to avoid overlapping edits in `src/claude/session.ts`, `src/commands/dispatcher.ts`, and related tests while the provider abstraction is still in flight.

### Follow-up: Context Growth Warnings and Staged 20MB Mitigation

**Intent:**
- detect risky context growth before the backend rejects a request for exceeding the 20MB limit
- warn the user before failure
- apply staged automatic mitigation:
  1. warn
  2. auto-compact
  3. if still risky, start a new session
  4. keep the existing post-error reset-and-retry fallback as the last line of defense

**Required design constraints:**
- use both token-window percentage and request-byte estimation
- keep `/context` useful for manual inspection
- preserve current behavior as a final fallback when preflight prediction misses
- implement as a separate spec/plan cycle after the Codex/provider work lands

**Likely touchpoints:**
- `src/claude/session.ts`
- `src/claude/render-event.ts`
- `src/commands/dispatcher.ts`
- `src/util/i18n.ts`
- `test/unit/claude/session-state-machine.test.ts`
- `test/unit/commands/dispatcher.test.ts`

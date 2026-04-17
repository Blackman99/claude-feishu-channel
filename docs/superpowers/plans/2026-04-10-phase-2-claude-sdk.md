# Phase 2: Claude Agent SDK Integration (single-turn) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 1 echo handler with a real Claude Code turn driven by `@anthropic-ai/claude-agent-sdk`. A Feishu message lands → the bridge opens a fresh `query()` → we stream assistant messages → concatenated text is sent back as a Feishu reply. This is Phase 2 of 8 from `docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md`.

**Architecture:**
- A new `src/claude/` module hosts `ClaudeSession` (per-chat wrapper with a Mutex) and `ClaudeSessionManager` (lazy `chat_id → ClaudeSession` map).
- Each `ClaudeSession.handleMessage(text)` runs an **independent** `query()` — no cross-message resume yet. Phase 4+ will add the state machine + queue, Phase 7 will persist `session_id`.
- A stateless `src/feishu/renderer.ts` extracts text blocks from an assistant message. Phase 2 renders text only; tool_use / thinking / results land in Phase 3.
- `src/claude/preflight.ts` verifies credentials are present before startup.
- `src/index.ts` replaces the echo handler with `manager.getOrCreate(chatId).handleMessage(text)` and forwards the result to `FeishuClient.sendText`. Errors during a turn become a `❌ 错误: ...` reply.
- Dependency injection: `ClaudeSession` takes a `QueryFn` interface (structural) so unit tests can pass a fake async iterator. `src/index.ts` wraps the real `query` from the SDK into that interface.

**Tech Stack:** TypeScript 5, Node LTS+, pnpm, vitest. New dependency: `@anthropic-ai/claude-agent-sdk` (v0.2.98+). Existing: `@larksuiteoapi/node-sdk`, `pino`, `zod`, `smol-toml`.

**Scope boundaries:**
- **In scope:** `[claude]` config section, credential preflight, `extractAssistantText`, `ClaudeSession` (single-turn, mutex-serialized), `ClaudeSessionManager`, index.ts wiring, README update.
- **Out of scope (future phases):** cross-message resume / persistence of `session_id` (Phase 7), streaming-input mode (needed for `interrupt()` — Phase 4), state machine + queue (Phase 4), permission cards / `canUseTool` (Phase 5), tool_use rendering (Phase 3), slash commands (Phase 6).

**Prerequisites the engineer must verify:**
- Phase 1 is already merged (current working tree: tag `v0.1.0-phase1`).
- `pnpm --version` works, Node LTS is active.
- `ANTHROPIC_API_KEY` is set in the shell used for manual E2E (Task 7).

---

## File Structure

**Created:**
- `src/claude/session.ts` — `ClaudeSession` class
- `src/claude/session-manager.ts` — `ClaudeSessionManager` class
- `src/claude/preflight.ts` — credential preflight
- `src/feishu/renderer.ts` — stateless assistant-text extractor
- `test/unit/claude/session.test.ts`
- `test/unit/claude/session-manager.test.ts`
- `test/unit/claude/preflight.test.ts`
- `test/unit/feishu/renderer.test.ts`

**Modified:**
- `src/types.ts` — add `ClaudeConfig` to `AppConfig`
- `src/config.ts` — add `ClaudeSchema` + `~` expansion on `default_cwd`
- `src/index.ts` — preflight + SessionManager + Claude-driven `onMessage`
- `config.example.toml` — add `[claude]` section
- `README.md` — update phase status and add credentials section
- `package.json` / `pnpm-lock.yaml` — new dep
- `test/unit/config.test.ts` — assertions for `[claude]`

Phase 2 does **not** unit-test `src/index.ts` directly — it is validated by the manual E2E test in Task 7.

---

## Task 1: Add `[claude]` config section

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `config.example.toml`
- Modify: `test/unit/config.test.ts`

- [ ] **Step 1a: Patch pre-existing tests that need a now-required `[claude]` section**

`MINIMAL_CONFIG` stays unchanged (no `[claude]`) — that lets us keep using it as a building block for negative tests and for the new tests that append their own `[claude]`. But three pre-existing positive-path tests currently parse `MINIMAL_CONFIG` directly or with extra sections; they must append a minimal `[claude]` block so they keep passing after the schema tightens. Make these edits in `test/unit/config.test.ts`:

1. **"loads a minimal valid config with defaults filled in"** — change the body from
   ```ts
   const path = writeConfig(MINIMAL_CONFIG);
   ```
   to
   ```ts
   const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
`);
   ```
   Then append one new assertion at the end of the test: `expect(cfg.claude.defaultCwd).toBe("/tmp/cfc-test");`

2. **"expands ~ in persistence paths"** — inside the template literal, append a `[claude]` block after the `[persistence]` block:
   ```ts
   const path = writeConfig(`
${MINIMAL_CONFIG}

[persistence]
state_file = "~/.claude-feishu-channel/state.json"
log_dir = "~/.claude-feishu-channel/logs"

[claude]
default_cwd = "/tmp/cfc-test"
`);
   ```

3. **"accepts unauthorized_behavior = 'reject'"** — this test appends `unauthorized_behavior = "reject"` below `${MINIMAL_CONFIG}`, which puts the key outside any table (invalid TOML) but the old test happened to work because `[access]` was the last section in MINIMAL_CONFIG. Rewrite the template to be explicit:
   ```ts
   const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
unauthorized_behavior = "reject"

[claude]
default_cwd = "/tmp/cfc-test"
`);
   ```
   Same rewrite for **"rejects unknown unauthorized_behavior value"** (replace `"reject"` with `"bogus"`), but since that test expects failure anyway it will keep passing either way — still worth rewriting for clarity.

After these patches, run `pnpm test test/unit/config.test.ts` to confirm the existing suite still passes with the (not-yet-written) schema. It will fail until Step 3+ land — that's expected; just check the failures are the "[claude] required" kind, not TOML-parse kind.

- [ ] **Step 1b: Write failing tests for the new `[claude]` behavior**

Append to `test/unit/config.test.ts` (keep existing tests untouched):

```ts
describe("loadConfig [claude] section", () => {
  const CLAUDE_CONFIG = `
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test-cwd"
`;

  it("loads [claude] with explicit defaults", async () => {
    const path = writeConfig(CLAUDE_CONFIG);
    const cfg = await loadConfig(path);
    expect(cfg.claude.defaultCwd).toBe("/tmp/cfc-test-cwd");
    expect(cfg.claude.defaultPermissionMode).toBe("default");
    expect(cfg.claude.defaultModel).toBe("claude-opus-4-6");
  });

  it("expands ~ in default_cwd", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "~/some-project"
`);
    const cfg = await loadConfig(path);
    expect(cfg.claude.defaultCwd).toBe(join(homedir(), "some-project"));
  });

  it("accepts custom permission_mode and model", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/x"
default_permission_mode = "acceptEdits"
default_model = "claude-sonnet-4-6"
`);
    const cfg = await loadConfig(path);
    expect(cfg.claude.defaultPermissionMode).toBe("acceptEdits");
    expect(cfg.claude.defaultModel).toBe("claude-sonnet-4-6");
  });

  it("rejects unknown permission_mode", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/x"
default_permission_mode = "bogus"
`);
    await expect(loadConfig(path)).rejects.toThrow(/default_permission_mode/);
  });

  it("requires [claude] section to be present", async () => {
    const path = writeConfig(MINIMAL_CONFIG);
    await expect(loadConfig(path)).rejects.toThrow(/claude/);
  });

  it("requires default_cwd to be non-empty", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = ""
`);
    await expect(loadConfig(path)).rejects.toThrow(/default_cwd/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/unit/config.test.ts`
Expected: `[claude]` tests FAIL (field missing on AppConfig / schema); existing tests pass.

- [ ] **Step 3: Add `ClaudeConfig` to `src/types.ts`**

Add a new field inside `AppConfig`:

```ts
export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    encryptKey: string;
    verificationToken: string;
  };
  access: {
    allowedOpenIds: readonly string[];
    unauthorizedBehavior: "ignore" | "reject";
  };
  claude: {
    defaultCwd: string;
    defaultPermissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
    defaultModel: string;
  };
  persistence: {
    stateFile: string;
    logDir: string;
  };
  logging: {
    level: "trace" | "debug" | "info" | "warn" | "error";
  };
}
```

- [ ] **Step 4: Add `ClaudeSchema` + mapping in `src/config.ts`**

Insert this schema block right after `AccessSchema`:

```ts
const ClaudeSchema = z.object({
  default_cwd: z.string().min(1),
  default_permission_mode: z
    .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
    .default("default"),
  default_model: z.string().min(1).default("claude-opus-4-6"),
});
```

Add it to the top-level schema:

```ts
const ConfigSchema = z.object({
  feishu: FeishuSchema,
  access: AccessSchema,
  claude: ClaudeSchema,
  persistence: PersistenceSchema,
  logging: LoggingSchema,
});
```

Map it inside `loadConfig`'s return object (add this block between `access` and `persistence`):

```ts
    claude: {
      defaultCwd: expandHome(data.claude.default_cwd),
      defaultPermissionMode: data.claude.default_permission_mode,
      defaultModel: data.claude.default_model,
    },
```

- [ ] **Step 5: Add `[claude]` to `config.example.toml`**

Insert this block between `[access]` and `[persistence]`:

```toml
# ─── Claude runtime ──────────────────────────────────────────────────
[claude]
# Absolute path where Claude Code sessions should run (use ~ to expand
# to your home directory). This is the cwd every new session starts in
# until /cd lands in Phase 6.
default_cwd = "~/my-projects"

# Permission mode for new sessions. Options:
#   default            — Claude asks for every tool use (recommended)
#   acceptEdits        — auto-approve file edits, ask for shell
#   plan               — plan mode, read-only
#   bypassPermissions  — auto-approve everything (dangerous)
default_permission_mode = "default"

# Model id passed to query(). Any model the Claude Code runtime accepts.
default_model = "claude-opus-4-6"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test test/unit/config.test.ts`
Expected: all tests PASS (both the new `[claude]` block and the existing ones).

Also run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts config.example.toml test/unit/config.test.ts
git commit -m "feat(config): add [claude] section with cwd, permission_mode, model"
```

---

## Task 2: Install `@anthropic-ai/claude-agent-sdk` + credential preflight

**Files:**
- Create: `src/claude/preflight.ts`
- Create: `test/unit/claude/preflight.test.ts`
- Modify: `package.json` / `pnpm-lock.yaml` (via pnpm add)

- [ ] **Step 1: Install the SDK**

Run:
```bash
pnpm add @anthropic-ai/claude-agent-sdk
```
Expected: `@anthropic-ai/claude-agent-sdk` appears in `package.json` under `dependencies`, lockfile updated.

Verify the package is importable:
```bash
node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(typeof m.query))"
```
Expected output: `function`

- [ ] **Step 2: Write failing tests for credential preflight**

Create `test/unit/claude/preflight.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkCredentials } from "../../../src/claude/preflight.js";

describe("checkCredentials", () => {
  it("accepts ANTHROPIC_API_KEY", () => {
    expect(checkCredentials({ ANTHROPIC_API_KEY: "sk-ant-xxx" })).toEqual({
      ok: true,
    });
  });

  it("accepts CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(
      checkCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok_xxx" }),
    ).toEqual({ ok: true });
  });

  it("accepts CLAUDE_CODE_USE_BEDROCK=1", () => {
    expect(checkCredentials({ CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual({
      ok: true,
    });
  });

  it("accepts CLAUDE_CODE_USE_VERTEX=1", () => {
    expect(checkCredentials({ CLAUDE_CODE_USE_VERTEX: "1" })).toEqual({
      ok: true,
    });
  });

  it("rejects when no credential source is present", () => {
    const result = checkCredentials({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/ANTHROPIC_API_KEY/);
    }
  });

  it("treats empty string env var as unset", () => {
    const result = checkCredentials({ ANTHROPIC_API_KEY: "" });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test test/unit/claude/preflight.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Create `src/claude/preflight.ts`**

```ts
export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify at least one credential source is present so the Claude Code
 * runtime bundled inside @anthropic-ai/claude-agent-sdk can authenticate.
 * The SDK ships its own cli.js, so we do not check for an external
 * `claude` binary.
 */
export function checkCredentials(
  env: Readonly<Record<string, string | undefined>>,
): PreflightResult {
  if (env["ANTHROPIC_API_KEY"]) return { ok: true };
  if (env["CLAUDE_CODE_OAUTH_TOKEN"]) return { ok: true };
  if (env["CLAUDE_CODE_USE_BEDROCK"] === "1") return { ok: true };
  if (env["CLAUDE_CODE_USE_VERTEX"] === "1") return { ok: true };
  if (env["CLAUDE_CODE_USE_FOUNDRY"] === "1") return { ok: true };
  return {
    ok: false,
    reason:
      "No Claude credentials detected. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN " +
      "(or CLAUDE_CODE_USE_BEDROCK=1 / CLAUDE_CODE_USE_VERTEX=1 / CLAUDE_CODE_USE_FOUNDRY=1).",
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test test/unit/claude/preflight.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/claude/preflight.ts test/unit/claude/preflight.test.ts
git commit -m "feat(claude): add SDK dep and credential preflight"
```

---

## Task 3: Stateless assistant-text renderer

**Files:**
- Create: `src/feishu/renderer.ts`
- Create: `test/unit/feishu/renderer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/unit/feishu/renderer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractAssistantText } from "../../../src/feishu/renderer.js";

describe("extractAssistantText", () => {
  it("returns the text of a single text block", () => {
    expect(
      extractAssistantText([{ type: "text", text: "hello" }]),
    ).toBe("hello");
  });

  it("joins multiple text blocks with \\n", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ]),
    ).toBe("line 1\nline 2");
  });

  it("ignores tool_use blocks", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "before" },
        { type: "tool_use" },
        { type: "text", text: "after" },
      ]),
    ).toBe("before\nafter");
  });

  it("ignores thinking blocks (hidden in Phase 2)", () => {
    expect(
      extractAssistantText([
        { type: "thinking", text: "secret reasoning" },
        { type: "text", text: "public answer" },
      ]),
    ).toBe("public answer");
  });

  it("returns null when there is no text content", () => {
    expect(extractAssistantText([{ type: "tool_use" }])).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractAssistantText([])).toBeNull();
  });

  it("skips text blocks with empty string", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "" },
        { type: "text", text: "real" },
      ]),
    ).toBe("real");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/unit/feishu/renderer.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create `src/feishu/renderer.ts`**

```ts
/**
 * Shallow structural type of an assistant content block. The real SDK
 * type comes from @anthropic-ai/sdk's BetaMessage.content. We only care
 * about the `text` branch in Phase 2, so this stays minimal.
 */
export interface AssistantContentBlock {
  type: string;
  text?: string;
}

/**
 * Extract user-visible text from an assistant message's content blocks.
 * Multiple text blocks are joined with newlines. Non-text blocks
 * (tool_use, thinking, image, ...) are ignored. Returns `null` if the
 * message carries no renderable text (e.g. a pure tool_use turn).
 */
export function extractAssistantText(
  content: readonly AssistantContentBlock[],
): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/unit/feishu/renderer.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/renderer.ts test/unit/feishu/renderer.test.ts
git commit -m "feat(renderer): extract assistant text blocks (Phase 2 text-only)"
```

---

## Task 4: ClaudeSession (single-turn, mutex-protected)

**Files:**
- Create: `src/claude/session.ts`
- Create: `test/unit/claude/session.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/unit/claude/session.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ClaudeSession, type QueryFn, type SDKMessageLike } from "../../../src/claude/session.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
};

function fakeQueryReturning(msgs: SDKMessageLike[]): QueryFn {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m;
    },
  });
}

describe("ClaudeSession", () => {
  it("returns concatenated assistant text on a successful turn", async () => {
    const queryFn = fakeQueryReturning([
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello from Claude" }] },
      },
      { type: "result", subtype: "success", result: "hello from Claude" },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    const reply = await session.handleMessage("hi");
    expect(reply).toBe("hello from Claude");
  });

  it("joins multiple assistant messages", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "part one" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "part two" }] },
      },
      { type: "result", subtype: "success", result: "ignored" },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    expect(await session.handleMessage("hi")).toBe("part one\npart two");
  });

  it("ignores assistant messages that have no text (tool_use only)", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "final answer" }] },
      },
      { type: "result", subtype: "success", result: "final answer" },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    expect(await session.handleMessage("hi")).toBe("final answer");
  });

  it("throws when the result is an error subtype", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom", "kaboom"],
      },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    await expect(session.handleMessage("hi")).rejects.toThrow(/boom.*kaboom/);
  });

  it("throws when the iterator ends without a result", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "oops" }] },
      },
    ]);
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    await expect(session.handleMessage("hi")).rejects.toThrow(/without a result/);
  });

  it("passes cwd, model, permissionMode, and settingSources to queryFn", async () => {
    const queryFn = vi.fn<QueryFn>(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "ok" }] },
        } satisfies SDKMessageLike;
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
        } satisfies SDKMessageLike;
      },
    }));
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: {
        defaultCwd: "/a/b",
        defaultPermissionMode: "acceptEdits",
        defaultModel: "claude-sonnet-4-6",
      },
      queryFn,
      logger: SILENT_LOGGER,
    });
    await session.handleMessage("hi");
    expect(queryFn).toHaveBeenCalledOnce();
    const call = queryFn.mock.calls[0]![0];
    expect(call.prompt).toBe("hi");
    expect(call.options.cwd).toBe("/a/b");
    expect(call.options.model).toBe("claude-sonnet-4-6");
    expect(call.options.permissionMode).toBe("acceptEdits");
    expect(call.options.settingSources).toEqual(["project"]);
  });

  it("serializes concurrent handleMessage calls via the mutex", async () => {
    const events: string[] = [];
    let release1!: () => void;
    const gate1 = new Promise<void>((r) => (release1 = r));
    let callCount = 0;
    const queryFn: QueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        callCount += 1;
        const label = callCount === 1 ? "A" : "B";
        events.push(`${label}:start`);
        if (label === "A") await gate1;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: label }] },
        } as SDKMessageLike;
        yield {
          type: "result",
          subtype: "success",
          result: label,
        } as SDKMessageLike;
        events.push(`${label}:end`);
      },
    });
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    const p1 = session.handleMessage("first");
    const p2 = session.handleMessage("second");
    // Give the event loop a chance to let p2 race past if the mutex weren't there.
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["A:start"]);
    release1();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/unit/claude/session.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create `src/claude/session.ts`**

```ts
import type { Logger } from "pino";
import { Mutex } from "../util/mutex.js";
import { extractAssistantText } from "../feishu/renderer.js";
import type { AppConfig } from "../types.js";

/**
 * Shallow structural subset of `@anthropic-ai/claude-agent-sdk`'s `SDKMessage`
 * union. Only the fields Phase 2 narrows on are declared; the SDK's real type
 * is a superset and is assignable to this interface. Phase 3+ will replace
 * this with richer typing as tool/thinking rendering lands.
 */
export interface SDKMessageLike {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: readonly { type: string; text?: string }[] };
  result?: string;
  errors?: readonly string[];
}

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  permissionMode: AppConfig["claude"]["defaultPermissionMode"];
  /** Which setting sources the SDK should load (CLAUDE.md, etc). */
  settingSources: readonly ("project" | "user" | "local")[];
}

/**
 * Structural interface of the SDK's `query` function. `src/index.ts` wraps
 * the real SDK `query` into this shape so unit tests can inject a fake.
 */
export type QueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
}) => AsyncIterable<SDKMessageLike>;

export interface ClaudeSessionOptions {
  chatId: string;
  config: AppConfig["claude"];
  queryFn: QueryFn;
  logger: Logger;
}

/**
 * Phase 2 ClaudeSession: one message in → one `query()` call → concatenated
 * assistant text out. No cross-message resume, no queue, no state machine.
 * Concurrent `handleMessage` calls for the same chat are serialized by a
 * Mutex so that a second message cannot preempt an in-flight turn.
 */
export class ClaudeSession {
  private readonly chatId: string;
  private readonly config: AppConfig["claude"];
  private readonly queryFn: QueryFn;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();

  constructor(opts: ClaudeSessionOptions) {
    this.chatId = opts.chatId;
    this.config = opts.config;
    this.queryFn = opts.queryFn;
    this.logger = opts.logger.child({ chat_id: opts.chatId });
  }

  async handleMessage(text: string): Promise<string> {
    return this.mutex.run(async () => {
      this.logger.info({ len: text.length }, "Claude turn start");
      const iter = this.queryFn({
        prompt: text,
        options: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode: this.config.defaultPermissionMode,
          settingSources: ["project"],
        },
      });

      const chunks: string[] = [];
      for await (const msg of iter) {
        if (msg.type === "assistant" && msg.message?.content) {
          const partial = extractAssistantText(msg.message.content);
          if (partial !== null) chunks.push(partial);
        } else if (msg.type === "result") {
          if (msg.subtype === "success") {
            this.logger.info(
              { chunks: chunks.length },
              "Claude turn complete",
            );
            return chunks.join("\n");
          }
          const errs = msg.errors?.join("; ") ?? "unknown error";
          this.logger.error(
            { subtype: msg.subtype, errors: msg.errors },
            "Claude turn errored",
          );
          throw new Error(`Claude turn failed (${msg.subtype}): ${errs}`);
        }
      }
      throw new Error("Claude turn ended without a result message");
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/unit/claude/session.test.ts`
Expected: 7 tests PASS.

Also run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts test/unit/claude/session.test.ts
git commit -m "feat(claude): ClaudeSession single-turn wrapper with mutex"
```

---

## Task 5: ClaudeSessionManager

**Files:**
- Create: `src/claude/session-manager.ts`
- Create: `test/unit/claude/session-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/unit/claude/session-manager.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ClaudeSessionManager } from "../../../src/claude/session-manager.js";
import type { QueryFn, SDKMessageLike } from "../../../src/claude/session.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
};

const NOOP_QUERY: QueryFn = () => ({
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessageLike, void> {
    yield { type: "result", subtype: "success", result: "" };
  },
});

describe("ClaudeSessionManager", () => {
  it("returns the same ClaudeSession instance for the same chat_id", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      logger: SILENT_LOGGER,
    });
    const a = mgr.getOrCreate("oc_1");
    const b = mgr.getOrCreate("oc_1");
    expect(a).toBe(b);
  });

  it("returns distinct ClaudeSession instances for distinct chat_ids", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      logger: SILENT_LOGGER,
    });
    const a = mgr.getOrCreate("oc_1");
    const b = mgr.getOrCreate("oc_2");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/unit/claude/session-manager.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create `src/claude/session-manager.ts`**

```ts
import type { Logger } from "pino";
import { ClaudeSession, type QueryFn } from "./session.js";
import type { AppConfig } from "../types.js";

export interface ClaudeSessionManagerOptions {
  config: AppConfig["claude"];
  queryFn: QueryFn;
  logger: Logger;
}

/**
 * Lazy `chat_id → ClaudeSession` map. Phase 2 keeps sessions in memory
 * only; there is no cleanup and no persistence. Phase 7 will wire this
 * into `StateStore` so sessions survive restarts.
 */
export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly opts: ClaudeSessionManagerOptions;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  getOrCreate(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (session === undefined) {
      session = new ClaudeSession({
        chatId,
        config: this.opts.config,
        queryFn: this.opts.queryFn,
        logger: this.opts.logger,
      });
      this.sessions.set(chatId, session);
    }
    return session;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/unit/claude/session-manager.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/claude/session-manager.ts test/unit/claude/session-manager.test.ts
git commit -m "feat(claude): lazy per-chat ClaudeSessionManager"
```

---

## Task 6: Wire ClaudeSession into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

At the top of `src/index.ts`, add these imports (merge with existing import block — do not duplicate lines):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { checkCredentials } from "./claude/preflight.js";
import { ClaudeSessionManager } from "./claude/session-manager.js";
import type { QueryFn, SDKMessageLike } from "./claude/session.js";
```

- [ ] **Step 2: Add preflight check after config load**

Right after the `logger.info({ configPath }, "Config loaded");` line, insert:

```ts
  const preflight = checkCredentials(process.env);
  if (!preflight.ok) {
    console.error(`[preflight] ${preflight.reason}`);
    process.exit(1);
  }
```

- [ ] **Step 3: Adapt the real SDK `query` into our `QueryFn`**

After the `FeishuClient` instantiation (`const feishuClient = new FeishuClient(lark);`) and BEFORE `const onMessage = ...`, insert:

```ts
  // Wrap the real SDK `query` into our structural QueryFn interface.
  // The SDK's return type (`Query extends AsyncGenerator<SDKMessage, void>`)
  // is assignable to `AsyncIterable<SDKMessageLike>` because SDKMessage is
  // a superset of our shallow SDKMessageLike.
  const queryFn: QueryFn = (params) =>
    query({
      prompt: params.prompt,
      options: {
        cwd: params.options.cwd,
        model: params.options.model,
        permissionMode: params.options.permissionMode,
        settingSources: ["project"],
      },
    }) as unknown as AsyncIterable<SDKMessageLike>;

  const sessionManager = new ClaudeSessionManager({
    config: config.claude,
    queryFn,
    logger,
  });
```

- [ ] **Step 4: Replace the echo `onMessage` body**

Replace the existing `const onMessage = async (msg: IncomingMessage): Promise<void> => { ... };` block with:

```ts
  const onMessage = async (msg: IncomingMessage): Promise<void> => {
    logger.info({ chat_id: msg.chatId, len: msg.text.length }, "Message received");
    const session = sessionManager.getOrCreate(msg.chatId);
    try {
      const reply = await session.handleMessage(msg.text);
      const text = reply.length > 0 ? reply : "(Claude returned no text)";
      await feishuClient.sendText(msg.chatId, text);
    } catch (err) {
      logger.error({ err, chat_id: msg.chatId }, "Claude turn failed");
      const errorText = err instanceof Error ? err.message : String(err);
      try {
        await feishuClient.sendText(msg.chatId, `❌ 错误: ${errorText}`);
      } catch (sendErr) {
        logger.error({ err: sendErr }, "Failed to deliver error reply");
      }
    }
  };
```

- [ ] **Step 5: Update the ready banner**

Change the final `logger.info(...)` in `main()` from:
```ts
    "claude-feishu-channel Phase 1 ready",
```
to:
```ts
    "claude-feishu-channel Phase 2 ready",
```

And add `default_cwd`, `default_model`, `permission_mode` fields to the banner's payload object so the log shows what the SessionManager will be driving:

```ts
  logger.info(
    {
      allowed_count: config.access.allowedOpenIds.length,
      unauthorized_behavior: config.access.unauthorizedBehavior,
      default_cwd: config.claude.defaultCwd,
      default_model: config.claude.defaultModel,
      permission_mode: config.claude.defaultPermissionMode,
    },
    "claude-feishu-channel Phase 2 ready",
  );
```

- [ ] **Step 6: Run typecheck and full test suite**

Run:
```bash
pnpm typecheck
pnpm test
```
Expected: typecheck passes with no errors; all unit tests pass (Phase 1 tests + the new Phase 2 tests).

**If the `queryFn` wrapper fails typecheck** because the real SDK's `Options` type has stricter/incompatible shapes: keep the `as unknown as AsyncIterable<SDKMessageLike>` cast on the return, and if the option object itself is rejected, cast the inner options object with `as any` (leave a comment: `// SDK Options is a superset; structural assignment fails here`). Do not change `src/claude/session.ts` to accommodate — keep the seam clean.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: replace echo handler with ClaudeSession (Phase 2)"
```

---

## Task 7: README update + manual E2E

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update phase status and run/test expectations**

In `README.md`:

1. Change the status line from:
   ```
   **Status: Phase 1 of 8** — currently an echo bot (no Claude integration yet).
   ```
   to:
   ```
   **Status: Phase 2 of 8** — single-turn Claude via `@anthropic-ai/claude-agent-sdk`. No queue, no tool rendering, no permission cards yet.
   ```

2. Add a new `## Credentials` section directly before `## Setup`:
   ```markdown
   ## Credentials

   The Claude Agent SDK runs Claude Code in-process and needs an auth credential. Set one of:

   - `ANTHROPIC_API_KEY` — Anthropic API key (recommended for headless use)
   - `CLAUDE_CODE_OAUTH_TOKEN` — OAuth token from `claude login`
   - `CLAUDE_CODE_USE_BEDROCK=1` (+ AWS creds) — Bedrock
   - `CLAUDE_CODE_USE_VERTEX=1` (+ GCP creds) — Vertex

   The bridge fails fast at startup if none are present.
   ```

3. Update the "expected reply" block under `## Run`:
   Replace:
   ```
   🤖 [Phase 1 echo] 收到: <your text>
   ```
   with:
   ```
   (Claude's actual response to your message)
   ```

4. Replace the banner line:
   ```
   claude-feishu-channel Phase 1 ready
   ```
   with:
   ```
   claude-feishu-channel Phase 2 ready
   ```

5. Update the `src/` layout block: insert a `claude/` directory and the new `feishu/renderer.ts`:
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
       ...
   ```

6. In the "Next phases" list, strike through or remove Phase 2 (so only Phase 3-8 remain).

- [ ] **Step 2: Manual E2E test — single-turn hello**

Run the bridge against the real Feishu bot + real Claude:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm dev
```

Expected banner:
```
{"level":30,..."msg":"claude-feishu-channel Phase 2 ready"}
```
with `default_cwd` / `default_model` / `permission_mode` in the payload.

From a whitelisted Feishu account, send the bot: `说"你好"`

Expected: within a few seconds, the bot replies with Claude's actual response (e.g., a short Chinese greeting). It must NOT be the Phase 1 echo template.

- [ ] **Step 3: Manual E2E test — a turn that exercises a tool**

Send the bot: `列出当前目录有哪些文件`

Expected: Claude answers with a file listing. This verifies `settingSources: ['project']` is loading the right cwd. Because Phase 2 has no permission cards, this works only when `default_permission_mode = "acceptEdits"` OR the tool Claude picks is auto-allowed in default mode. If the turn hangs for more than ~60s waiting on a permission prompt, record this limitation and move on — the permission bridge lands in Phase 5.

- [ ] **Step 4: Manual E2E test — error path**

Temporarily unset credentials and restart:
```bash
unset ANTHROPIC_API_KEY
pnpm dev
```
Expected: the process prints `[preflight] No Claude credentials detected...` and exits with code 1.

Reset the env var afterwards.

- [ ] **Step 5: Commit README + hand off**

```bash
git add README.md
git commit -m "docs: update README for Phase 2 (credentials + Claude-driven reply)"
```

Report E2E results to the user. Do NOT tag / push yet — the finishing step runs via `superpowers:finishing-a-development-branch` after user confirms E2E passed.

---

## Final Review (after all tasks)

After Task 7 is committed and manual E2E has been confirmed by the user:

- Dispatch a final code-reviewer subagent to review all Phase 2 commits against this plan and the design spec.
- Apply any Important/Critical fixes as follow-up commits.
- Use `superpowers:finishing-a-development-branch` to tag `v0.2.0-phase2`, push main, push the tag.

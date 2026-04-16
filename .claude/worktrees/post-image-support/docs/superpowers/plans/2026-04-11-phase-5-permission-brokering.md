# Phase 5: Permission Brokering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `NullPermissionBroker` with a real Feishu-card-driven permission broker, and switch the Claude transport from a hand-rolled CLI subprocess to `@anthropic-ai/claude-agent-sdk` so `canUseTool` becomes available.

**Architecture:** The SDK wraps the same `claude` binary we already spawn, but exposes the stream-json permission protocol as a TypeScript `canUseTool` callback. `ClaudeSession` constructs that callback per turn, hands it to the new `sdk-query.ts` adapter, and forwards each permission request to a `FeishuPermissionBroker` which posts a 4-button card, waits for the owner (triggering user) to click, and resolves the SDK with allow/deny. Turn-scoped and session-scoped "acceptEdits" buttons use `query.setPermissionMode("acceptEdits")` plus an in-memory `sessionAcceptEditsSticky` flag that biases the next turn's `permissionMode`.

**Tech Stack:**
- `@anthropic-ai/claude-agent-sdk` (NEW) — stream-json transport + canUseTool
- `@larksuiteoapi/node-sdk` — already in use; gains `card.action.trigger` subscription
- vitest, pino, zod, smol-toml — already in use
- `FakeClock` (from `src/util/clock.ts`) — drives broker timer tests

**Upstream reference:** `docs/superpowers/specs/2026-04-11-phase-5-permission-brokering-design.md`

---

## File Structure

### New files

- `src/claude/sdk-query.ts` — `createSdkQueryFn` adapter wrapping `@anthropic-ai/claude-agent-sdk`'s `query()`
- `src/claude/feishu-permission-broker.ts` — `FeishuPermissionBroker` class implementing the extended `PermissionBroker` interface
- `src/feishu/cards/permission-card.ts` — 4 variant card builders (pending / resolved / cancelled / timed out)
- `test/unit/claude/sdk-query.test.ts` — adapter tests with mocked SDK
- `test/unit/claude/feishu-permission-broker.test.ts` — broker tests
- `test/unit/feishu/cards/permission-card.test.ts` — card builder tests
- `test/unit/claude/fakes/fake-permission-broker.ts` — `FakePermissionBroker` for session tests

### Modified files

- `src/claude/query-handle.ts` — add `CanUseToolFn` type, `QueryHandle.setPermissionMode`, `QueryFn` params
- `src/claude/permission-broker.ts` — extend `PermissionRequest`, `PermissionResponse` (4 variants), add `resolveByCard` + `cancelAll` methods, drop `NullPermissionBroker`
- `src/claude/session.ts` — delete `pendingPermission` field + test seams, add `sessionAcceptEditsSticky`, extend `QueuedInput`, extend `submit()` signature, construct `canUseTool` closure in `runTurn`, switch `stop()` / `submitInterruptAndRun()` to `broker.cancelAll()`
- `src/claude/cli-query.ts` — DELETE
- `src/feishu/gateway.ts` — subscribe to `card.action.trigger` and route to new `onCardAction` handler
- `src/feishu/card-types.ts` — add `column_set`, `column`, `button` element types
- `src/types.ts` — add `claude.permissionTimeoutMs` + `claude.permissionWarnBeforeMs` fields
- `src/config.ts` — Zod schema + snake_case → camelCase mapping for the two new fields; change `default_permission_mode` default from `bypassPermissions` → `default`
- `src/index.ts` — construct `FeishuPermissionBroker`, switch to `createSdkQueryFn`, pass `senderOpenId` + `parentMessageId` into `session.submit`, register gateway `onCardAction` → `broker.resolveByCard` route, warn at startup when `permissionMode === "bypassPermissions"`
- `config.example.toml` — flip default to `default`, add `permission_timeout_seconds`, `permission_warn_before_seconds`, update comment block
- `package.json` — add `@anthropic-ai/claude-agent-sdk` dep
- `test/unit/claude/fakes/fake-query-handle.ts` — add `setPermissionMode` + `triggerCanUseTool` test methods
- `test/unit/claude/session-state-machine.test.ts` — replace `_testEnterAwaitingPermission` usages with `FakePermissionBroker`, update all `QueuedInput` construction to include new fields
- `test/unit/claude/permission-broker.test.ts` — replace `NullPermissionBroker` tests; move to `feishu-permission-broker.test.ts` and a narrower type-level test

### Deleted files

- `src/claude/cli-query.ts`
- `test/unit/claude/cli-query.test.ts`

---

## Task Breakdown

### Task 1: Add `@anthropic-ai/claude-agent-sdk` dependency and verify API surface

**Files:**
- Modify: `package.json`
- Create: `scripts/probe-sdk.ts` (throwaway)

This task is intentionally exploratory. The design assumes `query()` returns an object with `setPermissionMode(mode)` and an `AsyncIterable<SDKMessage>`, and that `canUseTool` lives under `options`. The implementer MUST verify these before writing `sdk-query.ts`. If any signature differs, note the actual shape in a comment on `sdk-query.ts` before Task 5 and update subsequent tasks' code blocks accordingly.

- [ ] **Step 1: Install the SDK**

```bash
cd /Users/zhaodongsheng/my-projects/claude-feishu-channel
pnpm add @anthropic-ai/claude-agent-sdk
```

Expected: `package.json` gains a `dependencies` entry; `pnpm-lock.yaml` updates.

- [ ] **Step 2: Read the SDK type declarations**

Open `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (or the correct entrypoint — check `package.json.types`) and locate:
1. The `query()` function signature — confirm `options.canUseTool`, `options.cwd`, `options.model`, `options.permissionMode`, `options.settingSources`, `options.pathToClaudeCodeExecutable`, `options.abortController`, `options.env` all exist.
2. The return type — confirm it has `setPermissionMode(mode)` (record exact method name) and is itself `AsyncIterable<SDKMessage>`.
3. The `SDKMessage` shape — confirm `type`, `subtype`, `message.content`, `result`, `errors`, `duration_ms`, `usage` fields exist so our `SDKMessageLike` in `session.ts` remains a valid structural subset.
4. The `canUseTool` callback signature — confirm it's `(toolName, input, opts) => Promise<PermissionResult>` and record the exact `opts` field names (`signal`, `toolUseID`, or variants).

- [ ] **Step 3: Write a throwaway probe script**

Create `scripts/probe-sdk.ts` that imports `query` and `canUseTool`, constructs a minimal options bag, and logs the returned object's methods. Do NOT run it against a real backend — just confirm it type-checks.

```typescript
// scripts/probe-sdk.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// Type-only verification — don't actually call this.
function _typeCheck(): void {
  const q = query({
    prompt: "hello",
    options: {
      cwd: "/tmp",
      model: "claude-opus-4-6",
      permissionMode: "default",
      settingSources: ["project"],
      canUseTool: async (toolName, input, opts) => {
        void toolName;
        void input;
        void opts;
        return { behavior: "allow", updatedInput: input };
      },
      pathToClaudeCodeExecutable: "claude",
      abortController: new AbortController(),
      env: { ...process.env },
    },
  });
  // Confirm the methods exist on the return value.
  q.setPermissionMode("acceptEdits");
  void (async () => {
    for await (const msg of q) {
      void msg;
    }
  })();
}
void _typeCheck;
```

Run `pnpm typecheck`. Expected: passes. If it fails, the plan is wrong about the SDK shape — STOP and report the actual signatures before continuing.

- [ ] **Step 4: Delete the probe script**

```bash
rm scripts/probe-sdk.ts
```

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @anthropic-ai/claude-agent-sdk dependency"
```

---

### Task 2: Extend `QueryFn` / `QueryHandle` with `CanUseToolFn` and `setPermissionMode`

**Files:**
- Modify: `src/claude/query-handle.ts`
- Modify: `src/claude/cli-query.ts` (add no-op `setPermissionMode`, ignore `canUseTool` for now)
- Modify: `test/unit/claude/fakes/fake-query-handle.ts` (add stubs so tests still compile)

The SDK adapter in Task 5 will consume `params.canUseTool`. Add the type and method surface now, leave the old CLI adapter as a noop satisfier so everything still compiles and green.

- [ ] **Step 1: Read current query-handle.ts to confirm the baseline**

Open `src/claude/query-handle.ts` and keep the current content visible — the edit below replaces the whole file.

- [ ] **Step 2: Rewrite `src/claude/query-handle.ts`**

```typescript
import type { AppConfig } from "../types.js";
import type { SDKMessageLike } from "./session.js";

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  permissionMode: AppConfig["claude"]["defaultPermissionMode"];
  settingSources: readonly ("project" | "user" | "local")[];
}

/**
 * Per-turn permission callback the session hands to the transport. The
 * SDK invokes this on every `tool_use` event that Claude emits while
 * the turn is running. Contract: MUST NOT reject under normal
 * operation — timeouts, cancellations, and user denials all return
 * `{behavior: "deny", message}`. Rejections are treated as programming
 * bugs and will abort the turn.
 *
 * Return type is intentionally narrower than the broker's internal
 * `PermissionResponse`: the SDK only understands `allow` / `deny`, so
 * the session's closure translates broker-level `allow_turn` /
 * `allow_session` responses into `{allow}` plus side effects
 * (`handle.setPermissionMode` and/or sticky flag) before returning.
 */
export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseID: string },
) => Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

/**
 * Handle exposed by a `QueryFn` for one turn. Consumers iterate
 * `.messages` to receive the stream-json events and can call
 * `.interrupt()` at any point to terminate the turn early (used by
 * `ClaudeSession` for `/stop` and `!` prefix).
 *
 * `interrupt()` MUST be idempotent — the state machine may call it
 * during the narrow window between a result message arriving and the
 * iterator ending naturally, and we don't want the second call to
 * throw or spawn a second signal.
 *
 * `interrupt()` resolves only after the turn has fully settled (child
 * exited / iterator ended), so the state machine can safely assume
 * that once the returned Promise resolves, no more messages will be
 * emitted for this turn.
 *
 * `setPermissionMode()` mirrors the SDK's `query.setPermissionMode`
 * and changes the default permission policy for the REMAINING tool
 * calls in this turn. Used to implement the "本轮 acceptEdits" button:
 * the session flips the mode mid-turn so subsequent Edit/Write tool
 * uses are auto-allowed without re-prompting. Idempotent; calling
 * with the current mode is a no-op.
 */
export interface QueryHandle {
  readonly messages: AsyncIterable<SDKMessageLike>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: ClaudeQueryOptions["permissionMode"]): void;
}

/**
 * Structural signature of the function that creates a per-turn
 * `QueryHandle`. The `canUseTool` callback is a parameter (not a
 * method on the handle) because the session constructs a fresh
 * closure per turn that captures the owning message's `senderOpenId`
 * / `parentMessageId`, and hands it in when it opens the turn.
 */
export type QueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
  canUseTool: CanUseToolFn;
}) => QueryHandle;
```

- [ ] **Step 3: Add no-op `setPermissionMode` + ignore `canUseTool` in `cli-query.ts`**

The CLI adapter is going to be deleted in Task 17, but must continue to compile until then. Add a `setPermissionMode: () => {}` to the returned handle, and accept (then ignore) the new `canUseTool` param. Edit `src/claude/cli-query.ts`:

Find the `createCliQueryFn` function. Inside the returned arrow, before constructing `args`, touch the new param so TypeScript doesn't complain:

```typescript
export function createCliQueryFn(opts: CliQueryFnOptions): QueryFn {
  const spawn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  return (params) => {
    // Phase 5 transition: the CLI transport does not support the
    // permission callback. Ignore it — the session won't exercise
    // this path once index.ts switches to createSdkQueryFn.
    void params.canUseTool;
    const args = buildArgs(params.options, params.prompt);
    // ... rest unchanged ...
```

And at the `const handle: QueryHandle = { messages, interrupt };` line, add the no-op:

```typescript
    const handle: QueryHandle = {
      messages,
      interrupt,
      setPermissionMode: () => {
        // CLI transport cannot change mode mid-turn; no-op.
      },
    };
    return handle;
```

- [ ] **Step 4: Add no-op `setPermissionMode` to `FakeQueryHandle`**

Edit `test/unit/claude/fakes/fake-query-handle.ts`. Near the top of the class (after `messagesConsumed = 0;`), add:

```typescript
  /** Recorded permissionMode changes from the session under test. */
  readonly permissionModeChanges: string[] = [];

  setPermissionMode(mode: string): void {
    this.permissionModeChanges.push(mode);
  }
```

- [ ] **Step 5: Run typecheck + tests**

```bash
pnpm typecheck && pnpm test
```

Expected: typecheck passes, all existing tests pass (Task 2 doesn't change behavior).

- [ ] **Step 6: Commit**

```bash
git add src/claude/query-handle.ts src/claude/cli-query.ts test/unit/claude/fakes/fake-query-handle.ts
git commit -m "feat(claude): extend QueryFn/QueryHandle with canUseTool + setPermissionMode"
```

---

### Task 3: Extend `PermissionBroker` interface with 4 variants + `resolveByCard` + `cancelAll`

**Files:**
- Modify: `src/claude/permission-broker.ts`
- Modify: `test/unit/claude/permission-broker.test.ts` (rewrite the `NullPermissionBroker` test)

Extend the interface now so session + broker implementations can be written against a stable contract. Keep `NullPermissionBroker` as a throwing stub for the new methods so `src/index.ts` still compiles until Task 15 swaps it for the real one.

- [ ] **Step 1: Rewrite `src/claude/permission-broker.ts`**

```typescript
/**
 * A pending permission check — the session constructs one of these in
 * its `canUseTool` closure and hands it to `broker.request`.
 */
export interface PermissionRequest {
  /** Name of the tool Claude wants to call, e.g. "Bash", "Edit". */
  toolName: string;
  /** Raw tool input (the session does NOT validate the shape). */
  input: unknown;
  /** Feishu chat that owns this request (for card routing). */
  chatId: string;
  /**
   * Open id of the user who sent the message that kicked off this
   * turn. Only this user may click the permission buttons — everyone
   * else in the group gets a `forbidden` response.
   */
  ownerOpenId: string;
  /**
   * Feishu `message_id` of the user message that kicked off this
   * turn. The broker posts the permission card as a reply to it so
   * the card threads under the exact request that caused it.
   */
  parentMessageId: string;
}

/**
 * Broker-internal response. The session's `canUseTool` closure
 * receives this and translates the last two variants to `{allow}` +
 * side effects before returning to the SDK (which only understands
 * `allow`/`deny`).
 */
export type PermissionResponse =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }
  | { behavior: "allow_turn" }
  | { behavior: "allow_session" };

/** Choice value encoded on each permission card button. */
export type CardChoice = "allow" | "deny" | "allow_turn" | "allow_session";

/** Result of routing a `card.action.trigger` event to the broker. */
export type CardActionResult =
  | { kind: "resolved" }
  | { kind: "not_found" }
  | { kind: "forbidden"; ownerOpenId: string };

/**
 * Bridges between the SDK's `canUseTool` callback and the Feishu
 * permission card UX. Phase 5 ships `FeishuPermissionBroker` as the
 * real implementation; tests use `FakePermissionBroker`.
 */
export interface PermissionBroker {
  /**
   * Request permission for a tool call. Resolves with the user's
   * decision. The returned promise MUST NOT reject under normal
   * operation — timeouts resolve with `deny`, cancellations resolve
   * with `deny`. Only programming bugs should reject.
   */
  request(req: PermissionRequest): Promise<PermissionResponse>;

  /**
   * Handle a card button click. Called by the gateway after
   * access-control passes on the `card.action.trigger` event.
   * Returns a result the gateway uses to decide whether to log or
   * surface anything back to the user.
   */
  resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult>;

  /**
   * Bulk-deny all pending requests with the given reason. Called by
   * `session.stop()` / `!` prefix so interrupting the turn also
   * unblocks any outstanding `canUseTool` calls. The reason becomes
   * the deny `message` that Claude sees as the tool_result.
   */
  cancelAll(reason: string): void;
}
```

Note: `NullPermissionBroker` is now deleted. `src/index.ts` will break to compile — we fix it in Task 15. To keep the repo compilable in between, we introduce a tiny stub class next.

Append to the same file:

```typescript
/**
 * Transitional stub used only by `src/index.ts` until Task 15 wires
 * the real `FeishuPermissionBroker`. Throws on every method so an
 * accidental call during this window is loud. Delete once the real
 * broker is wired.
 */
export class TransitionalStubBroker implements PermissionBroker {
  async request(_req: PermissionRequest): Promise<PermissionResponse> {
    throw new Error(
      "TransitionalStubBroker.request called — real broker not wired yet (Task 15)",
    );
  }
  async resolveByCard(): Promise<CardActionResult> {
    throw new Error(
      "TransitionalStubBroker.resolveByCard called — real broker not wired yet (Task 15)",
    );
  }
  cancelAll(): void {
    // no-op during transition — stop/!\ still works because pendingPermission field is gone.
  }
}
```

- [ ] **Step 2: Update `src/index.ts` to use the new stub name**

In `src/index.ts`, replace the import and construction:

```typescript
// BEFORE
import { NullPermissionBroker } from "./claude/permission-broker.js";
// ...
permissionBroker: new NullPermissionBroker(),

// AFTER
import { TransitionalStubBroker } from "./claude/permission-broker.js";
// ...
permissionBroker: new TransitionalStubBroker(),
```

- [ ] **Step 3: Update state-machine test to use the new stub**

In `test/unit/claude/session-state-machine.test.ts`, replace `NullPermissionBroker` with `TransitionalStubBroker` everywhere (2 sites — the `BASE_CLAUDE_CONFIG` helper and the standalone harness). Import is at the top of the file. We'll rip this out entirely in Task 12 when `FakePermissionBroker` takes over.

- [ ] **Step 4: Rewrite `test/unit/claude/permission-broker.test.ts` as a narrow type-level test**

Replace the entire file with:

```typescript
import { describe, it, expect } from "vitest";
import {
  TransitionalStubBroker,
  type PermissionRequest,
} from "../../../src/claude/permission-broker.js";

describe("TransitionalStubBroker", () => {
  const req: PermissionRequest = {
    toolName: "Bash",
    input: { command: "ls" },
    chatId: "oc_x",
    ownerOpenId: "ou_x",
    parentMessageId: "om_x",
  };

  it("throws on request()", async () => {
    await expect(new TransitionalStubBroker().request(req)).rejects.toThrow(
      /not wired yet/i,
    );
  });

  it("throws on resolveByCard()", async () => {
    await expect(
      new TransitionalStubBroker().resolveByCard({
        requestId: "r1",
        senderOpenId: "ou_x",
        choice: "allow",
      }),
    ).rejects.toThrow(/not wired yet/i);
  });

  it("cancelAll is a silent no-op", () => {
    expect(() => new TransitionalStubBroker().cancelAll("test")).not.toThrow();
  });
});
```

- [ ] **Step 5: Run typecheck + tests**

```bash
pnpm typecheck && pnpm test
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/claude/permission-broker.ts src/index.ts test/unit/claude/permission-broker.test.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): extend PermissionBroker interface for 4-variant responses"
```

---

### Task 4: Extend config types and schema for permission timeouts

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `test/unit/config.test.ts` (add cases for the new fields)

- [ ] **Step 1: Write the failing tests first**

Open `test/unit/config.test.ts` and add a `describe` block for the new fields. Check what the existing file uses for fixtures and follow the same pattern. Add tests like:

```typescript
describe("permission timeout config", () => {
  it("defaults permission_timeout_seconds to 300 and permission_warn_before_seconds to 60", async () => {
    // Use the same minimal-config fixture helper the file already has.
    // Adjust the fixture loader to match existing test style.
    const cfg = await loadMinimalConfig(/* no permission fields */);
    expect(cfg.claude.permissionTimeoutMs).toBe(300_000);
    expect(cfg.claude.permissionWarnBeforeMs).toBe(60_000);
  });

  it("accepts custom permission_timeout_seconds and multiplies to ms", async () => {
    const cfg = await loadMinimalConfig({
      claude: { permission_timeout_seconds: 120 },
    });
    expect(cfg.claude.permissionTimeoutMs).toBe(120_000);
  });

  it("rejects permission_timeout_seconds <= 0", async () => {
    await expect(
      loadMinimalConfig({ claude: { permission_timeout_seconds: 0 } }),
    ).rejects.toThrow(/permission_timeout_seconds/);
  });
});
```

If `loadMinimalConfig` doesn't exist under that name, use whatever helper the file already uses for config fixtures. Read the existing file first.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test test/unit/config.test.ts
```

Expected: 3 failures citing missing fields / wrong values.

- [ ] **Step 3: Update `src/types.ts`**

Find the `claude` block in `AppConfig` and add two fields:

```typescript
  claude: {
    defaultCwd: string;
    defaultPermissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
    defaultModel: string;
    /** Path to the `claude` CLI binary. Usually `"claude"` (resolved via $PATH). */
    cliPath: string;
    /** Max time the broker waits for a user decision before auto-denying. */
    permissionTimeoutMs: number;
    /** How far BEFORE the timeout to post the "⏰ 60s" warning reminder. */
    permissionWarnBeforeMs: number;
  };
```

- [ ] **Step 4: Update `src/config.ts` Zod schema**

In the `ClaudeSchema` definition, add the two snake_case fields with defaults:

```typescript
const ClaudeSchema = z.object({
  default_cwd: z.string().min(1),
  default_permission_mode: z
    .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
    .default("default"),
  default_model: z.string().min(1).default("claude-opus-4-6"),
  cli_path: z.string().min(1).default("claude"),
  permission_timeout_seconds: z.number().int().positive().default(300),
  permission_warn_before_seconds: z.number().int().positive().default(60),
});
```

And in the `loadConfig` mapping, convert seconds → ms:

```typescript
    claude: {
      defaultCwd: expandHome(data.claude.default_cwd),
      defaultPermissionMode: data.claude.default_permission_mode,
      defaultModel: data.claude.default_model,
      cliPath: data.claude.cli_path,
      permissionTimeoutMs: data.claude.permission_timeout_seconds * 1000,
      permissionWarnBeforeMs: data.claude.permission_warn_before_seconds * 1000,
    },
```

- [ ] **Step 5: Re-run the config tests to verify green**

```bash
pnpm test test/unit/config.test.ts
```

Expected: the 3 new tests pass; all existing cases still pass.

- [ ] **Step 6: Update any fixture in `session-state-machine.test.ts` that now fails to compile**

The `BASE_CLAUDE_CONFIG` constant at `test/unit/claude/session-state-machine.test.ts:19` is currently:

```typescript
const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
};
```

Add the two new fields so the type still matches `AppConfig["claude"]`:

```typescript
const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
  permissionTimeoutMs: 300_000,
  permissionWarnBeforeMs: 60_000,
};
```

Grep for any other test file that constructs `AppConfig["claude"]` inline and update identically:

```bash
grep -rn "defaultCwd.*defaultPermissionMode" test/ src/
```

Fix each hit.

- [ ] **Step 7: Run full typecheck + tests**

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/config.ts test/unit/config.test.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(config): add permission_timeout_seconds and permission_warn_before_seconds"
```

---

### Task 5: Create `src/claude/sdk-query.ts` adapter

**Files:**
- Create: `src/claude/sdk-query.ts`
- Create: `test/unit/claude/sdk-query.test.ts`

Implement the SDK adapter that replaces `createCliQueryFn`. The interface shape was verified in Task 1 — use whatever the `.d.ts` declared for `query()`'s return type and method names. The code below assumes the design's assumed shape (`q.setPermissionMode`, `q` is itself an `AsyncIterable<SDKMessage>`); adjust if Task 1 found differently.

- [ ] **Step 1: Write the failing test**

Create `test/unit/claude/sdk-query.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSdkQueryFn } from "../../../src/claude/sdk-query.js";
import { createLogger } from "../../../src/util/logger.js";
import type { CanUseToolFn } from "../../../src/claude/query-handle.js";

const SILENT = createLogger({ level: "error", pretty: false });

// Mock the SDK module. The factory must return a `query` export that
// tests can inspect and drive.
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const setPermissionMode = vi.fn<(mode: string) => void>();
  const abortMocks: AbortController[] = [];
  const sessions: Array<{
    prompt: string;
    options: Record<string, unknown>;
    setPermissionMode: typeof setPermissionMode;
    pending: Array<{ msg: unknown } | { end: true }>;
    resolveNext?: (v: IteratorResult<unknown>) => void;
  }> = [];

  const query = vi.fn((params: { prompt: string; options: Record<string, unknown> }) => {
    const session = {
      prompt: params.prompt,
      options: params.options,
      setPermissionMode,
      pending: [] as Array<{ msg: unknown } | { end: true }>,
      resolveNext: undefined as ((v: IteratorResult<unknown>) => void) | undefined,
    };
    sessions.push(session);
    if (params.options.abortController instanceof AbortController) {
      abortMocks.push(params.options.abortController);
    }

    const iterator: AsyncIterator<unknown> = {
      next: async () => {
        const head = session.pending.shift();
        if (head) {
          if ("end" in head) return { value: undefined, done: true };
          return { value: head.msg, done: false };
        }
        return new Promise<IteratorResult<unknown>>((resolve) => {
          session.resolveNext = resolve;
        });
      },
    };

    const q: AsyncIterable<unknown> & {
      setPermissionMode: (m: string) => void;
    } = {
      [Symbol.asyncIterator]: () => iterator,
      setPermissionMode,
    };
    return q;
  });

  return {
    query,
    __testAccess: { sessions, abortMocks, setPermissionMode },
  };
});

import {
  __testAccess,
  query as mockedQuery,
} from "@anthropic-ai/claude-agent-sdk" as unknown as {
  query: unknown;
  __testAccess: {
    sessions: Array<{
      prompt: string;
      options: Record<string, unknown>;
      setPermissionMode: ReturnType<typeof vi.fn>;
      pending: Array<{ msg: unknown } | { end: true }>;
      resolveNext?: (v: IteratorResult<unknown>) => void;
    }>;
    abortMocks: AbortController[];
    setPermissionMode: ReturnType<typeof vi.fn>;
  };
};

const noopCanUseTool: CanUseToolFn = async () => ({ behavior: "allow" });

beforeEach(() => {
  __testAccess.sessions.length = 0;
  __testAccess.abortMocks.length = 0;
  __testAccess.setPermissionMode.mockClear();
  (mockedQuery as ReturnType<typeof vi.fn>).mockClear();
});

describe("createSdkQueryFn", () => {
  it("passes prompt, options, canUseTool, and pathToClaudeCodeExecutable through to query()", () => {
    const fn = createSdkQueryFn({ cliPath: "/usr/bin/claude", logger: SILENT });
    fn({
      prompt: "hello",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });
    expect(__testAccess.sessions).toHaveLength(1);
    const s = __testAccess.sessions[0]!;
    expect(s.prompt).toBe("hello");
    expect(s.options.cwd).toBe("/tmp");
    expect(s.options.model).toBe("claude-opus-4-6");
    expect(s.options.permissionMode).toBe("default");
    expect(s.options.settingSources).toEqual(["project"]);
    expect(s.options.canUseTool).toBe(noopCanUseTool);
    expect(s.options.pathToClaudeCodeExecutable).toBe("/usr/bin/claude");
    expect(s.options.abortController).toBeInstanceOf(AbortController);
  });

  it("yields messages from the SDK iterator", async () => {
    const fn = createSdkQueryFn({ cliPath: "claude", logger: SILENT });
    const handle = fn({
      prompt: "hi",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });
    const s = __testAccess.sessions[0]!;
    s.pending.push({ msg: { type: "assistant" } });
    s.pending.push({ msg: { type: "result", subtype: "success" } });
    s.pending.push({ end: true });

    const got: unknown[] = [];
    for await (const msg of handle.messages) got.push(msg);
    expect(got).toEqual([
      { type: "assistant" },
      { type: "result", subtype: "success" },
    ]);
  });

  it("interrupt() aborts the underlying controller and is idempotent", async () => {
    const fn = createSdkQueryFn({ cliPath: "claude", logger: SILENT });
    const handle = fn({
      prompt: "hi",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });
    await handle.interrupt();
    await handle.interrupt();
    expect(__testAccess.abortMocks[0]!.signal.aborted).toBe(true);
  });

  it("setPermissionMode forwards to the SDK query object", () => {
    const fn = createSdkQueryFn({ cliPath: "claude", logger: SILENT });
    const handle = fn({
      prompt: "hi",
      options: {
        cwd: "/tmp",
        model: "claude-opus-4-6",
        permissionMode: "default",
        settingSources: ["project"],
      },
      canUseTool: noopCanUseTool,
    });
    handle.setPermissionMode("acceptEdits");
    expect(__testAccess.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test test/unit/claude/sdk-query.test.ts
```

Expected: fails with "cannot find module '../../../src/claude/sdk-query.js'".

- [ ] **Step 3: Create `src/claude/sdk-query.ts`**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import type { SDKMessageLike } from "./session.js";
import type { QueryFn, QueryHandle } from "./query-handle.js";

export interface SdkQueryFnOptions {
  /** Path to the `claude` CLI binary the SDK should spawn. */
  cliPath: string;
  logger: Logger;
}

/**
 * Build a `QueryFn` that drives turns through `@anthropic-ai/claude-agent-sdk`'s
 * `query()`. Replaces the hand-rolled CLI subprocess adapter in
 * `cli-query.ts` — the SDK still spawns the `claude` binary under the
 * hood (via `pathToClaudeCodeExecutable`), but manages the stream-json
 * protocol and exposes `canUseTool` as a TypeScript callback, which is
 * what Phase 5's permission broker needs.
 *
 * Environment variable inheritance (including `ANTHROPIC_BASE_URL` /
 * `ANTHROPIC_AUTH_TOKEN` for self-hosted endpoints) happens by passing
 * `env: { ...process.env }` into the options — the SDK forwards it to
 * the spawned child.
 *
 * The returned `QueryHandle.interrupt()` aborts the SDK's
 * `AbortController` and is idempotent.
 *
 * `setPermissionMode()` forwards to `q.setPermissionMode()` which the
 * SDK exposes for mid-turn permission mode changes (used for the
 * "本轮 acceptEdits" button).
 */
export function createSdkQueryFn(opts: SdkQueryFnOptions): QueryFn {
  return (params) => {
    const abort = new AbortController();
    let aborted = false;

    const q = query({
      prompt: params.prompt,
      options: {
        cwd: params.options.cwd,
        model: params.options.model,
        permissionMode: params.options.permissionMode,
        settingSources: params.options.settingSources,
        canUseTool: params.canUseTool,
        pathToClaudeCodeExecutable: opts.cliPath,
        abortController: abort,
        env: { ...process.env },
      },
    });

    const messages: AsyncIterable<SDKMessageLike> = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const msg of q as AsyncIterable<SDKMessageLike>) {
            yield msg;
          }
        } catch (err) {
          if (aborted) {
            opts.logger.debug(
              { err },
              "sdk-query iterator threw after abort — expected",
            );
            return;
          }
          throw err;
        }
      },
    };

    const interrupt = async (): Promise<void> => {
      if (aborted) return;
      aborted = true;
      abort.abort();
      // The SDK's for-await loop will observe the abort on its next
      // pull and throw; the generator wrapper above swallows that
      // expected throw. No separate drain handle is needed.
    };

    const setPermissionMode = (
      mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
    ): void => {
      try {
        (q as { setPermissionMode?: (m: string) => void }).setPermissionMode?.(
          mode,
        );
      } catch (err) {
        opts.logger.warn({ err, mode }, "sdk-query setPermissionMode threw");
      }
    };

    const handle: QueryHandle = {
      messages,
      interrupt,
      setPermissionMode,
    };
    return handle;
  };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test test/unit/claude/sdk-query.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Run the full suite**

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/claude/sdk-query.ts test/unit/claude/sdk-query.test.ts
git commit -m "feat(claude): add sdk-query.ts adapter for @anthropic-ai/claude-agent-sdk"
```

---

### Task 6: Extend `card-types.ts` with `column_set`, `column`, and `button` element types

**Files:**
- Modify: `src/feishu/card-types.ts`

The permission card needs buttons, and Feishu's layout for button rows uses `column_set`. The current `card-types.ts` doesn't declare these — add them as a superset of `FeishuElement`.

- [ ] **Step 1: Read current `card-types.ts` to confirm the union**

Already have it — the `FeishuElement` union is `FeishuMarkdownElement | FeishuDividerElement | FeishuCollapsiblePanelElement`.

- [ ] **Step 2: Add `FeishuColumnSetElement` + `FeishuColumnElement` + `FeishuButtonElement` to the union**

Append to `src/feishu/card-types.ts`:

```typescript
/**
 * A clickable button. Click events are delivered via Feishu's
 * `card.action.trigger` event, with the `value` object echoed back in
 * the event payload. Phase 5 uses this for the permission card.
 *
 * - `tag`: always `"button"`
 * - `text.content`: visible label (supports emoji)
 * - `type`: button style — `"primary"`, `"danger"`, `"default"`
 * - `value`: arbitrary JSON sent back on click. MUST be a plain
 *   object, not an array or primitive — Feishu reserializes it.
 */
export interface FeishuButtonElement {
  tag: "button";
  text: { tag: "plain_text"; content: string };
  type?: "primary" | "danger" | "default" | "primary_filled" | "default_filled";
  value?: Record<string, unknown>;
  /** Optional width constraint — "default" | "fill". */
  width?: "default" | "fill";
}

/**
 * A single column inside a `column_set`. Holds a small list of
 * elements rendered vertically within the column's width.
 */
export interface FeishuColumnElement {
  tag: "column";
  width?: "weighted" | "auto" | string;
  weight?: number;
  vertical_align?: "top" | "center" | "bottom";
  elements: FeishuElement[];
}

/**
 * A row of columns — Phase 5's permission card uses two
 * `column_set` rows of 2 columns each to lay out the 4 buttons in a
 * compact 2×2 grid.
 */
export interface FeishuColumnSetElement {
  tag: "column_set";
  horizontal_spacing?: string;
  flex_mode?: "none" | "stretch" | "flow" | "bisect" | "trisect";
  columns: FeishuColumnElement[];
}
```

Then extend the `FeishuElement` union:

```typescript
export type FeishuElement =
  | FeishuMarkdownElement
  | FeishuDividerElement
  | FeishuCollapsiblePanelElement
  | FeishuButtonElement
  | FeishuColumnSetElement
  | FeishuColumnElement;
```

Note: `FeishuColumnElement` appears in the union so it can be used at the top level too; in practice it's always nested under `column_set.columns`, but the type is flat for convenience.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/feishu/card-types.ts
git commit -m "feat(feishu): add button and column_set element types"
```

---

### Task 7: Create `src/feishu/cards/permission-card.ts` and its tests

**Files:**
- Create: `src/feishu/cards/permission-card.ts`
- Create: `test/unit/feishu/cards/permission-card.test.ts`

Four builders: `buildPermissionCard` (pending, with 4 buttons), `buildPermissionCardResolved`, `buildPermissionCardCancelled`, `buildPermissionCardTimedOut`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/feishu/cards/permission-card.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildPermissionCard,
  buildPermissionCardResolved,
  buildPermissionCardCancelled,
  buildPermissionCardTimedOut,
} from "../../../../src/feishu/cards/permission-card.js";

describe("buildPermissionCard (pending)", () => {
  it("renders header with toolName and 4 buttons each tagged with the request_id", () => {
    const card = buildPermissionCard({
      requestId: "req_abc",
      toolName: "Bash",
      input: { command: "ls -la" },
      ownerOpenId: "ou_owner",
    });
    expect(card.schema).toBe("2.0");
    expect(card.config?.update_multi).toBe(true);
    expect(card.header?.title.content).toContain("Bash");

    // Flatten all button value objects.
    const buttons: Array<{ choice?: unknown; request_id?: unknown; kind?: unknown }> = [];
    function walk(el: unknown): void {
      if (!el || typeof el !== "object") return;
      const e = el as { tag?: string; value?: Record<string, unknown>; elements?: unknown[]; columns?: unknown[] };
      if (e.tag === "button" && e.value) buttons.push(e.value as typeof buttons[number]);
      if (Array.isArray(e.elements)) e.elements.forEach(walk);
      if (Array.isArray(e.columns)) e.columns.forEach(walk);
    }
    card.body?.elements.forEach(walk);
    expect(buttons).toHaveLength(4);
    const choices = buttons.map((b) => b.choice);
    expect(choices).toEqual(
      expect.arrayContaining(["allow", "deny", "allow_turn", "allow_session"]),
    );
    for (const b of buttons) {
      expect(b.kind).toBe("permission");
      expect(b.request_id).toBe("req_abc");
    }
  });

  it("shows a code-block preview of the tool input, truncated to ~2KB", () => {
    const huge = "x".repeat(10_000);
    const card = buildPermissionCard({
      requestId: "r",
      toolName: "Edit",
      input: { content: huge },
      ownerOpenId: "ou",
    });
    const serialized = JSON.stringify(card);
    // Card must not blow past a reasonable size.
    expect(serialized.length).toBeLessThan(6_000);
  });

  it("includes an owner-only disclaimer in the body", () => {
    const card = buildPermissionCard({
      requestId: "r",
      toolName: "Bash",
      input: {},
      ownerOpenId: "ou",
    });
    const text = JSON.stringify(card);
    expect(text).toMatch(/发起者|owner|only/i);
  });
});

describe("buildPermissionCardResolved", () => {
  it("renders a one-line confirmation without buttons", () => {
    const card = buildPermissionCardResolved({
      toolName: "Bash",
      choice: "allow",
      resolverOpenId: "ou_x",
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(json).toMatch(/允许|allow/);
  });

  it("labels the deny variant correctly", () => {
    const card = buildPermissionCardResolved({
      toolName: "Bash",
      choice: "deny",
      resolverOpenId: "ou_x",
    });
    expect(JSON.stringify(card)).toMatch(/拒绝|denied/);
  });

  it("labels the allow_turn variant with the acceptEdits text", () => {
    const card = buildPermissionCardResolved({
      toolName: "Bash",
      choice: "allow_turn",
      resolverOpenId: "ou_x",
    });
    expect(JSON.stringify(card)).toMatch(/本轮.*acceptEdits/);
  });

  it("labels the allow_session variant", () => {
    const card = buildPermissionCardResolved({
      toolName: "Bash",
      choice: "allow_session",
      resolverOpenId: "ou_x",
    });
    expect(JSON.stringify(card)).toMatch(/会话.*acceptEdits/);
  });
});

describe("buildPermissionCardCancelled", () => {
  it("renders a cancelled notice without buttons", () => {
    const card = buildPermissionCardCancelled({
      toolName: "Bash",
      reason: "User issued /stop",
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(json).toMatch(/取消|cancel/i);
    expect(json).toContain("/stop");
  });
});

describe("buildPermissionCardTimedOut", () => {
  it("renders a timed-out notice without buttons", () => {
    const card = buildPermissionCardTimedOut({ toolName: "Bash" });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(json).toMatch(/超时|timed out/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test test/unit/feishu/cards/permission-card.test.ts
```

Expected: fails because the builder file doesn't exist.

- [ ] **Step 3: Create `src/feishu/cards/permission-card.ts`**

```typescript
import type {
  FeishuCardV2,
  FeishuElement,
} from "../card-types.js";
import { truncateForInline } from "../truncate.js";

/** Upper bound for the code-block preview of a tool's input. */
const INPUT_PREVIEW_MAX_BYTES = 1_500;

interface BuildPendingArgs {
  requestId: string;
  toolName: string;
  input: unknown;
  ownerOpenId: string;
}

/**
 * Build the pending-state permission card with 4 buttons. The
 * buttons' `value` field carries `{kind: "permission", request_id,
 * choice}` so the gateway's `card.action.trigger` handler can route
 * clicks back to `broker.resolveByCard(requestId, choice)`.
 *
 * The card uses `config.update_multi: true` because the broker
 * patches it to a "resolved" / "cancelled" / "timed_out" variant on
 * button click or timeout. `streaming_mode` is off — permission cards
 * aren't streamed, only patched.
 */
export function buildPermissionCard(args: BuildPendingArgs): FeishuCardV2 {
  const preview = formatInputPreview(args.input);
  const elements: FeishuElement[] = [
    {
      tag: "markdown",
      content: `Claude 要调用工具 **${escapeMd(args.toolName)}**：`,
    },
    {
      tag: "markdown",
      content: "```json\n" + preview + "\n```",
    },
    buttonRow([
      makeButton("✅ 允许", "allow", args.requestId, "primary"),
      makeButton("❌ 拒绝", "deny", args.requestId, "danger"),
    ]),
    buttonRow([
      makeButton("✅ 本轮 acceptEdits", "allow_turn", args.requestId, "default"),
      makeButton("✅ 会话 acceptEdits", "allow_session", args.requestId, "default"),
    ]),
    {
      tag: "markdown",
      content:
        '<font color="grey">只有发起者可点击 · 5 分钟未响应自动拒绝</font>',
    },
  ];

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: `🔐 权限请求 · ${args.toolName}`,
      },
      template: "yellow",
    },
    body: { elements },
  };
}

interface BuildResolvedArgs {
  toolName: string;
  choice: "allow" | "deny" | "allow_turn" | "allow_session";
  resolverOpenId: string;
}

export function buildPermissionCardResolved(
  args: BuildResolvedArgs,
): FeishuCardV2 {
  const label = RESOLVED_LABEL[args.choice];
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: `🔐 权限请求 · ${args.toolName}`,
      },
      template: args.choice === "deny" ? "red" : "green",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `✅ 已由 <at id=${JSON.stringify(args.resolverOpenId)}></at> 选择：**${label}**`,
        },
      ],
    },
  };
}

const RESOLVED_LABEL: Record<BuildResolvedArgs["choice"], string> = {
  allow: "允许",
  deny: "拒绝",
  allow_turn: "本轮 acceptEdits",
  allow_session: "会话 acceptEdits",
};

export function buildPermissionCardCancelled(args: {
  toolName: string;
  reason: string;
}): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: `🔐 权限请求 · ${args.toolName}`,
      },
      template: "grey",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `🛑 已取消（${escapeMd(args.reason)}）`,
        },
      ],
    },
  };
}

export function buildPermissionCardTimedOut(args: {
  toolName: string;
}): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: `🔐 权限请求 · ${args.toolName}`,
      },
      template: "grey",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "⏰ 已超时自动拒绝",
        },
      ],
    },
  };
}

// --- helpers ---

function buttonRow(buttons: FeishuElement[]): FeishuElement {
  return {
    tag: "column_set",
    flex_mode: "bisect",
    horizontal_spacing: "8px",
    columns: buttons.map((b) => ({
      tag: "column" as const,
      width: "weighted",
      weight: 1,
      elements: [b],
    })),
  };
}

function makeButton(
  label: string,
  choice: "allow" | "deny" | "allow_turn" | "allow_session",
  requestId: string,
  type: "primary" | "danger" | "default",
): FeishuElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    width: "fill",
    value: { kind: "permission", request_id: requestId, choice },
  };
}

function formatInputPreview(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return truncateForInline(json, INPUT_PREVIEW_MAX_BYTES);
}

function escapeMd(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test test/unit/feishu/cards/permission-card.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Full typecheck + test**

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/feishu/cards/permission-card.ts test/unit/feishu/cards/permission-card.test.ts
git commit -m "feat(feishu): add permission card builders (pending/resolved/cancelled/timed_out)"
```

---

### Task 8: Implement `FeishuPermissionBroker.request()` and its happy-path test

**Files:**
- Create: `src/claude/feishu-permission-broker.ts`
- Create: `test/unit/claude/feishu-permission-broker.test.ts`

First slice of the broker: take a `PermissionRequest`, send the card via `replyCard`, store the `Deferred` in the `pending` Map, and return its promise. Timers and cancellation land in the next tasks.

- [ ] **Step 1: Write the failing test**

Create `test/unit/claude/feishu-permission-broker.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { FeishuPermissionBroker } from "../../../src/claude/feishu-permission-broker.js";
import type { FeishuClient } from "../../../src/feishu/client.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT = createLogger({ level: "error", pretty: false });

function makeFakeFeishu(): {
  client: FeishuClient;
  replyCard: ReturnType<typeof vi.fn>;
  patchCard: ReturnType<typeof vi.fn>;
  replyText: ReturnType<typeof vi.fn>;
} {
  const replyCard = vi.fn().mockResolvedValue({ messageId: "om_card_1" });
  const patchCard = vi.fn().mockResolvedValue(undefined);
  const replyText = vi.fn().mockResolvedValue({ messageId: "om_text_1" });
  const client = { replyCard, patchCard, replyText } as unknown as FeishuClient;
  return { client, replyCard, patchCard, replyText };
}

function makeBroker(feishu: FeishuClient, clock: FakeClock) {
  return new FeishuPermissionBroker({
    feishu,
    clock,
    logger: SILENT,
    config: { timeoutMs: 300_000, warnBeforeMs: 60_000 },
  });
}

describe("FeishuPermissionBroker.request — happy path", () => {
  it("sends a permission card via replyCard with the parent message id", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    // Fire the request but don't await — nobody will resolve it yet.
    void broker.request({
      toolName: "Bash",
      input: { command: "ls" },
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_parent_1",
    });
    // Let the async send settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(f.replyCard).toHaveBeenCalledTimes(1);
    const [parentId, card] = f.replyCard.mock.calls[0]!;
    expect(parentId).toBe("om_parent_1");
    // The card's serialization should include the tool name.
    expect(JSON.stringify(card)).toContain("Bash");
  });

  it("returns a pending promise (doesn't resolve until something happens)", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    const result = await Promise.race([
      p,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(result).toBe("pending");
  });

  it("returns deny if replyCard throws", async () => {
    const f = makeFakeFeishu();
    f.replyCard.mockRejectedValueOnce(new Error("send failed"));
    const broker = makeBroker(f.client, new FakeClock());
    const res = await broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    expect(res).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/card|auto-denied/i),
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test test/unit/claude/feishu-permission-broker.test.ts
```

Expected: module not found.

- [ ] **Step 3: Create `src/claude/feishu-permission-broker.ts` with `request()` only**

```typescript
import crypto from "node:crypto";
import type { Logger } from "pino";
import { createDeferred, type Deferred } from "../util/deferred.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { FeishuClient } from "../feishu/client.js";
import {
  buildPermissionCard,
  buildPermissionCardResolved,
  buildPermissionCardCancelled,
  buildPermissionCardTimedOut,
} from "../feishu/cards/permission-card.js";
import type {
  CardActionResult,
  CardChoice,
  PermissionBroker,
  PermissionRequest,
  PermissionResponse,
} from "./permission-broker.js";

interface PendingRequest {
  readonly requestId: string;
  readonly deferred: Deferred<PermissionResponse>;
  readonly cardMessageId: string;
  readonly parentMessageId: string;
  readonly ownerOpenId: string;
  readonly toolName: string;
  readonly createdAt: number;
  timeoutTimer: TimeoutHandle;
  warnTimer: TimeoutHandle;
}

export interface FeishuPermissionBrokerOptions {
  feishu: FeishuClient;
  clock: Clock;
  logger: Logger;
  config: {
    timeoutMs: number;
    warnBeforeMs: number;
  };
}

/**
 * Production `PermissionBroker` backed by Feishu cards. Posts a
 * permission card on every `canUseTool` invocation, starts two
 * timers (one for the 60s warning reminder, one for the auto-deny),
 * and resolves the pending Deferred when the user clicks a button
 * (via `resolveByCard`) or when `cancelAll` is called.
 */
export class FeishuPermissionBroker implements PermissionBroker {
  private readonly feishu: FeishuClient;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly warnBeforeMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(opts: FeishuPermissionBrokerOptions) {
    this.feishu = opts.feishu;
    this.clock = opts.clock;
    this.logger = opts.logger.child({ component: "feishu-permission-broker" });
    this.timeoutMs = opts.config.timeoutMs;
    this.warnBeforeMs = opts.config.warnBeforeMs;
  }

  async request(req: PermissionRequest): Promise<PermissionResponse> {
    const requestId = crypto.randomUUID();
    const deferred = createDeferred<PermissionResponse>();

    // 1. Send the permission card as a reply to the triggering message.
    let cardMessageId: string;
    try {
      const res = await this.feishu.replyCard(
        req.parentMessageId,
        buildPermissionCard({
          requestId,
          toolName: req.toolName,
          input: req.input,
          ownerOpenId: req.ownerOpenId,
        }),
      );
      cardMessageId = res.messageId;
    } catch (err) {
      this.logger.error(
        {
          err,
          tool_name: req.toolName,
          parent_message_id: req.parentMessageId,
        },
        "permission card replyCard failed — auto-denying",
      );
      return {
        behavior: "deny",
        message: "Failed to send permission card; auto-denied.",
      };
    }

    // 2. Start the timers (auto-deny + warning reminder).
    const timeoutTimer = this.clock.setTimeout(
      () => this.autoDeny(requestId),
      this.timeoutMs,
    );
    const warnTimer = this.clock.setTimeout(
      () => this.sendWarnReminder(requestId),
      Math.max(0, this.timeoutMs - this.warnBeforeMs),
    );

    // 3. Register the pending request.
    this.pending.set(requestId, {
      requestId,
      deferred,
      cardMessageId,
      parentMessageId: req.parentMessageId,
      ownerOpenId: req.ownerOpenId,
      toolName: req.toolName,
      createdAt: this.clock.now(),
      timeoutTimer,
      warnTimer,
    });

    return deferred.promise;
  }

  async resolveByCard(_args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult> {
    // Implemented in Task 9.
    throw new Error("not implemented");
  }

  cancelAll(_reason: string): void {
    // Implemented in Task 10.
  }

  private autoDeny(_requestId: string): void {
    // Implemented in Task 10.
  }

  private sendWarnReminder(_requestId: string): void {
    // Implemented in Task 10.
  }

  private clearTimers(p: PendingRequest): void {
    this.clock.clearTimeout(p.timeoutTimer);
    this.clock.clearTimeout(p.warnTimer);
  }

  // Touch helpers to silence "unused" warnings during staged implementation.
  private _touch(): void {
    void this.clearTimers;
    void buildPermissionCardResolved;
    void buildPermissionCardCancelled;
    void buildPermissionCardTimedOut;
  }
}
```

- [ ] **Step 4: Run the broker tests**

```bash
pnpm test test/unit/claude/feishu-permission-broker.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Full test suite**

```bash
pnpm typecheck && pnpm test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/claude/feishu-permission-broker.ts test/unit/claude/feishu-permission-broker.test.ts
git commit -m "feat(claude): add FeishuPermissionBroker.request() sending permission card"
```

---

### Task 9: Implement `resolveByCard` — allow/deny/allow_turn/allow_session + owner check + not_found

**Files:**
- Modify: `src/claude/feishu-permission-broker.ts`
- Modify: `test/unit/claude/feishu-permission-broker.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/unit/claude/feishu-permission-broker.test.ts`:

```typescript
describe("FeishuPermissionBroker.resolveByCard", () => {
  // Tests use `findRequestIdInCard(card)` (defined at the bottom of
  // this file) to extract the crypto.randomUUID the broker generated
  // internally, by walking the button value of the card that was
  // handed to the mocked replyCard.

  it("owner click with choice=allow resolves with {allow} and patches card to resolved variant", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: { command: "ls" },
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();

    // Extract request_id from the button value of the sent card.
    const card = f.replyCard.mock.calls[0]![1];
    const requestId = findRequestIdInCard(card);
    expect(requestId).toBeTruthy();

    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "allow",
    });
    expect(result).toEqual({ kind: "resolved" });
    const resp = await p;
    expect(resp).toEqual({ behavior: "allow" });
    expect(f.patchCard).toHaveBeenCalledWith(
      "om_card_1",
      expect.any(Object),
    );
  });

  it("owner click with choice=deny resolves with {deny, message}", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "deny",
    });
    const resp = await p;
    expect(resp).toMatchObject({ behavior: "deny", message: expect.any(String) });
  });

  it("owner click with choice=allow_turn resolves with {allow_turn}", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Edit",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);
    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "allow_turn",
    });
    expect(await p).toEqual({ behavior: "allow_turn" });
  });

  it("owner click with choice=allow_session resolves with {allow_session}", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Edit",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);
    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "allow_session",
    });
    expect(await p).toEqual({ behavior: "allow_session" });
  });

  it("non-owner click returns forbidden and leaves the request pending", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_intruder",
      choice: "allow",
    });
    expect(result).toEqual({ kind: "forbidden", ownerOpenId: "ou_owner" });

    // Promise must still be pending.
    const settled = await Promise.race([
      p.then(() => "resolved"),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(settled).toBe("pending");
  });

  it("unknown requestId returns not_found", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const result = await broker.resolveByCard({
      requestId: "req_does_not_exist",
      senderOpenId: "ou_x",
      choice: "allow",
    });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("patchCard failure during resolve does not block the resolution", async () => {
    const f = makeFakeFeishu();
    f.patchCard.mockRejectedValueOnce(new Error("patch failed"));
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "allow",
    });
    expect(result).toEqual({ kind: "resolved" });
    expect(await p).toEqual({ behavior: "allow" });
  });
});

function findRequestIdInCard(card: unknown): string {
  let found: string | undefined;
  function walk(el: unknown): void {
    if (!el || typeof el !== "object") return;
    const e = el as { tag?: string; value?: { request_id?: unknown }; elements?: unknown[]; columns?: unknown[]; body?: unknown };
    if (e.tag === "button" && e.value && typeof e.value.request_id === "string") {
      found = e.value.request_id;
    }
    if (Array.isArray(e.elements)) e.elements.forEach(walk);
    if (Array.isArray(e.columns)) e.columns.forEach(walk);
    if (e.body) walk(e.body);
  }
  walk(card);
  if (!found) throw new Error("no request_id found in card");
  return found;
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test test/unit/claude/feishu-permission-broker.test.ts
```

Expected: 7 new tests failing (mostly on `not implemented` throws).

- [ ] **Step 3: Implement `resolveByCard`**

Replace the `resolveByCard` body in `src/claude/feishu-permission-broker.ts`:

```typescript
  async resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult> {
    const p = this.pending.get(args.requestId);
    if (!p) return { kind: "not_found" };
    if (args.senderOpenId !== p.ownerOpenId) {
      return { kind: "forbidden", ownerOpenId: p.ownerOpenId };
    }
    this.clearTimers(p);
    this.pending.delete(args.requestId);

    // Patch the card to its "resolved" variant. Failure warns but
    // doesn't block the resolution — the Deferred must still fire so
    // the SDK's canUseTool callback unblocks.
    try {
      await this.feishu.patchCard(
        p.cardMessageId,
        buildPermissionCardResolved({
          toolName: p.toolName,
          choice: args.choice,
          resolverOpenId: args.senderOpenId,
        }),
      );
    } catch (err) {
      this.logger.warn(
        {
          err,
          card_message_id: p.cardMessageId,
          request_id: args.requestId,
        },
        "permission card patch failed on resolve — continuing",
      );
    }

    switch (args.choice) {
      case "allow":
        p.deferred.resolve({ behavior: "allow" });
        break;
      case "deny":
        p.deferred.resolve({
          behavior: "deny",
          message: "User denied the tool call.",
        });
        break;
      case "allow_turn":
        p.deferred.resolve({ behavior: "allow_turn" });
        break;
      case "allow_session":
        p.deferred.resolve({ behavior: "allow_session" });
        break;
    }
    return { kind: "resolved" };
  }
```

Remove the `_touch` helper — the real implementations will reference everything.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test test/unit/claude/feishu-permission-broker.test.ts
```

Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/claude/feishu-permission-broker.ts test/unit/claude/feishu-permission-broker.test.ts
git commit -m "feat(claude): implement FeishuPermissionBroker.resolveByCard"
```

---

### Task 10: Implement `cancelAll`, `autoDeny`, and `sendWarnReminder`

**Files:**
- Modify: `src/claude/feishu-permission-broker.ts`
- Modify: `test/unit/claude/feishu-permission-broker.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/unit/claude/feishu-permission-broker.test.ts`:

```typescript
describe("FeishuPermissionBroker.cancelAll", () => {
  it("denies all pending with the given reason and clears the map", async () => {
    const f = makeFakeFeishu();
    const clock = new FakeClock();
    const broker = makeBroker(f.client, clock);
    const p1 = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p1",
    });
    // Second request uses a different parent message id.
    f.replyCard.mockResolvedValueOnce({ messageId: "om_card_2" });
    const p2 = broker.request({
      toolName: "Edit",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p2",
    });
    await Promise.resolve();
    await Promise.resolve();

    broker.cancelAll("User issued /stop");

    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toEqual({
      behavior: "deny",
      message: "User issued /stop",
    });
    expect(r2).toEqual({
      behavior: "deny",
      message: "User issued /stop",
    });
  });

  it("patches each cancelled card to the cancelled variant (best effort)", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();

    broker.cancelAll("Bang prefix cancellation");
    await p;
    // Allow the void-catch patchCard to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(f.patchCard).toHaveBeenCalled();
    const patchCall = f.patchCard.mock.calls[0]!;
    expect(JSON.stringify(patchCall[1])).toMatch(/Bang prefix|取消/);
  });

  it("cancelAll swallows patchCard errors", async () => {
    const f = makeFakeFeishu();
    f.patchCard.mockRejectedValue(new Error("down"));
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => broker.cancelAll("cleanup")).not.toThrow();
    expect(await p).toEqual({
      behavior: "deny",
      message: "cleanup",
    });
  });
});

describe("FeishuPermissionBroker timers", () => {
  it("auto-denies after timeoutMs and patches the card to timed_out", async () => {
    const f = makeFakeFeishu();
    const clock = new FakeClock();
    const broker = makeBroker(f.client, clock);
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();

    clock.advance(300_000);
    const res = await p;
    expect(res).toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/timed out|300/i),
    });
    // Need one more tick to let the patchCard void promise settle.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(f.patchCard).toHaveBeenCalled();
    const lastCard = f.patchCard.mock.calls.at(-1)![1];
    expect(JSON.stringify(lastCard)).toMatch(/超时|timed out/i);
  });

  it("sends the warn reminder (timeoutMs - warnBeforeMs) in", async () => {
    const f = makeFakeFeishu();
    const clock = new FakeClock();
    const broker = makeBroker(f.client, clock);
    void broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();

    clock.advance(240_000);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(f.replyText).toHaveBeenCalled();
    const replyArgs = f.replyText.mock.calls.at(-1)!;
    expect(replyArgs[0]).toBe("om_p");
    expect(String(replyArgs[1])).toMatch(/60|⏰/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test test/unit/claude/feishu-permission-broker.test.ts
```

Expected: 5 new failures.

- [ ] **Step 3: Implement `cancelAll`, `autoDeny`, and `sendWarnReminder`**

Replace the three method stubs in `src/claude/feishu-permission-broker.ts`:

```typescript
  cancelAll(reason: string): void {
    const snapshot = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of snapshot) {
      this.clearTimers(p);
      p.deferred.resolve({ behavior: "deny", message: reason });
      // Best-effort patch to the cancelled variant. Don't await —
      // /stop and ! paths call cancelAll synchronously and we don't
      // want to block them on a card patch round-trip.
      void this.feishu
        .patchCard(
          p.cardMessageId,
          buildPermissionCardCancelled({ toolName: p.toolName, reason }),
        )
        .catch((err) => {
          this.logger.warn(
            { err, request_id: p.requestId },
            "cancelAll patch failed — ignoring",
          );
        });
    }
  }

  private autoDeny(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.clearTimers(p);
    this.pending.delete(requestId);
    const seconds = Math.round(this.timeoutMs / 1000);
    p.deferred.resolve({
      behavior: "deny",
      message: `Permission request timed out after ${seconds}s.`,
    });
    void this.feishu
      .patchCard(
        p.cardMessageId,
        buildPermissionCardTimedOut({ toolName: p.toolName }),
      )
      .catch((err) => {
        this.logger.warn(
          { err, request_id: requestId },
          "autoDeny patch failed",
        );
      });
  }

  private sendWarnReminder(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    const secondsLeft = Math.round(this.warnBeforeMs / 1000);
    void this.feishu
      .replyText(
        p.parentMessageId,
        `⏰ 权限请求（${p.toolName}）将在 ${secondsLeft}s 后自动拒绝`,
      )
      .catch((err) => {
        this.logger.warn(
          { err, request_id: requestId },
          "warn reminder failed",
        );
      });
  }
```

Delete the `_touch` helper (no longer needed) and make sure all imports resolve.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test test/unit/claude/feishu-permission-broker.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Full suite**

```bash
pnpm typecheck && pnpm test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/claude/feishu-permission-broker.ts test/unit/claude/feishu-permission-broker.test.ts
git commit -m "feat(claude): implement FeishuPermissionBroker cancelAll, autoDeny, and warn reminder"
```

---

### Task 11: Extend `QueuedInput` and `submit()` signature with `senderOpenId` + `parentMessageId`

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `src/index.ts`
- Modify: `test/unit/claude/session-state-machine.test.ts` (all existing `submit` calls)
- Modify: `test/unit/claude/session-manager.test.ts` (if it submits)

- [ ] **Step 1: Grep for all `submit(` call sites to understand the blast radius**

```bash
grep -rn "session\.submit(\|\.submit({" src/ test/
```

Expected: hits in `src/index.ts` and `test/unit/claude/session-state-machine.test.ts`.

- [ ] **Step 2: Update `QueuedInput` and introduce `SubmitInput` in `src/claude/session.ts`**

Find the `QueuedInput` interface (around line 96) and extend it:

```typescript
interface QueuedInput {
  readonly text: string;
  readonly senderOpenId: string;
  readonly parentMessageId: string;
  readonly emit: EmitFn;
  readonly done: Deferred<void>;
  readonly seq: number;
}
```

Just above the `ClaudeSession` class, add:

```typescript
/**
 * Extended submit() input: `CommandRouterResult` widened with the
 * fields the broker needs to check ownership and thread replies.
 * The dispatcher builds one of these per incoming Feishu message.
 */
export type SubmitInput = CommandRouterResult & {
  senderOpenId: string;
  parentMessageId: string;
};
```

- [ ] **Step 3: Update `submit()` signature**

Change the `submit` method signature from:

```typescript
async submit(
  input: CommandRouterResult,
  emit: EmitFn,
): Promise<SubmitOutcome>
```

to:

```typescript
async submit(
  input: SubmitInput,
  emit: EmitFn,
): Promise<SubmitOutcome>
```

Inside the method, after the `stop` early-return, the `QueuedInput` construction becomes:

```typescript
    const entry: QueuedInput = {
      text: input.text,
      senderOpenId: input.senderOpenId,
      parentMessageId: input.parentMessageId,
      emit,
      done: createDeferred<void>(),
      seq: this.nextSeq++,
    };
```

(TypeScript narrows `input` to `{kind: "run", text} | {kind: "interrupt_and_run", text}` after the stop early-return, so `input.text` is available on both variants without a discriminant check.)

- [ ] **Step 4: Update `src/index.ts` dispatcher**

In `src/index.ts`, inside the `onMessage` handler, find where `parseInput` is called and update the `submit` call:

```typescript
      const parsed = parseInput(msg.text);
      if (parsed.kind === "stop") {
        await session.stop(emit);
        return;
      }
      const outcome = await session.submit(
        {
          ...parsed,
          senderOpenId: msg.senderOpenId,
          parentMessageId: msg.messageId,
        },
        emit,
      );
```

- [ ] **Step 5: Update `test/unit/claude/session-state-machine.test.ts` to include the new fields in every submit**

Grep and replace every `session.submit({ kind: "run"` with `session.submit({ kind: "run", senderOpenId: "ou_test", parentMessageId: "om_test"` (and similarly for `interrupt_and_run`). There are many — do this systematically:

```bash
grep -cn 'submit({' test/unit/claude/session-state-machine.test.ts
```

For each matching `submit({` call, expand the input object to include:

```typescript
{
  kind: "run",
  text: "...",
  senderOpenId: "ou_test",
  parentMessageId: "om_test",
}
```

and for `interrupt_and_run`:

```typescript
{
  kind: "interrupt_and_run",
  text: "...",
  senderOpenId: "ou_test",
  parentMessageId: "om_test",
}
```

`stop` submits don't need the new fields (they still work, since `SubmitInput` is a union and the non-stop branches pick up the extras).

Wait — `stop` is also part of `CommandRouterResult`, and the new type `SubmitInput = CommandRouterResult & {...}` adds the required fields to ALL variants. So `stop` calls ALSO need `senderOpenId` + `parentMessageId`. Update those too, or migrate them to call `session.stop(emit)` directly.

Grep for `{ kind: "stop" }` in the test file and either:
1. Add the two new fields to the object, OR
2. Replace `session.submit({ kind: "stop" }, emit)` with `session.stop(emit)` directly.

Option 2 is cleaner — do that.

- [ ] **Step 6: Check other test files for `submit` calls**

```bash
grep -rn 'session\.submit\|\.submit({' test/unit
```

Update any additional call sites similarly.

- [ ] **Step 7: Run full typecheck + test**

```bash
pnpm typecheck && pnpm test
```

Expected: all green. The new fields are carried but aren't yet used by the broker (that lands in Task 13).

- [ ] **Step 8: Commit**

```bash
git add src/claude/session.ts src/index.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): extend submit() with senderOpenId + parentMessageId"
```

---

### Task 12: Add `sessionAcceptEditsSticky` field and consume it in `runTurn`

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `test/unit/claude/session-state-machine.test.ts`

Add the sticky flag that flips `permissionMode` to `acceptEdits` for subsequent turns after the user clicks "会话 acceptEdits". This task only wires the field — the closure that sets it lands in Task 13.

- [ ] **Step 1: Write the failing test**

Append to the relevant describe block in `session-state-machine.test.ts` (end of the `describe("ClaudeSession — happy path"`, for example):

```typescript
  it("runTurn uses acceptEdits when sessionAcceptEditsSticky is set", async () => {
    const recorded: Array<{ permissionMode: string }> = [];
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      recorded.push({ permissionMode: params.options.permissionMode });
      const fake = new FakeQueryHandle();
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new TransitionalStubBroker(),
      logger: SILENT_LOGGER,
    });
    // Manually set the sticky flag via a test seam (added below).
    session._testSetSessionAcceptEditsSticky(true);

    const outcome = await session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_test",
        parentMessageId: "om_test",
      },
      new SpyRenderer().emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    fakes[0]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;

    expect(recorded[0]!.permissionMode).toBe("acceptEdits");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test test/unit/claude/session-state-machine.test.ts
```

Expected: fails on `_testSetSessionAcceptEditsSticky is not a function` or similar.

- [ ] **Step 3: Add the field and test seam to `ClaudeSession`**

In `src/claude/session.ts`, inside the class, near `pendingPermission`:

```typescript
  /**
   * When true, subsequent turns run with `permissionMode: "acceptEdits"`
   * regardless of the configured default. Set by the session's canUseTool
   * closure when the user clicks "会话 acceptEdits" on a permission card.
   * Cleared only on process restart (Phase 5 scope) — Phase 6's `/new`
   * and `/mode default` commands will clear it too.
   */
  private sessionAcceptEditsSticky = false;
```

And in the `processLoop`, replace the options construction:

```typescript
      const permissionMode = this.sessionAcceptEditsSticky
        ? ("acceptEdits" as const)
        : this.config.defaultPermissionMode;
      const handle = this.queryFn({
        prompt: next.text,
        options: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode,
          settingSources: ["project"],
        },
        canUseTool: this.buildCanUseToolClosure(next),
      });
```

Add a placeholder `buildCanUseToolClosure` method at the bottom of the class that returns a noop-deny (we'll wire it properly in Task 13):

```typescript
  private buildCanUseToolClosure(
    input: QueuedInput,
  ): CanUseToolFn {
    // Touch input so TypeScript doesn't complain during the transition.
    void input;
    return async () => ({
      behavior: "deny",
      message: "canUseTool not yet wired",
    });
  }
```

And add the imports at the top:

```typescript
import type { CanUseToolFn, QueryFn, QueryHandle } from "./query-handle.js";
```

Finally, add the test seam:

```typescript
  /** @internal Phase 5 test seam — manipulates sticky flag directly. */
  _testSetSessionAcceptEditsSticky(value: boolean): void {
    this.sessionAcceptEditsSticky = value;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test test/unit/claude/session-state-machine.test.ts
```

Expected: the new test passes.

- [ ] **Step 5: Run the full suite**

```bash
pnpm typecheck && pnpm test
```

Expected: green. The `canUseTool: this.buildCanUseToolClosure(next)` is now passed to the queryFn, so every test's `queryFn` signature also needs to accept (and ignore) this new param — but since the stub `queryFn` in the harness uses `() => fake`, it silently ignores extra params and still compiles.

- [ ] **Step 6: Commit**

```bash
git add src/claude/session.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): add sessionAcceptEditsSticky flag and propagate via permissionMode"
```

---

### Task 13: Wire the real `canUseTool` closure and delete `pendingPermission` + test seams

**Files:**
- Modify: `src/claude/session.ts`
- Create: `test/unit/claude/fakes/fake-permission-broker.ts`
- Modify: `test/unit/claude/session-state-machine.test.ts`

This is the biggest behavior change: the session now calls `broker.request(...)` from within its `canUseTool` closure, flips state to `awaiting_permission` while waiting, and translates 4-variant broker responses into `{allow}` / `{deny}` for the SDK.

- [ ] **Step 1: Create the `FakePermissionBroker`**

Create `test/unit/claude/fakes/fake-permission-broker.ts`:

```typescript
import type {
  CardActionResult,
  CardChoice,
  PermissionBroker,
  PermissionRequest,
  PermissionResponse,
} from "../../../../src/claude/permission-broker.js";

/**
 * In-memory PermissionBroker for session-state tests. Captures all
 * `request` calls and gives tests a `fakeResolve` handle to advance
 * them. `cancelAll` records the reason and resolves any outstanding
 * pending promise with a deny.
 */
export class FakePermissionBroker implements PermissionBroker {
  readonly requests: PermissionRequest[] = [];
  readonly cancelCalls: string[] = [];
  readonly resolveByCardCalls: Array<{
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }> = [];
  private pending: Array<(r: PermissionResponse) => void> = [];

  async request(req: PermissionRequest): Promise<PermissionResponse> {
    this.requests.push(req);
    return new Promise<PermissionResponse>((resolve) => {
      this.pending.push(resolve);
    });
  }

  /**
   * Test helper — resolves the OLDEST pending request with the given
   * response. Throws if nothing is pending so tests fail loudly on
   * bad ordering.
   */
  fakeResolve(response: PermissionResponse): void {
    const resolver = this.pending.shift();
    if (!resolver) {
      throw new Error("FakePermissionBroker: no pending request to resolve");
    }
    resolver(response);
  }

  async resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult> {
    this.resolveByCardCalls.push(args);
    return { kind: "not_found" };
  }

  cancelAll(reason: string): void {
    this.cancelCalls.push(reason);
    const resolvers = this.pending;
    this.pending = [];
    for (const r of resolvers) {
      r({ behavior: "deny", message: reason });
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }
}
```

- [ ] **Step 2: Wire the real closure in `session.ts`**

Replace `buildCanUseToolClosure` with:

```typescript
  private buildCanUseToolClosure(input: QueuedInput): CanUseToolFn {
    return async (toolName, rawInput, _sdkOpts) => {
      // Flip into awaiting_permission while we wait on the broker.
      await this.mutex.run(async () => {
        if (this.state === "generating") {
          this.state = "awaiting_permission";
        }
      });

      let response;
      try {
        response = await this.permissionBroker.request({
          toolName,
          input: rawInput,
          chatId: this.chatId,
          ownerOpenId: input.senderOpenId,
          parentMessageId: input.parentMessageId,
        });
      } finally {
        await this.mutex.run(async () => {
          if (this.state === "awaiting_permission") {
            this.state = "generating";
          }
        });
      }

      switch (response.behavior) {
        case "allow":
          return { behavior: "allow" };
        case "deny":
          return { behavior: "deny", message: response.message };
        case "allow_turn":
          this.currentTurn?.handle.setPermissionMode("acceptEdits");
          return { behavior: "allow" };
        case "allow_session":
          this.currentTurn?.handle.setPermissionMode("acceptEdits");
          this.sessionAcceptEditsSticky = true;
          return { behavior: "allow" };
      }
    };
  }
```

The session class also needs a `chatId` field (currently only used for the logger child). Check lines 144-149 — `opts.chatId` is consumed but not stored. Add `private readonly chatId: string;` to the class and set `this.chatId = opts.chatId;` in the constructor.

- [ ] **Step 3: Delete `pendingPermission` field, test seams, and the old cancellation logic**

In `src/claude/session.ts`:

1. Delete the `pendingPermission: Deferred<PermissionResponse> | null = null;` field.
2. Delete `_testEnterAwaitingPermission` and `_testLeaveAwaitingPermission` methods.
3. In `submitInterruptAndRun`, replace the `permissionToDeny` block with `broker.cancelAll`:

```typescript
  private async submitInterruptAndRun(
    entry: QueuedInput,
  ): Promise<SubmitOutcome> {
    const toDrop: QueuedInput[] = [];
    let toInterrupt: QueryHandle | null = null;
    let needCancelPending = false;

    await this.mutex.run(async () => {
      while (this.inputQueue.length > 0) {
        toDrop.push(this.inputQueue.shift()!);
      }
      toInterrupt = this.currentTurn?.handle ?? null;
      if (this.state === "awaiting_permission") {
        needCancelPending = true;
        this.state = "generating";
      }
      this.inputQueue.push(entry);
      if (this.state === "idle") {
        this.state = "generating";
      }
      this.kickLoopIfNeeded();
    });

    if (needCancelPending) {
      this.permissionBroker.cancelAll("User sent ! prefix");
    }

    for (const dropped of toDrop) {
      try {
        await dropped.emit({ type: "interrupted", reason: "bang_prefix" });
      } catch (err) {
        this.logger.warn(
          { err, seq: dropped.seq },
          "emit interrupted event threw — continuing to reject done",
        );
      }
      dropped.done.reject(new InterruptedError("bang_prefix"));
    }

    if (toInterrupt !== null) {
      try {
        await (toInterrupt as QueryHandle).interrupt();
      } catch (err) {
        this.logger.warn(
          { err },
          "interrupt_and_run: currentTurn.interrupt() threw",
        );
      }
    }

    return { kind: "started", done: entry.done.promise };
  }
```

4. Similarly, in `stop()`:

```typescript
  async stop(emit: EmitFn): Promise<void> {
    const toDrop: QueuedInput[] = [];
    let toInterrupt: QueryHandle | null = null;
    let needCancelPending = false;

    await this.mutex.run(async () => {
      if (this.state === "idle") return;
      toInterrupt = this.currentTurn?.handle ?? null;
      if (this.state === "awaiting_permission") {
        needCancelPending = true;
        this.state = "generating";
      }
      while (this.inputQueue.length > 0) {
        toDrop.push(this.inputQueue.shift()!);
      }
    });

    if (needCancelPending) {
      this.permissionBroker.cancelAll("User issued /stop");
    }

    for (const dropped of toDrop) {
      try {
        await dropped.emit({ type: "interrupted", reason: "stop" });
      } catch (err) {
        this.logger.warn(
          { err, seq: dropped.seq },
          "emit interrupted event threw — continuing to reject done",
        );
      }
      dropped.done.reject(new InterruptedError("stop"));
    }

    if (toInterrupt !== null) {
      try {
        await (toInterrupt as QueryHandle).interrupt();
      } catch (err) {
        this.logger.warn({ err }, "currentTurn.interrupt() threw");
      }
    }

    try {
      await emit({ type: "stop_ack" });
    } catch (err) {
      this.logger.warn({ err }, "stop ack emit threw");
    }
  }
```

5. Delete the unused `PermissionResponse` import at the top of `session.ts` (the session no longer references it directly — only the closure's parameter type comes via `CanUseToolFn`).

6. Delete the `void this.clock;` and `void this.permissionBroker;` lines — both are now actually used.

- [ ] **Step 4: Rewrite `session-state-machine.test.ts` awaiting_permission suite**

Replace the entire `describe("ClaudeSession — awaiting_permission stub"` block with a new `describe("ClaudeSession — canUseTool bridging"` that uses `FakePermissionBroker`. Also import `FakePermissionBroker` and delete the now-unused `createDeferred` / `PermissionResponse` imports.

```typescript
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";

// ... inside the describe ...

describe("ClaudeSession — canUseTool bridging via PermissionBroker", () => {
  function makeBrokerHarness(): Harness & { broker: FakePermissionBroker } {
    const broker = new FakePermissionBroker();
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = () => {
      const fake = new FakeQueryHandle();
      fakes.push(fake);
      return fake as QueryHandle;
    };
    const clock = new FakeClock();
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock,
      permissionBroker: broker,
      logger: SILENT_LOGGER,
    });
    return { session, fakes, queryFn, clock, broker };
  }

  it("canUseTool → broker.request is called with the correct fields", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    // Simulate the SDK invoking canUseTool.
    // FakeQueryHandle doesn't have canUseTool wiring — we need to grab
    // the closure the session built. Extend FakeQueryFn to capture it.
    // (See Task 13 Step 5.)
    // For now, the FakeQueryHandle stores canUseTool via a setter;
    // assume `fake.invokeCanUseTool("Bash", {command: "ls"})`.
    const p = fake.invokeCanUseTool!("Bash", { command: "ls" });
    await flushMicrotasks();
    expect(h.broker.requests).toHaveLength(1);
    expect(h.broker.requests[0]).toMatchObject({
      toolName: "Bash",
      input: { command: "ls" },
      chatId: "oc_x",
      ownerOpenId: "ou_alice",
      parentMessageId: "om_root_1",
    });
    // Resolve the broker → canUseTool returns {allow}.
    h.broker.fakeResolve({ behavior: "allow" });
    expect(await p).toEqual({ behavior: "allow" });

    // Clean up the turn.
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("broker deny maps to {deny, message} for the SDK", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    const p = fake.invokeCanUseTool!("Bash", {});
    await flushMicrotasks();
    h.broker.fakeResolve({ behavior: "deny", message: "nope" });
    expect(await p).toEqual({ behavior: "deny", message: "nope" });
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("broker allow_turn calls handle.setPermissionMode('acceptEdits') and returns {allow}", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    const p = fake.invokeCanUseTool!("Edit", {});
    await flushMicrotasks();
    h.broker.fakeResolve({ behavior: "allow_turn" });
    expect(await p).toEqual({ behavior: "allow" });
    expect(fake.permissionModeChanges).toEqual(["acceptEdits"]);
    // Sticky flag must NOT flip for allow_turn.
    expect(h.session._testGetSessionAcceptEditsSticky()).toBe(false);
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("broker allow_session flips sticky and calls setPermissionMode", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const outcome = await h.session.submit(
      {
        kind: "run",
        text: "hi",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
      },
      spy.emit,
    );
    if (outcome.kind !== "started") throw new Error("unreachable");
    await flushMicrotasks();
    const fake = h.fakes[0]!;
    const p = fake.invokeCanUseTool!("Edit", {});
    await flushMicrotasks();
    h.broker.fakeResolve({ behavior: "allow_session" });
    expect(await p).toEqual({ behavior: "allow" });
    expect(fake.permissionModeChanges).toEqual(["acceptEdits"]);
    expect(h.session._testGetSessionAcceptEditsSticky()).toBe(true);
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("/stop while awaiting_permission calls broker.cancelAll", async () => {
    const h = makeBrokerHarness();
    const spy = new SpyRenderer();
    const stopSpy = new SpyRenderer();
    const first = await h.session.submit(
      {
        kind: "run",
        text: "one",
        senderOpenId: "ou_alice",
        parentMessageId: "om_root_1",
      },
      spy.emit,
    );
    await flushMicrotasks();
    if (first.kind !== "started") throw new Error("unreachable");
    const fake = h.fakes[0]!;
    const permP = fake.invokeCanUseTool!("Bash", {});
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("awaiting_permission");

    await h.session.stop(stopSpy.emit);

    expect(h.broker.cancelCalls).toContain("User issued /stop");
    // The canUseTool promise must be resolved with deny now.
    expect(await permP).toMatchObject({ behavior: "deny" });
    expect(fake.interrupted).toBe(true);
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("idle");
    expect(stopSpy.events).toEqual([{ type: "stop_ack" }]);
  });

  it("! prefix while awaiting_permission calls cancelAll, drops queue, runs new input", async () => {
    const h = makeBrokerHarness();
    const spy1 = new SpyRenderer();
    const spy2 = new SpyRenderer();
    const spyBang = new SpyRenderer();
    const first = await h.session.submit(
      {
        kind: "run",
        text: "one",
        senderOpenId: "ou_a",
        parentMessageId: "om_1",
      },
      spy1.emit,
    );
    await flushMicrotasks();
    const second = await h.session.submit(
      {
        kind: "run",
        text: "two",
        senderOpenId: "ou_a",
        parentMessageId: "om_2",
      },
      spy2.emit,
    );
    if (first.kind !== "started" || second.kind !== "queued") {
      throw new Error("unreachable");
    }
    const fake = h.fakes[0]!;
    const permP = fake.invokeCanUseTool!("Bash", {});
    await flushMicrotasks();
    expect(h.session._testGetState()).toBe("awaiting_permission");

    const bang = await h.session.submit(
      {
        kind: "interrupt_and_run",
        text: "urgent",
        senderOpenId: "ou_a",
        parentMessageId: "om_3",
      },
      spyBang.emit,
    );
    if (bang.kind !== "started") throw new Error("unreachable");

    expect(h.broker.cancelCalls).toContain("User sent ! prefix");
    expect(await permP).toMatchObject({ behavior: "deny" });
    await expect(second.done).rejects.toThrow(/bang_prefix|interrupted/i);
    await expect(first.done).rejects.toThrow();
    await flushMicrotasks();

    expect(h.fakes).toHaveLength(2);
    h.fakes[1]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await bang.done;
    expect(h.session._testGetState()).toBe("idle");
  });
});
```

Add the missing `_testGetSessionAcceptEditsSticky` seam on `ClaudeSession`:

```typescript
  /** @internal */
  _testGetSessionAcceptEditsSticky(): boolean {
    return this.sessionAcceptEditsSticky;
  }
```

- [ ] **Step 5: Extend `FakeQueryHandle` with `invokeCanUseTool`**

The fake test currently relies on `fake.invokeCanUseTool` — but the fake only gets the handle, not the `canUseTool` closure. The closure lives in `params.canUseTool` which the queryFn receives. Refactor: the harness's `queryFn` captures `params.canUseTool` and stores it on the fake.

Edit `test/unit/claude/fakes/fake-query-handle.ts` to add:

```typescript
  /**
   * Per-turn canUseTool closure captured from the session. The
   * harness's queryFn sets this when it builds the FakeQueryHandle.
   * Tests call `invokeCanUseTool(...)` to simulate the SDK asking
   * the session for a permission decision.
   */
  canUseTool: CanUseToolFn | null = null;

  invokeCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > {
    if (!this.canUseTool) {
      throw new Error(
        "FakeQueryHandle.invokeCanUseTool: canUseTool closure was not captured",
      );
    }
    return this.canUseTool(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: "tu_test",
    });
  }
```

Add the import:

```typescript
import type { CanUseToolFn } from "../../../../src/claude/query-handle.js";
```

Update the harness's `queryFn` in `session-state-machine.test.ts` to capture `params.canUseTool`:

```typescript
const queryFn: QueryFn = (params) => {
  const fake = new FakeQueryHandle();
  fake.canUseTool = params.canUseTool;
  fakes.push(fake);
  return fake as QueryHandle;
};
```

Do this in BOTH `makeHarness` and `makeBrokerHarness` (and any other inline queryFn in the file).

Also — in `makeHarness` (and any other non-canUseTool helpers that still reference `TransitionalStubBroker`), swap the broker construction to `new FakePermissionBroker()`:

```typescript
// BEFORE
import { TransitionalStubBroker } from "../../../src/claude/permission-broker.js";
// ...
permissionBroker: new TransitionalStubBroker(),

// AFTER
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";
// ...
permissionBroker: new FakePermissionBroker(),
```

Happy-path tests don't exercise canUseTool and therefore don't need a broker at all, but the constructor still requires one. `FakePermissionBroker` is inert unless `request` is actually called, so it's safe as a drop-in. This makes Task 16's `TransitionalStubBroker` grep clean — no remaining references after Task 13.

- [ ] **Step 6: Run the tests**

```bash
pnpm test test/unit/claude/session-state-machine.test.ts
```

Expected: all new canUseTool bridging tests pass; all pre-existing tests continue to pass (they don't exercise canUseTool, and the stub broker isn't used by them since we didn't route through it).

- [ ] **Step 7: Full suite**

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/claude/session.ts test/unit/claude/fakes/fake-permission-broker.ts test/unit/claude/fakes/fake-query-handle.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): wire canUseTool closure through PermissionBroker, delete pendingPermission field"
```

---

### Task 14: Extend gateway with `card.action.trigger` subscription

**Files:**
- Modify: `src/feishu/gateway.ts`
- Create: `test/unit/feishu/gateway-card-action.test.ts` (optional smoke)

Add the new event subscription and an `onCardAction` option. Access control runs on the clicker's `open_id` the same way it does on the message sender.

- [ ] **Step 1: Read the current gateway structure**

Already read — subscription is a single `register({})` call on lines 59-64.

- [ ] **Step 2: Add the type and extend the options**

Edit `src/feishu/gateway.ts`. Near the top:

```typescript
export interface CardActionEvent {
  operator: {
    open_id: string;
  };
  action: {
    value: Record<string, unknown>;
  };
  // The event carries more fields (token, tenant_key, form_value...)
  // but Phase 5 only reads operator.open_id + action.value.
}

export type CardActionHandler = (action: {
  senderOpenId: string;
  value: Record<string, unknown>;
}) => Promise<void>;
```

Extend `FeishuGatewayOptions`:

```typescript
export interface FeishuGatewayOptions {
  appId: string;
  appSecret: string;
  logger: Logger;
  lark: LarkClient;
  access: AccessControl;
  onMessage: MessageHandler;
  onCardAction: CardActionHandler;
}
```

Store the handler on the class (add `private readonly onCardAction: CardActionHandler;` and `this.onCardAction = opts.onCardAction;` in the constructor).

In `start()`, extend the dispatcher registration:

```typescript
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const event = data as ReceiveV1Event;
        await this.handleReceiveV1(event);
      },
      "card.action.trigger": async (data: unknown) => {
        await this.handleCardAction(data as CardActionEvent);
        return {};
      },
    });
```

And add the handler method:

```typescript
  private async handleCardAction(event: CardActionEvent): Promise<void> {
    const log = this.logger.child({ open_id: event.operator.open_id });
    const decision = this.access.check(event.operator.open_id);
    if (!decision.allowed) {
      log.warn(
        { action: decision.action },
        "Unauthorized card action, ignoring",
      );
      return;
    }
    try {
      await this.onCardAction({
        senderOpenId: event.operator.open_id,
        value: event.action.value,
      });
    } catch (err) {
      log.error({ err }, "Card action handler threw");
    }
  }
```

- [ ] **Step 3: Verify typecheck passes**

```bash
pnpm typecheck
```

Expected: FAILS because `src/index.ts` doesn't yet pass `onCardAction`. That's fine — we'll fix it in Task 15. For now, temporarily stub it in `index.ts`:

```typescript
  const gateway = new FeishuGateway({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    logger,
    lark,
    access,
    onMessage,
    onCardAction: async () => {
      // Wired in Task 15.
    },
  });
```

Re-run `pnpm typecheck` — should pass.

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: green — gateway doesn't have dedicated tests beyond the access-control one, and that still passes.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/gateway.ts src/index.ts
git commit -m "feat(feishu): subscribe to card.action.trigger with access-controlled handler"
```

---

### Task 15: Wire `FeishuPermissionBroker` and `createSdkQueryFn` in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

This is the big wiring task: construct the real broker, switch from `createCliQueryFn` to `createSdkQueryFn`, point the gateway's `onCardAction` at `broker.resolveByCard`, and add the startup warn when `bypassPermissions` is still configured.

- [ ] **Step 1: Swap the broker construction**

In `src/index.ts`:

```typescript
// BEFORE
import { TransitionalStubBroker } from "./claude/permission-broker.js";
// ...
permissionBroker: new TransitionalStubBroker(),

// AFTER
import { FeishuPermissionBroker } from "./claude/feishu-permission-broker.js";
// ...
const permissionBroker = new FeishuPermissionBroker({
  feishu: feishuClient,
  clock: new RealClock(),
  logger,
  config: {
    timeoutMs: config.claude.permissionTimeoutMs,
    warnBeforeMs: config.claude.permissionWarnBeforeMs,
  },
});

const sessionManager = new ClaudeSessionManager({
  config: config.claude,
  queryFn,
  clock: new RealClock(),
  permissionBroker,
  logger,
});
```

Note: both the session manager and the broker now need the same `RealClock` semantic, but they don't need to share one instance — each can have its own since `RealClock` is stateless.

- [ ] **Step 2: Swap the query function**

```typescript
// BEFORE
import { createCliQueryFn } from "./claude/cli-query.js";
// ...
const queryFn = createCliQueryFn({
  cliPath: config.claude.cliPath,
  logger,
});

// AFTER
import { createSdkQueryFn } from "./claude/sdk-query.js";
// ...
const queryFn = createSdkQueryFn({
  cliPath: config.claude.cliPath,
  logger,
});
```

- [ ] **Step 3: Replace the `onCardAction` stub with a real handler**

```typescript
  const onCardAction = async ({
    senderOpenId,
    value,
  }: {
    senderOpenId: string;
    value: Record<string, unknown>;
  }): Promise<void> => {
    if (value.kind !== "permission") {
      logger.warn({ value }, "Card action with unknown kind, ignoring");
      return;
    }
    const requestId = value.request_id;
    const choice = value.choice;
    if (typeof requestId !== "string") {
      logger.warn({ value }, "Card action missing request_id");
      return;
    }
    if (
      choice !== "allow" &&
      choice !== "deny" &&
      choice !== "allow_turn" &&
      choice !== "allow_session"
    ) {
      logger.warn({ value }, "Card action has invalid choice");
      return;
    }
    const result = await permissionBroker.resolveByCard({
      requestId,
      senderOpenId,
      choice,
    });
    if (result.kind === "forbidden") {
      logger.warn(
        {
          request_id: requestId,
          clicker: senderOpenId,
          owner: result.ownerOpenId,
        },
        "Non-owner permission card click — ignored",
      );
    } else if (result.kind === "not_found") {
      logger.info(
        { request_id: requestId },
        "Card action for unknown request — likely already resolved",
      );
    }
  };
```

Pass `onCardAction` into `new FeishuGateway({...})`:

```typescript
  const gateway = new FeishuGateway({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    logger,
    lark,
    access,
    onMessage,
    onCardAction,
  });
```

- [ ] **Step 4: Add the bypassPermissions startup warning**

Right after `logger.info({...}, "claude-feishu-channel Phase 4 ready");` update that log and add a warn:

```typescript
  logger.info(
    {
      allowed_count: config.access.allowedOpenIds.length,
      unauthorized_behavior: config.access.unauthorizedBehavior,
      cli_path: config.claude.cliPath,
      default_cwd: config.claude.defaultCwd,
      default_model: config.claude.defaultModel,
      permission_mode: config.claude.defaultPermissionMode,
      permission_timeout_ms: config.claude.permissionTimeoutMs,
      inline_max_bytes: config.render.inlineMaxBytes,
      hide_thinking: config.render.hideThinking,
      show_turn_stats: config.render.showTurnStats,
    },
    "claude-feishu-channel Phase 5 ready",
  );

  if (config.claude.defaultPermissionMode === "bypassPermissions") {
    logger.warn(
      { permission_mode: "bypassPermissions" },
      "Phase 5 shipped — permission brokering is ACTIVE only when default_permission_mode != 'bypassPermissions'. Your current config bypasses the broker; tool calls will not prompt for approval.",
    );
  }
```

- [ ] **Step 5: Run typecheck + test**

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire FeishuPermissionBroker and sdk-query.ts in main bootstrap"
```

---

### Task 16: Delete `cli-query.ts`, its test, and the `TransitionalStubBroker`

**Files:**
- Delete: `src/claude/cli-query.ts`
- Delete: `test/unit/claude/cli-query.test.ts`
- Modify: `src/claude/permission-broker.ts`
- Modify: `test/unit/claude/permission-broker.test.ts`

- [ ] **Step 1: Delete the CLI query files**

```bash
rm src/claude/cli-query.ts test/unit/claude/cli-query.test.ts
```

- [ ] **Step 2: Remove `TransitionalStubBroker` from `permission-broker.ts`**

Delete the `TransitionalStubBroker` class from `src/claude/permission-broker.ts`. The file now only exports the interface + types.

- [ ] **Step 3: Delete or repurpose `test/unit/claude/permission-broker.test.ts`**

Since the file was a narrow type test for the stub, it's now dead. Delete it:

```bash
rm test/unit/claude/permission-broker.test.ts
```

- [ ] **Step 4: Verify nothing still references the removed code**

```bash
grep -rn "cli-query\|TransitionalStubBroker\|NullPermissionBroker\|createCliQueryFn" src/ test/
```

Expected: no hits. If any hit appears, resolve it (most likely a test that still used `TransitionalStubBroker` — switch it to `FakePermissionBroker`).

- [ ] **Step 5: Run typecheck + test**

```bash
pnpm typecheck && pnpm test
```

Expected: all green, fewer tests total (cli-query.test.ts and permission-broker.test.ts gone).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove cli-query.ts and TransitionalStubBroker (replaced by sdk-query + FeishuPermissionBroker)"
```

---

### Task 17: Update `config.example.toml` with the new fields and the default change

**Files:**
- Modify: `config.example.toml`

- [ ] **Step 1: Edit `config.example.toml`**

Replace the `default_permission_mode` block with:

```toml
# Permission mode for new sessions. Options:
#   default            — Phase 5 ACTIVE: tool calls post a permission
#                        card to the Feishu group; only the user who
#                        sent the triggering message can click.
#   acceptEdits        — auto-approve file edits, prompt for shell
#                        via the permission card
#   plan               — plan mode, read-only
#   bypassPermissions  — auto-approve everything, broker disabled
#                        (Phase 4 legacy; prints a warn on startup)
default_permission_mode = "default"
```

Below the `cli_path` line, add:

```toml
# Time in seconds the permission card waits for a click before
# auto-denying. Card posts a warning reminder (permission_warn_before_seconds)
# before the hard deadline.
permission_timeout_seconds = 300
permission_warn_before_seconds = 60
```

- [ ] **Step 2: Run typecheck + test**

```bash
pnpm typecheck && pnpm test
```

Expected: all green. `config.example.toml` isn't loaded by any test, so behavior is unchanged.

- [ ] **Step 3: Commit**

```bash
git add config.example.toml
git commit -m "docs(config): default_permission_mode=default + permission_timeout_seconds example"
```

---

### Task 18: Full validation — typecheck, full test suite, manual E2E checklist

**Files:** none (verification only)

- [ ] **Step 1: Clean typecheck + test**

```bash
pnpm typecheck && pnpm test
```

Expected: all green, all tests pass. Record the final test count; if it dropped significantly compared to pre-Phase 5, investigate.

- [ ] **Step 2: Verify startup**

```bash
pnpm dev
```

Expected:
- Loads config
- Preflight OK
- "claude-feishu-channel Phase 5 ready" info log
- If config still has `bypassPermissions`, a warn log about the broker being bypassed
- Feishu WebSocket connects

Kill with Ctrl-C.

- [ ] **Step 3: Manual E2E checklist — run through the checklist from §5.7 of the design spec**

For each checkbox, test it by actually interacting with the bot from Feishu:

- [ ] Send `ls 一下当前目录` → permission card appears with 4 buttons
- [ ] Click `✅ 允许` → Claude runs `ls` and replies with the output
- [ ] Ask again → click `❌ 拒绝` → Claude receives the deny and continues the conversation
- [ ] Ask for several edits → click `✅ 本轮 acceptEdits` on the first one → subsequent Edit/Write calls don't prompt
- [ ] In the same turn, ask for a `Bash` call → permission card appears (Bash not covered by acceptEdits)
- [ ] Start a new turn → ask for an Edit → still no prompt (sticky is NOT set)
- [ ] Click `✅ 会话 acceptEdits` on a fresh edit prompt → new turn edits don't prompt either
- [ ] Restart bot → edit prompt reappears (sticky cleared on restart)
- [ ] Leave a permission card sitting → after 4 minutes the `⏰ 60s` text reminder appears; after 5 minutes card flips to "⏰ 已超时自动拒绝"
- [ ] While a permission card is pending, send `/stop` → card flips to "🛑 已取消 (User issued /stop)"; session returns to idle
- [ ] While a permission card is pending, send `! 另一个请求` → card cancels + queue clears + new turn starts
- [ ] In a group chat, have another allowed-but-not-originating user click a button → card stays pending, logs show `forbidden`
- [ ] Confirm `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` still drive the SDK (check a turn completes while pointing at a custom endpoint)

If any checkbox fails, file a follow-up bug. Do NOT patch the implementation blindly mid-checklist — report findings and decide where to go next.

- [ ] **Step 4: Commit the final completion marker**

If no code changes were needed, skip. Otherwise capture any fixes as a separate commit with a descriptive message.

---

## Risks and Open Questions (must be confirmed during Task 1)

1. **SDK return type**: Plan assumes `query()` returns `AsyncIterable<SDKMessage> & { setPermissionMode(mode) }`. If the shape differs, Task 5 needs updates — specifically the `q.setPermissionMode` call and the `for await` loop.
2. **SDK canUseTool opts shape**: Plan assumes `{ signal, toolUseID }` — verify field naming.
3. **`CardActionEvent` TypeScript type**: Plan defines its own interface; the lark SDK may export a better one. If so, swap the import in Task 14.
4. **`card.action.trigger` subscription requirements**: may need an additional Feishu scope enabled in the developer console. Task 18's E2E step will surface this; if buttons don't fire, check the console permissions.
5. **Feishu button layout**: `column_set` with `flex_mode: "bisect"` for 2 buttons per row is the documented pattern — if Feishu renders it weirdly, try `flex_mode: "stretch"` as the fallback.
6. **`update_multi` on permission cards**: already set in the builder. If patchCard starts failing with 230099, double-check the field propagates through JSON serialization.
7. **Sticky flag clearing**: Phase 5 only clears on process restart. Phase 6's `/new` will clear explicitly — out of scope here.

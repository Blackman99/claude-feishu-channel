# Phase 7: Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Claude session state across restarts — capture `session_id` from the SDK stream, write session records to `state.json` (immediate + debounced), load on startup with TTL cleanup, send crash recovery notifications, and add `/sessions` and `/resume` commands.

**Architecture:** `ClaudeSession` captures `session_id` from the first SDK message and passes a `resume` option on subsequent turns. `ClaudeSessionManager` owns the persistence lifecycle — it holds a `StateStore` reference, maintains a `staleRecords` map for lazy resume on startup, debounces `lastActiveAt` writes, and provides `findSession` / `getAllSessions` for the new commands. The router/dispatcher extend with two new commands.

**Tech Stack:** TypeScript, Vitest, Zod, existing `StateStore` + `state.json` format

---

### Task 1: Config extension — `session_ttl_days`

**Files:**
- Modify: `src/config.ts:50-58` — add `session_ttl_days` to `PersistenceSchema`
- Modify: `src/config.ts:146-148` — map to `AppConfig.persistence.sessionTtlDays`
- Modify: `src/types.ts:60-63` — add `sessionTtlDays: number` to persistence type
- Modify: `config.example.toml:80-83` — add example line
- Test: `test/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/unit/config.test.ts`, add tests for the new field:

```ts
it("parses session_ttl_days from TOML", async () => {
  const toml = buildToml({ persistence: { session_ttl_days: 7 } });
  const cfg = await loadFromString(toml);
  expect(cfg.persistence.sessionTtlDays).toBe(7);
});

it("defaults session_ttl_days to 30 when omitted", async () => {
  const toml = buildToml({});
  const cfg = await loadFromString(toml);
  expect(cfg.persistence.sessionTtlDays).toBe(30);
});
```

Use the existing test helper pattern (write a temp TOML file, call `loadConfig`). If the test file already uses a `buildToml` helper, extend it. Otherwise, add the persistence override to the minimal valid TOML fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/config.test.ts`
Expected: FAIL — `sessionTtlDays` property does not exist

- [ ] **Step 3: Add `sessionTtlDays` to `AppConfig` type**

In `src/types.ts`, add to the `persistence` block:

```ts
persistence: {
  stateFile: string;
  logDir: string;
  sessionTtlDays: number;
};
```

- [ ] **Step 4: Add `session_ttl_days` to Zod schema and mapping**

In `src/config.ts`, update `PersistenceSchema`:

```ts
const PersistenceSchema = z
  .object({
    state_file: z.string().default("~/.claude-feishu-channel/state.json"),
    log_dir: z.string().default("~/.claude-feishu-channel/logs"),
    session_ttl_days: z.number().int().positive().default(30),
  })
  .default({
    state_file: "~/.claude-feishu-channel/state.json",
    log_dir: "~/.claude-feishu-channel/logs",
    session_ttl_days: 30,
  });
```

In the `loadConfig` return value, add to the `persistence` block:

```ts
persistence: {
  stateFile: expandHome(data.persistence.state_file),
  logDir: expandHome(data.persistence.log_dir),
  sessionTtlDays: data.persistence.session_ttl_days,
},
```

- [ ] **Step 5: Add example to `config.example.toml`**

After the `log_dir` line in `[persistence]`:

```toml
# How many days to keep session records before cleanup. Sessions older
# than this are pruned on startup.
session_ttl_days = 30
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/config.test.ts`
Expected: PASS

- [ ] **Step 7: Fix any type errors across the codebase**

Run: `pnpm typecheck`
Expected: Clean. The new required field `sessionTtlDays` may cause errors in test files that construct `AppConfig` literals — fix them by adding `sessionTtlDays: 30` to those fixtures.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/types.ts config.example.toml test/unit/config.test.ts
git commit -m "feat(config): add session_ttl_days persistence setting"
```

---

### Task 2: SDK message + query options extension — `session_id` and `resume`

**Files:**
- Modify: `src/claude/session.ts:35-44` — add `session_id?: string` to `SDKMessageLike`
- Modify: `src/claude/query-handle.ts:5-24` — add `resume?: string` to `ClaudeQueryOptions`
- Modify: `src/claude/sdk-query.ts:46-62` — forward `resume` to SDK `query()` options
- Test: `test/unit/claude/query-handle.test.ts` (if type-level only, typecheck suffices)

- [ ] **Step 1: Add `session_id` to `SDKMessageLike`**

In `src/claude/session.ts`, update the interface:

```ts
export interface SDKMessageLike {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: readonly SDKContentBlock[] };
  result?: string;
  errors?: readonly string[];
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  session_id?: string;
}
```

- [ ] **Step 2: Add `resume` to `ClaudeQueryOptions`**

In `src/claude/query-handle.ts`, add after `disallowedTools`:

```ts
/**
 * SDK session ID to resume. When set, the SDK continues an
 * existing conversation rather than starting a new one. Phase 7
 * sets this from the captured `session_id` so turns after a
 * restart resume the same Claude conversation.
 */
resume?: string;
```

- [ ] **Step 3: Forward `resume` in `createSdkQueryFn`**

In `src/claude/sdk-query.ts`, add `resume` to the `query()` options object (inside the `q = query({...})` call):

```ts
const q = query({
  prompt: params.prompt,
  options: {
    cwd: params.options.cwd,
    model: params.options.model,
    permissionMode: params.options.permissionMode,
    settingSources: params.options.settingSources as ("project" | "user" | "local")[],
    canUseTool: params.canUseTool,
    pathToClaudeCodeExecutable: opts.cliPath,
    abortController: abort,
    env: { ...process.env },
    ...(params.options.resume ? { resume: params.options.resume } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(params.options.disallowedTools
      ? { disallowedTools: [...params.options.disallowedTools] }
      : {}),
  },
});
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: Clean

- [ ] **Step 5: Run all tests**

Run: `pnpm test`
Expected: All pass — these are additive optional fields

- [ ] **Step 6: Commit**

```bash
git add src/claude/session.ts src/claude/query-handle.ts src/claude/sdk-query.ts
git commit -m "feat(sdk): add session_id to SDKMessageLike and resume to query options"
```

---

### Task 3: Session `session_id` capture + `resume` passthrough

**Files:**
- Modify: `src/claude/session.ts:82-90` — add `onSessionIdCaptured` to options
- Modify: `src/claude/session.ts` (class body) — add `claudeSessionId` field
- Modify: `src/claude/session.ts:71-80` — add `claudeSessionId` to `SessionStatus`
- Modify: `src/claude/session.ts:491-520` — capture `session_id` in `runTurn`
- Modify: `src/claude/session.ts:450-461` — pass `resume` in processLoop
- Test: `test/unit/claude/session-state-machine.test.ts`

- [ ] **Step 1: Write failing tests for `session_id` capture**

Add to `test/unit/claude/session-state-machine.test.ts`:

```ts
describe("ClaudeSession — session_id capture (Phase 7)", () => {
  it("captures session_id from the first SDK message that carries it", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    const outcome = await h.session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    // First message without session_id — should not capture
    fake.emitMessage({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } });
    expect(h.session.getStatus().claudeSessionId).toBeUndefined();

    // Second message WITH session_id — should capture
    fake.emitMessage({
      type: "assistant",
      session_id: "ses_abc123",
      message: { content: [{ type: "text", text: "b" }] },
    });
    await flushMicrotasks();
    expect(h.session.getStatus().claudeSessionId).toBe("ses_abc123");

    fake.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
    if (outcome.kind !== "started") throw new Error("unreachable");
    await outcome.done;
  });

  it("does not overwrite session_id once captured", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    const outcome = await h.session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    fake.emitMessage({ type: "assistant", session_id: "ses_first", message: { content: [{ type: "text", text: "a" }] } });
    fake.emitMessage({ type: "assistant", session_id: "ses_second", message: { content: [{ type: "text", text: "b" }] } });
    await flushMicrotasks();

    expect(h.session.getStatus().claudeSessionId).toBe("ses_first");

    fake.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
    if (outcome.kind !== "started") throw new Error("unreachable");
    await outcome.done;
  });

  it("fires onSessionIdCaptured callback once on first capture", async () => {
    const calls: string[] = [];
    const h = makeHarness({ onSessionIdCaptured: () => calls.push("captured") });
    const spy = new SpyRenderer();

    const outcome = await h.session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();
    const fake = h.fakes[0]!;

    fake.emitMessage({ type: "assistant", session_id: "ses_x", message: { content: [{ type: "text", text: "a" }] } });
    fake.emitMessage({ type: "assistant", session_id: "ses_y", message: { content: [{ type: "text", text: "b" }] } });
    await flushMicrotasks();

    expect(calls).toEqual(["captured"]);

    fake.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
    if (outcome.kind !== "started") throw new Error("unreachable");
    await outcome.done;
  });

  it("passes resume option to queryFn when claudeSessionId is set", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    // Turn 1: capture session_id
    const o1 = await h.session.submit(
      { kind: "run", text: "turn1", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();
    h.fakes[0]!.emitMessage({ type: "assistant", session_id: "ses_resume", message: { content: [{ type: "text", text: "ok" }] } });
    h.fakes[0]!.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
    if (o1.kind !== "started") throw new Error("unreachable");
    await o1.done;

    // Turn 2: should have resume set
    const o2 = await h.session.submit(
      { kind: "run", text: "turn2", senderOpenId: "ou_test", parentMessageId: "om_test2" },
      spy.emit,
    );
    await flushMicrotasks();
    expect(h.fakes[1]!.options.resume).toBe("ses_resume");

    h.fakes[1]!.emitMessage({ type: "assistant", session_id: "ses_resume", message: { content: [{ type: "text", text: "ok2" }] } });
    h.fakes[1]!.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
    if (o2.kind !== "started") throw new Error("unreachable");
    await o2.done;
  });

  it("does not pass resume when claudeSessionId is not yet captured", async () => {
    const h = makeHarness();
    const spy = new SpyRenderer();

    await h.session.submit(
      { kind: "run", text: "turn1", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();

    expect(h.fakes[0]!.options.resume).toBeUndefined();

    h.fakes[0]!.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
  });
});
```

The `makeHarness` function needs to accept optional `onSessionIdCaptured`. Update the harness:

```ts
function makeHarness(overrides?: { onSessionIdCaptured?: () => void }): Harness {
  // ... existing code ...
  const opts: ClaudeSessionOptions = {
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    clock,
    permissionBroker: new FakePermissionBroker(),
    questionBroker,
    logger: SILENT_LOGGER,
    onSessionIdCaptured: overrides?.onSessionIdCaptured,
  };
  return { session: new ClaudeSession(opts), fakes, queryFn, clock };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: FAIL — `claudeSessionId` not on `SessionStatus`, `onSessionIdCaptured` not in options

- [ ] **Step 3: Implement session_id capture**

In `src/claude/session.ts`:

1. Add to `ClaudeSessionOptions`:
```ts
export interface ClaudeSessionOptions {
  // ...existing fields...
  onSessionIdCaptured?: () => void;
}
```

2. Add to `SessionStatus`:
```ts
export interface SessionStatus {
  // ...existing fields...
  claudeSessionId?: string;
}
```

3. Add private field in `ClaudeSession` class (near the top of private fields):
```ts
private claudeSessionId?: string;
private readonly onSessionIdCaptured?: () => void;
```

4. In the constructor, store the callback:
```ts
this.onSessionIdCaptured = opts.onSessionIdCaptured;
```

5. In `getStatus()`, add `claudeSessionId`:
```ts
getStatus(): SessionStatus {
  return {
    // ...existing fields...
    claudeSessionId: this.claudeSessionId,
  };
}
```

6. In `runTurn`, inside the `for await (const msg of handle.messages)` loop, BEFORE the existing `if (msg.type === "assistant" ...)` block, add session_id capture:
```ts
if (msg.session_id && !this.claudeSessionId) {
  this.claudeSessionId = msg.session_id;
  this.onSessionIdCaptured?.();
}
```

7. In `processLoop`, when building the queryFn call, add `resume`:
```ts
const handle = this.queryFn({
  prompt: next.text,
  options: {
    cwd: this.config.defaultCwd,
    model: this.modelOverride ?? this.config.defaultModel,
    permissionMode,
    settingSources: ["user", "project"],
    mcpServers: [askUserMcp],
    disallowedTools: ["AskUserQuestion"],
    resume: this.claudeSessionId,
  },
  canUseTool: this.buildCanUseToolClosure(next),
});
```

8. Add a public setter for use by SessionManager during lazy resume:
```ts
/** Set the Claude session ID for resume. Used by SessionManager during lazy restore. */
setClaudeSessionId(id: string): void {
  this.claudeSessionId = id;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/claude/session.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(session): capture session_id from SDK stream and pass resume on subsequent turns"
```

---

### Task 4: SessionManager persistence — StateStore integration, staleRecords, debounced writes

**Files:**
- Modify: `src/claude/session-manager.ts` — major expansion
- Test: `test/unit/claude/session-manager.test.ts`

This is the largest task. It adds:
- `stateStore` and `feishuClient` dependencies
- `staleRecords` map for lazy resume
- `startupLoad()` method with TTL cleanup
- Immediate save (Scenario A) for structural changes
- Debounced save (Scenario B) for `lastActiveAt` heartbeat
- `findSession()` and `getAllSessions()` query methods
- `buildSnapshot()` to construct the sessions record from live state
- Crash recovery notifications

- [ ] **Step 1: Write failing tests for startup load and TTL cleanup**

Add to `test/unit/claude/session-manager.test.ts`:

```ts
import { StateStore, type State, type SessionRecord } from "../../../src/persistence/state-store.js";

// Fake StateStore that works in memory
class FakeStateStore {
  state: State = { version: 1, lastCleanShutdown: true, sessions: {} };
  saveCount = 0;
  lastSaved: State | null = null;

  async load(): Promise<State> {
    return structuredClone(this.state);
  }
  async save(s: State): Promise<void> {
    this.lastSaved = structuredClone(s);
    this.saveCount++;
  }
  async markUncleanAtStartup(s: State): Promise<void> {
    s.lastCleanShutdown = false;
  }
  async markCleanShutdown(s: State): Promise<void> {
    s.lastCleanShutdown = true;
  }
}

// Fake FeishuClient with just sendText
class FakeFeishuClient {
  sentTexts: Array<{ chatId: string; text: string }> = [];
  async sendText(chatId: string, text: string) {
    this.sentTexts.push({ chatId, text });
    return { messageId: "om_fake" };
  }
}

describe("ClaudeSessionManager — persistence (Phase 7)", () => {
  it("startupLoad populates staleRecords from state.sessions", async () => {
    const store = new FakeStateStore();
    store.state.sessions = {
      oc_1: {
        claudeSessionId: "ses_1",
        cwd: "/proj/a",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        permissionMode: "default",
        model: "claude-opus-4-6",
      },
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();

    const all = mgr.getAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0]!.chatId).toBe("oc_1");
    expect(all[0]!.active).toBe(false);
  });

  it("startupLoad prunes sessions older than TTL", async () => {
    const store = new FakeStateStore();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    store.state.sessions = {
      oc_old: {
        claudeSessionId: "ses_old",
        cwd: "/old",
        createdAt: old,
        lastActiveAt: old,
      },
      oc_fresh: {
        claudeSessionId: "ses_fresh",
        cwd: "/fresh",
        createdAt: fresh,
        lastActiveAt: fresh,
      },
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();

    const all = mgr.getAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0]!.chatId).toBe("oc_fresh");
  });

  it("getOrCreate uses stale record for cwd/mode/model when available", async () => {
    const store = new FakeStateStore();
    store.state.sessions = {
      oc_1: {
        claudeSessionId: "ses_1",
        cwd: "/restored/path",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        permissionMode: "acceptEdits",
        model: "claude-sonnet-4-6",
      },
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();

    const session = mgr.getOrCreate("oc_1");
    const status = session.getStatus();
    expect(status.cwd).toBe("/restored/path");
    expect(status.permissionMode).toBe("acceptEdits");
    expect(status.model).toBe("claude-sonnet-4-6");
    expect(status.claudeSessionId).toBe("ses_1");
  });

  it("cwdOverride takes priority over stale record cwd", async () => {
    const store = new FakeStateStore();
    store.state.sessions = {
      oc_1: {
        claudeSessionId: "ses_1",
        cwd: "/stale/path",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      },
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();
    mgr.setCwdOverride("oc_1", "/override/path");

    const session = mgr.getOrCreate("oc_1");
    expect(session.getStatus().cwd).toBe("/override/path");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/claude/session-manager.test.ts`
Expected: FAIL — `stateStore`, `feishuClient`, `sessionTtlDays` not in options; `startupLoad`, `getAllSessions` not on manager

- [ ] **Step 3: Write failing tests for immediate and debounced save**

Add more tests:

```ts
describe("ClaudeSessionManager — save triggers (Phase 7)", () => {
  it("onSessionIdCaptured triggers immediate save", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = new FakeFeishuClient();
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fake.options = params.options;
      fakes.push(fake);
      return fake as any;
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: fakeFeishu as any,
      sessionTtlDays: 30,
    });

    const session = mgr.getOrCreate("oc_1");
    const spy = new SpyRenderer();
    await session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();

    expect(store.saveCount).toBe(0);
    fakes[0]!.emitMessage({ type: "assistant", session_id: "ses_new", message: { content: [{ type: "text", text: "ok" }] } });
    await flushMicrotasks();
    expect(store.saveCount).toBe(1);

    fakes[0]!.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
  });

  it("delete triggers immediate save", async () => {
    const store = new FakeStateStore();
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    mgr.getOrCreate("oc_1");
    store.saveCount = 0;

    mgr.delete("oc_1");
    await flushMicrotasks();
    expect(store.saveCount).toBe(1);
  });

  it("turn completion triggers debounced save at 30s", async () => {
    const clock = new FakeClock();
    const store = new FakeStateStore();
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fake.options = params.options;
      fakes.push(fake);
      return fake as any;
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock,
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });

    const session = mgr.getOrCreate("oc_1");
    const spy = new SpyRenderer();
    const outcome = await session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();

    fakes[0]!.emitMessage({ type: "assistant", session_id: "ses_1", message: { content: [{ type: "text", text: "ok" }] } });
    await flushMicrotasks();
    const saveAfterCapture = store.saveCount; // immediate save from capture

    fakes[0]!.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
    if (outcome.kind !== "started") throw new Error("unreachable");
    await outcome.done;
    await flushMicrotasks();

    // Turn complete but 30s not elapsed yet — no additional save
    expect(store.saveCount).toBe(saveAfterCapture);

    // Advance clock past 30s
    clock.advance(31_000);
    await flushMicrotasks();
    expect(store.saveCount).toBe(saveAfterCapture + 1);
  });

  it("immediate save cancels pending debounced save", async () => {
    const clock = new FakeClock();
    const store = new FakeStateStore();
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock,
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    mgr.getOrCreate("oc_1");
    store.saveCount = 0;

    // Schedule debounced save
    mgr.scheduleDebouncedSave();
    // Immediate save via delete
    mgr.delete("oc_1");
    await flushMicrotasks();
    const countAfterDelete = store.saveCount;

    // Advance past 30s — debounced should have been cancelled
    clock.advance(31_000);
    await flushMicrotasks();
    expect(store.saveCount).toBe(countAfterDelete);
  });
});

describe("ClaudeSessionManager — findSession and getAllSessions (Phase 7)", () => {
  it("findSession matches by claudeSessionId in active sessions", async () => {
    const store = new FakeStateStore();
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fake.options = params.options;
      fakes.push(fake);
      return fake as any;
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });

    const session = mgr.getOrCreate("oc_1");
    const spy = new SpyRenderer();
    const o = await session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();
    fakes[0]!.emitMessage({ type: "assistant", session_id: "ses_find_me", message: { content: [{ type: "text", text: "ok" }] } });
    fakes[0]!.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
    if (o.kind !== "started") throw new Error("unreachable");
    await o.done;

    const found = mgr.findSession("ses_find_me");
    expect(found).toBeDefined();
    expect(found!.chatId).toBe("oc_1");
  });

  it("findSession matches by chatId", () => {
    const store = new FakeStateStore();
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    mgr.getOrCreate("oc_1");
    const found = mgr.findSession("oc_1");
    expect(found).toBeDefined();
    expect(found!.chatId).toBe("oc_1");
  });

  it("findSession matches staleRecords by chatId", async () => {
    const store = new FakeStateStore();
    store.state.sessions = {
      oc_stale: {
        claudeSessionId: "ses_stale",
        cwd: "/stale",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      },
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();

    const found = mgr.findSession("oc_stale");
    expect(found).toBeDefined();
    expect(found!.record.claudeSessionId).toBe("ses_stale");
  });

  it("findSession returns undefined for unknown target", () => {
    const store = new FakeStateStore();
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    expect(mgr.findSession("nonexistent")).toBeUndefined();
  });

  it("getAllSessions merges active + stale", async () => {
    const store = new FakeStateStore();
    store.state.sessions = {
      oc_stale: {
        claudeSessionId: "ses_stale",
        cwd: "/stale",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      },
    };
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: new FakeFeishuClient() as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();

    // Create an active session
    mgr.getOrCreate("oc_active");

    const all = mgr.getAllSessions();
    expect(all).toHaveLength(2);
    const stale = all.find(s => s.chatId === "oc_stale");
    const active = all.find(s => s.chatId === "oc_active");
    expect(stale).toBeDefined();
    expect(stale!.active).toBe(false);
    expect(active).toBeDefined();
    expect(active!.active).toBe(true);
  });
});
```

You will need to import `FakeQueryHandle` and `SpyRenderer` in this test file:
```ts
import { FakeQueryHandle } from "./fakes/fake-query-handle.js";
import { SpyRenderer } from "./fakes/spy-renderer.js";
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/claude/session-manager.test.ts`
Expected: FAIL

- [ ] **Step 5: Implement the expanded SessionManager**

Rewrite `src/claude/session-manager.ts`:

```ts
import type { Logger } from "pino";
import { ClaudeSession, type QueryFn } from "./session.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { QuestionBroker } from "./question-broker.js";
import type { AppConfig } from "../types.js";
import type { StateStore, SessionRecord, State } from "../persistence/state-store.js";
import type { FeishuClient } from "../feishu/client.js";

export interface ClaudeSessionManagerOptions {
  config: AppConfig["claude"];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  logger: Logger;
  stateStore: StateStore;
  feishuClient: FeishuClient;
  sessionTtlDays: number;
}

const DEBOUNCE_MS = 30_000;

export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly cwdOverrides = new Map<string, string>();
  private readonly staleRecords = new Map<string, SessionRecord>();
  private readonly opts: ClaudeSessionManagerOptions;
  private debounceTimer: TimeoutHandle | null = null;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  /** Load persisted sessions from state.json and apply TTL cleanup. */
  async startupLoad(): Promise<void> {
    const state = await this.opts.stateStore.load();
    const now = Date.now();
    const ttlMs = this.opts.sessionTtlDays * 24 * 60 * 60 * 1000;

    for (const [chatId, record] of Object.entries(state.sessions)) {
      const lastActive = new Date(record.lastActiveAt).getTime();
      if (now - lastActive > ttlMs) continue; // expired — skip
      this.staleRecords.set(chatId, record);
    }

    // Save cleaned state
    await this.saveNow();
  }

  /**
   * Check for crash recovery conditions and send notifications.
   * Call after startupLoad.
   */
  async crashRecovery(lastCleanShutdown: boolean): Promise<void> {
    if (lastCleanShutdown) return;

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [chatId, record] of this.staleRecords) {
      const lastActive = new Date(record.lastActiveAt).getTime();
      if (lastActive < oneHourAgo) continue;

      try {
        await this.opts.feishuClient.sendText(
          chatId,
          "⚠️ 上次 bot 异常重启，已恢复会话。请检查上一轮的执行结果是否完整",
        );
      } catch (err) {
        this.opts.logger.warn(
          { err, chatId },
          "Crash recovery notification failed",
        );
      }
    }
  }

  getOrCreate(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (session !== undefined) return session;

    const stale = this.staleRecords.get(chatId);
    const cwdOverride = this.cwdOverrides.get(chatId);

    let cwd: string;
    let permissionMode: AppConfig["claude"]["defaultPermissionMode"] | undefined;
    let model: string | undefined;
    let claudeSessionId: string | undefined;

    if (stale) {
      cwd = cwdOverride ?? stale.cwd;
      permissionMode = stale.permissionMode as AppConfig["claude"]["defaultPermissionMode"] | undefined;
      model = stale.model;
      claudeSessionId = stale.claudeSessionId;
      this.staleRecords.delete(chatId);
    } else {
      cwd = cwdOverride ?? this.opts.config.defaultCwd;
    }

    session = new ClaudeSession({
      chatId,
      config: { ...this.opts.config, defaultCwd: cwd },
      queryFn: this.opts.queryFn,
      clock: this.opts.clock,
      permissionBroker: this.opts.permissionBroker,
      questionBroker: this.opts.questionBroker,
      logger: this.opts.logger,
      onSessionIdCaptured: () => this.saveNow(),
      onTurnComplete: () => this.scheduleDebouncedSave(),
    });

    if (permissionMode) {
      session.setPermissionModeOverride(permissionMode);
    }
    if (model) {
      session.setModelOverride(model);
    }
    if (claudeSessionId) {
      session.setClaudeSessionId(claudeSessionId);
    }

    this.sessions.set(chatId, session);
    return session;
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
    this.staleRecords.delete(chatId);
    void this.saveNow();
  }

  setCwdOverride(chatId: string, cwd: string): void {
    this.cwdOverrides.set(chatId, cwd);
  }

  findSession(target: string): { chatId: string; record: SessionRecord } | undefined {
    // Search active sessions by claudeSessionId
    for (const [chatId, session] of this.sessions) {
      const status = session.getStatus();
      if (status.claudeSessionId === target) {
        return { chatId, record: this.statusToRecord(status) };
      }
    }
    // Search stale records by claudeSessionId
    for (const [chatId, record] of this.staleRecords) {
      if (record.claudeSessionId === target) {
        return { chatId, record };
      }
    }
    // Search by chatId in active sessions
    if (this.sessions.has(target)) {
      const status = this.sessions.get(target)!.getStatus();
      return { chatId: target, record: this.statusToRecord(status) };
    }
    // Search by chatId in stale records
    if (this.staleRecords.has(target)) {
      return { chatId: target, record: this.staleRecords.get(target)! };
    }
    return undefined;
  }

  getAllSessions(): Array<{ chatId: string; record: SessionRecord; active: boolean }> {
    const result: Array<{ chatId: string; record: SessionRecord; active: boolean }> = [];

    for (const [chatId, session] of this.sessions) {
      result.push({
        chatId,
        record: this.statusToRecord(session.getStatus()),
        active: true,
      });
    }
    for (const [chatId, record] of this.staleRecords) {
      result.push({ chatId, record, active: false });
    }
    return result;
  }

  /** Flush any pending debounced save immediately. Call on shutdown. */
  async flushPendingSave(): Promise<void> {
    if (this.debounceTimer !== null) {
      this.opts.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      await this.saveNow();
    }
  }

  /** Build the current sessions snapshot for StateStore. */
  buildSessionsSnapshot(): Record<string, SessionRecord> {
    const sessions: Record<string, SessionRecord> = {};

    for (const [chatId, session] of this.sessions) {
      const status = session.getStatus();
      if (!status.claudeSessionId) continue; // not yet captured
      sessions[chatId] = this.statusToRecord(status);
    }
    for (const [chatId, record] of this.staleRecords) {
      sessions[chatId] = record;
    }
    return sessions;
  }

  /** Schedule a debounced save (30s). Resets if called again within the window. */
  scheduleDebouncedSave(): void {
    if (this.debounceTimer !== null) {
      this.opts.clock.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = this.opts.clock.setTimeout(() => {
      this.debounceTimer = null;
      void this.saveNow();
    }, DEBOUNCE_MS);
  }

  private async saveNow(): Promise<void> {
    // Cancel any pending debounced save
    if (this.debounceTimer !== null) {
      this.opts.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const state: State = {
      version: 1,
      lastCleanShutdown: false,
      sessions: this.buildSessionsSnapshot(),
    };
    try {
      await this.opts.stateStore.save(state);
    } catch (err) {
      this.opts.logger.error({ err }, "Failed to persist session state");
    }
  }

  private statusToRecord(status: {
    claudeSessionId?: string;
    cwd: string;
    permissionMode: string;
    model: string;
  }): SessionRecord {
    return {
      claudeSessionId: status.claudeSessionId ?? "",
      cwd: status.cwd,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: status.permissionMode,
      model: status.model,
    };
  }
}
```

- [ ] **Step 6: Add `onTurnComplete` callback to `ClaudeSession`**

In `src/claude/session.ts`:

1. Add to `ClaudeSessionOptions`:
```ts
onTurnComplete?: () => void;
```

2. Store in the class:
```ts
private readonly onTurnComplete?: () => void;
```

3. In constructor:
```ts
this.onTurnComplete = opts.onTurnComplete;
```

4. In `runTurn`, after the `this.turnCount++` / token accumulation lines (around line 548-550), add:
```ts
this.onTurnComplete?.();
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/claude/session-manager.test.ts`
Expected: PASS

- [ ] **Step 8: Run full suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: Clean. Some existing tests may need the new required `stateStore`/`feishuClient`/`sessionTtlDays` options. Fix by adding the FakeStateStore and FakeFeishuClient, or by making those options optional with defaults.

**Decision:** Make `stateStore`, `feishuClient`, and `sessionTtlDays` optional in `ClaudeSessionManagerOptions` to avoid breaking existing tests. When absent, persistence is a no-op (the Phase 2 behavior). This way existing tests continue to work unchanged:

```ts
export interface ClaudeSessionManagerOptions {
  config: AppConfig["claude"];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  logger: Logger;
  stateStore?: StateStore;
  feishuClient?: FeishuClient;
  sessionTtlDays?: number;
}
```

Guard all persistence operations with `if (!this.opts.stateStore) return;`.

- [ ] **Step 9: Commit**

```bash
git add src/claude/session-manager.ts src/claude/session.ts test/unit/claude/session-manager.test.ts
git commit -m "feat(session-manager): add StateStore persistence, staleRecords, debounced save, TTL cleanup, findSession/getAllSessions"
```

---

### Task 5: Crash recovery notifications

**Files:**
- Modify: `src/claude/session-manager.ts` — `crashRecovery` method (already added in Task 4)
- Test: `test/unit/claude/session-manager.test.ts`

- [ ] **Step 1: Write failing tests for crash recovery**

Add to `test/unit/claude/session-manager.test.ts`:

```ts
describe("ClaudeSessionManager — crash recovery (Phase 7)", () => {
  it("sends notification to recently active sessions on unclean shutdown", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = new FakeFeishuClient();
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    store.state.sessions = {
      oc_recent: {
        claudeSessionId: "ses_1",
        cwd: "/proj",
        createdAt: recentTime,
        lastActiveAt: recentTime,
      },
    };
    store.state.lastCleanShutdown = false;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: fakeFeishu as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();
    await mgr.crashRecovery(false);

    expect(fakeFeishu.sentTexts).toHaveLength(1);
    expect(fakeFeishu.sentTexts[0]!.chatId).toBe("oc_recent");
    expect(fakeFeishu.sentTexts[0]!.text).toContain("异常重启");
  });

  it("does NOT send notification when lastCleanShutdown is true", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = new FakeFeishuClient();
    store.state.sessions = {
      oc_recent: {
        claudeSessionId: "ses_1",
        cwd: "/proj",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      },
    };
    store.state.lastCleanShutdown = true;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: fakeFeishu as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();
    await mgr.crashRecovery(true);

    expect(fakeFeishu.sentTexts).toHaveLength(0);
  });

  it("skips sessions inactive for more than 1 hour", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = new FakeFeishuClient();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    store.state.sessions = {
      oc_old: {
        claudeSessionId: "ses_1",
        cwd: "/proj",
        createdAt: twoHoursAgo,
        lastActiveAt: twoHoursAgo,
      },
    };
    store.state.lastCleanShutdown = false;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: fakeFeishu as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();
    await mgr.crashRecovery(false);

    expect(fakeFeishu.sentTexts).toHaveLength(0);
  });

  it("sendText failure does not throw — logs warning and continues", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = {
      sendText: async () => { throw new Error("network error"); },
    };
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    store.state.sessions = {
      oc_1: {
        claudeSessionId: "ses_1",
        cwd: "/proj",
        createdAt: recentTime,
        lastActiveAt: recentTime,
      },
    };

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as any,
      feishuClient: fakeFeishu as any,
      sessionTtlDays: 30,
    });
    await mgr.startupLoad();

    // Should not throw
    await expect(mgr.crashRecovery(false)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/claude/session-manager.test.ts`
Expected: PASS (crashRecovery was already implemented in Task 4)

- [ ] **Step 3: Commit**

```bash
git add test/unit/claude/session-manager.test.ts
git commit -m "test(session-manager): add crash recovery notification tests"
```

---

### Task 6: Router extension — `/sessions` and `/resume`

**Files:**
- Modify: `src/commands/router.ts:7-15` — extend `ParsedCommand`
- Modify: `src/commands/router.ts:48-58` — extend `KNOWN_COMMANDS`
- Modify: `src/commands/router.ts:128-157` — extend `parseCommand`
- Test: `test/unit/commands/router.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/unit/commands/router.test.ts`:

```ts
describe("/sessions", () => {
  it("parses /sessions as a command", () => {
    const result = parseInput("/sessions");
    expect(result).toEqual({ kind: "command", cmd: { name: "sessions" } });
  });

  it("parses /sessions with trailing whitespace", () => {
    const result = parseInput("/sessions  ");
    expect(result).toEqual({ kind: "command", cmd: { name: "sessions" } });
  });
});

describe("/resume", () => {
  it("parses /resume <id> as a command with target", () => {
    const result = parseInput("/resume ses_abc123");
    expect(result).toEqual({
      kind: "command",
      cmd: { name: "resume", target: "ses_abc123" },
    });
  });

  it("trims target whitespace", () => {
    const result = parseInput("/resume  ses_abc123  ");
    expect(result).toEqual({
      kind: "command",
      cmd: { name: "resume", target: "ses_abc123" },
    });
  });

  it("/resume without argument is unknown_command", () => {
    const result = parseInput("/resume");
    expect(result).toEqual({ kind: "unknown_command", raw: "/resume" });
  });

  it("/resume with empty arg is unknown_command", () => {
    const result = parseInput("/resume   ");
    expect(result).toEqual({ kind: "unknown_command", raw: "/resume   " });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/commands/router.test.ts`
Expected: FAIL — `sessions` and `resume` not recognized

- [ ] **Step 3: Implement router changes**

In `src/commands/router.ts`:

1. Extend `ParsedCommand`:
```ts
export type ParsedCommand =
  | { name: "new" }
  | { name: "cd"; path: string }
  | { name: "project"; alias: string }
  | { name: "mode"; mode: PermissionMode }
  | { name: "model"; model: string }
  | { name: "status" }
  | { name: "help" }
  | { name: "config_show" }
  | { name: "sessions" }
  | { name: "resume"; target: string };
```

2. Add to `KNOWN_COMMANDS`:
```ts
const KNOWN_COMMANDS = new Set([
  "new", "cd", "project", "mode", "model",
  "status", "help", "config", "stop",
  "sessions", "resume",
]);
```

3. Add cases to `parseCommand`:
```ts
case "sessions":
  return { name: "sessions" };
case "resume":
  return rest ? { name: "resume", target: rest } : null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/commands/router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/router.ts test/unit/commands/router.test.ts
git commit -m "feat(router): add /sessions and /resume command parsing"
```

---

### Task 7: Dispatcher extension — `handleSessions` and `handleResume`

**Files:**
- Modify: `src/commands/dispatcher.ts:69-93` — add cases in `dispatch`
- Modify: `src/commands/dispatcher.ts` — add handler methods
- Modify: `src/commands/dispatcher.ts:39-47` — add `sessionManager` methods used
- Test: `test/unit/commands/dispatcher.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/unit/commands/dispatcher.test.ts`:

```ts
describe("/sessions", () => {
  it("replies with 'no sessions' when none exist", async () => {
    const { dispatcher, feishu } = makeDispatcherHarness();
    await dispatcher.dispatch({ name: "sessions" }, CTX);

    expect(feishu.repliedTexts).toHaveLength(1);
    expect(feishu.repliedTexts[0]!.text).toContain("暂无会话记录");
  });

  it("lists active sessions with chatId and cwd", async () => {
    const { dispatcher, feishu, sessionManager } = makeDispatcherHarness();
    sessionManager.getOrCreate("oc_1");

    await dispatcher.dispatch({ name: "sessions" }, CTX);

    expect(feishu.repliedTexts).toHaveLength(1);
    const text = feishu.repliedTexts[0]!.text;
    expect(text).toContain("oc_1");
    expect(text).toContain("active");
  });
});

describe("/resume", () => {
  it("replies with error when target is not found", async () => {
    const { dispatcher, feishu } = makeDispatcherHarness();
    await dispatcher.dispatch({ name: "resume", target: "nonexistent" }, CTX);

    expect(feishu.repliedTexts).toHaveLength(1);
    expect(feishu.repliedTexts[0]!.text).toContain("未找到会话");
  });

  it("replies with error when target is own chat", async () => {
    const { dispatcher, feishu, sessionManager } = makeDispatcherHarness();
    sessionManager.getOrCreate(CTX.chatId);

    await dispatcher.dispatch({ name: "resume", target: CTX.chatId }, CTX);

    expect(feishu.repliedTexts).toHaveLength(1);
    expect(feishu.repliedTexts[0]!.text).toContain("已经在该会话中");
  });

  it("refuses when session is not idle", async () => {
    const { dispatcher, feishu, sessionManager, fakes } = makeDispatcherHarness();

    // Start a turn so the session is generating
    const session = sessionManager.getOrCreate(CTX.chatId);
    const spy = new SpyRenderer();
    await session.submit(
      { kind: "run", text: "hi", senderOpenId: "ou_test", parentMessageId: "om_test" },
      spy.emit,
    );
    await flushMicrotasks();

    // Create another session to resume into
    sessionManager.getOrCreate("oc_other");

    await dispatcher.dispatch({ name: "resume", target: "oc_other" }, CTX);

    expect(feishu.repliedTexts).toHaveLength(1);
    expect(feishu.repliedTexts[0]!.text).toContain("正在执行中");

    // Clean up: finish the turn
    fakes[0]!.finishWithSuccess({ durationMs: 10, inputTokens: 1, outputTokens: 2 });
  });

  it("successfully resumes a session from another chat", async () => {
    const { dispatcher, feishu, sessionManager } = makeDispatcherHarness();

    // Ensure the target exists at a different chatId
    sessionManager.getOrCreate("oc_target");

    await dispatcher.dispatch({ name: "resume", target: "oc_target" }, {
      ...CTX,
      chatId: "oc_current",
    });

    expect(feishu.repliedTexts).toHaveLength(1);
    expect(feishu.repliedTexts[0]!.text).toContain("已恢复会话");
  });
});
```

Note: The test harness (`makeDispatcherHarness`) needs to be created or adapted from the existing test file's pattern. Look at how the existing tests construct a `CommandDispatcher` with a fake feishu client.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: FAIL — `sessions` and `resume` not handled in dispatch

- [ ] **Step 3: Implement the handlers**

In `src/commands/dispatcher.ts`:

1. Add cases to `dispatch`:
```ts
case "sessions":
  return this.handleSessions(ctx);
case "resume":
  return this.handleResume(cmd.target, ctx);
```

2. Add `handleSessions`:
```ts
private async handleSessions(ctx: CommandContext): Promise<void> {
  const all = this.sessionManager.getAllSessions();
  if (all.length === 0) {
    await this.feishu.replyText(ctx.parentMessageId, "暂无会话记录");
    return;
  }

  const lines = ["已知会话：", ""];
  for (const entry of all) {
    const short = entry.chatId.length > 16
      ? entry.chatId.slice(0, 16) + "…"
      : entry.chatId;
    const status = entry.active ? "active" : "stale";
    lines.push(
      `  ${short}  ${entry.record.cwd}  ${entry.record.model ?? "-"}  ${status}`,
    );
  }
  await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
}
```

3. Add `handleResume`:
```ts
private async handleResume(target: string, ctx: CommandContext): Promise<void> {
  const session = this.sessionManager.getOrCreate(ctx.chatId);
  if (session.getState() !== "idle") {
    await this.feishu.replyText(
      ctx.parentMessageId,
      "会话正在执行中，请先发送 /stop 或等待完成",
    );
    return;
  }

  const found = this.sessionManager.findSession(target);
  if (!found) {
    await this.feishu.replyText(ctx.parentMessageId, `未找到会话 ${target}`);
    return;
  }
  if (found.chatId === ctx.chatId) {
    await this.feishu.replyText(ctx.parentMessageId, "已经在该会话中");
    return;
  }

  // Delete current session and create a stale record from found
  this.sessionManager.delete(ctx.chatId);
  // The findSession result gives us the record — we put it as a stale
  // record so getOrCreate will lazily restore it on the next message
  this.sessionManager.setStaleRecord(ctx.chatId, found.record);

  const shortId = found.record.claudeSessionId.length > 12
    ? found.record.claudeSessionId.slice(0, 12) + "…"
    : found.record.claudeSessionId;
  await this.feishu.replyText(
    ctx.parentMessageId,
    `已恢复会话 \`${shortId}\`, 工作目录: \`${found.record.cwd}\``,
  );
}
```

4. Add `setStaleRecord` to `ClaudeSessionManager`:
```ts
/** Allow the dispatcher to inject a stale record for lazy resume. */
setStaleRecord(chatId: string, record: SessionRecord): void {
  this.staleRecords.set(chatId, record);
  void this.saveNow();
}
```

- [ ] **Step 4: Update help text**

In the `handleHelp` method, add the new commands:

```ts
"  /sessions     — 列出所有已知会话",
"  /resume <id>  — 恢复到指定会话",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: PASS

- [ ] **Step 6: Run full suite**

Run: `pnpm typecheck && pnpm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/commands/dispatcher.ts src/claude/session-manager.ts test/unit/commands/dispatcher.test.ts
git commit -m "feat(commands): add /sessions and /resume command handlers"
```

---

### Task 8: Wire into `index.ts` — StateStore lifecycle, shutdown handlers

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update SessionManager construction in `index.ts`**

Pass `stateStore`, `feishuClient`, and `sessionTtlDays` to `ClaudeSessionManager`:

```ts
const sessionManager = new ClaudeSessionManager({
  config: config.claude,
  queryFn,
  clock,
  permissionBroker,
  questionBroker,
  logger,
  stateStore,
  feishuClient,
  sessionTtlDays: config.persistence.sessionTtlDays,
});
```

- [ ] **Step 2: Add startup load and crash recovery**

After constructing `sessionManager`, before `gateway.start()`:

```ts
await sessionManager.startupLoad();
await sessionManager.crashRecovery(state.lastCleanShutdown);
```

- [ ] **Step 3: Update shutdown handler to flush session state**

Update the `shutdown` function:

```ts
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  try {
    await sessionManager.flushPendingSave();
    const finalState: State = {
      version: 1,
      lastCleanShutdown: true,
      sessions: sessionManager.buildSessionsSnapshot(),
    };
    await stateStore.save(finalState);
  } catch (err) {
    logger.error({ err }, "Failed to save state on shutdown");
  }
  process.exit(0);
};
```

Add the `State` import:
```ts
import { StateStore, type State } from "./persistence/state-store.js";
```

- [ ] **Step 4: Update ready log message**

Change `"Phase 5 ready"` to `"Phase 7 ready"`.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: Clean

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): wire SessionManager to StateStore, startup load, crash recovery, and clean shutdown"
```

---

### Task 9: Final validation and polish

**Files:**
- All files from Tasks 1-8

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: Clean — zero errors

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (existing ~327 + ~25 new)

- [ ] **Step 3: Verify config.example.toml has the new field**

Run: `grep session_ttl_days config.example.toml`
Expected: Shows the `session_ttl_days = 30` line

- [ ] **Step 4: Review all dispatcher help text includes new commands**

Run: `grep -A2 'sessions\|resume' src/commands/dispatcher.ts`
Expected: Both `/sessions` and `/resume` appear in help text

- [ ] **Step 5: Verify exhaustiveness in dispatcher switch**

The `dispatch` method should have `default: { const _exhaustive: never = cmd; }` that catches any uncovered `ParsedCommand` variant. Verify it compiles — if you missed a case, TypeScript will error.

- [ ] **Step 6: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: phase 7 final polish and validation"
```

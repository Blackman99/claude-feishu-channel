# Phase 6: Command Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 8 in-memory slash commands (/new /cd /project /mode /model /status /help /config show) with a CommandDispatcher pattern and /cd confirmation card.

**Architecture:** Extend `parseInput` to recognize commands, route them through a new `CommandDispatcher` class that holds one handler method per command. `/cd` uses a pending-confirm map + Feishu card (same click-to-update pattern as permission/question cards). Session gains runtime override fields for mode/model. SessionManager gains `delete()` and `cwdOverrides` map.

**Tech Stack:** TypeScript, vitest, Feishu Card v2, existing broker/card patterns

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/commands/dispatcher.ts` | CommandDispatcher class — one method per command, /cd pending-confirm map |
| `src/feishu/cards/cd-confirm-card.ts` | Card builders: pending/resolved/cancelled/timed-out variants |
| `test/unit/commands/dispatcher.test.ts` | Dispatcher unit tests |
| `test/unit/feishu/cards/cd-confirm-card.test.ts` | Card builder tests |

### Modified files
| File | Change |
|---|---|
| `src/commands/router.ts` | Extend union with `ParsedCommand`, `unknown_command`; add command parsing |
| `src/claude/session.ts` | Public `getState()`, override fields, `getStatus()`, turn/token counters |
| `src/claude/session-manager.ts` | `delete()`, `cwdOverrides` map, `getOrCreate` reads override |
| `src/config.ts` | Optional `projects` table |
| `src/types.ts` | `AppConfig.projects` field |
| `src/index.ts` | Construct dispatcher, route commands in `onMessage`, `cd_confirm` in `onCardAction` |
| `config.example.toml` | `[projects]` example section |
| `test/unit/commands/router.test.ts` | New command parsing tests |
| `test/unit/claude/session-state-machine.test.ts` | Override + stats tests |
| `test/unit/claude/session-manager.test.ts` | delete + cwdOverrides tests |

---

### Task 1: Extend command router with new command types

**Files:**
- Modify: `src/commands/router.ts`
- Test: `test/unit/commands/router.test.ts`

- [ ] **Step 1: Write failing tests for new command parsing**

Add these tests to `test/unit/commands/router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseInput } from "../../../src/commands/router.js";

// ... existing tests stay unchanged ...

describe("parseInput — Phase 6 commands", () => {
  it("/new → command new", () => {
    expect(parseInput("/new")).toEqual({
      kind: "command",
      cmd: { name: "new" },
    });
  });

  it("/NEW → command new (case-insensitive)", () => {
    expect(parseInput("/NEW")).toEqual({
      kind: "command",
      cmd: { name: "new" },
    });
  });

  it("/new with trailing whitespace → command new", () => {
    expect(parseInput("/new  ")).toEqual({
      kind: "command",
      cmd: { name: "new" },
    });
  });

  it("/cd /path/to/dir → command cd with path", () => {
    expect(parseInput("/cd /Users/me/projects")).toEqual({
      kind: "command",
      cmd: { name: "cd", path: "/Users/me/projects" },
    });
  });

  it("/cd ~/projects → command cd preserves tilde", () => {
    expect(parseInput("/cd ~/projects")).toEqual({
      kind: "command",
      cmd: { name: "cd", path: "~/projects" },
    });
  });

  it("/cd without argument → unknown_command", () => {
    expect(parseInput("/cd")).toEqual({
      kind: "unknown_command",
      raw: "/cd",
    });
    expect(parseInput("/cd   ")).toEqual({
      kind: "unknown_command",
      raw: "/cd   ",
    });
  });

  it("/project my-app → command project", () => {
    expect(parseInput("/project my-app")).toEqual({
      kind: "command",
      cmd: { name: "project", alias: "my-app" },
    });
  });

  it("/project without argument → unknown_command", () => {
    expect(parseInput("/project")).toEqual({
      kind: "unknown_command",
      raw: "/project",
    });
  });

  it("/mode default → command mode", () => {
    expect(parseInput("/mode default")).toEqual({
      kind: "command",
      cmd: { name: "mode", mode: "default" },
    });
  });

  it("/mode acceptEdits → command mode", () => {
    expect(parseInput("/mode acceptEdits")).toEqual({
      kind: "command",
      cmd: { name: "mode", mode: "acceptEdits" },
    });
  });

  it("/mode plan → command mode", () => {
    expect(parseInput("/mode plan")).toEqual({
      kind: "command",
      cmd: { name: "mode", mode: "plan" },
    });
  });

  it("/mode bypassPermissions → command mode", () => {
    expect(parseInput("/mode bypassPermissions")).toEqual({
      kind: "command",
      cmd: { name: "mode", mode: "bypassPermissions" },
    });
  });

  it("/mode badvalue → unknown_command", () => {
    expect(parseInput("/mode badvalue")).toEqual({
      kind: "unknown_command",
      raw: "/mode badvalue",
    });
  });

  it("/mode without argument → unknown_command", () => {
    expect(parseInput("/mode")).toEqual({
      kind: "unknown_command",
      raw: "/mode",
    });
  });

  it("/model sonnet → command model", () => {
    expect(parseInput("/model sonnet")).toEqual({
      kind: "command",
      cmd: { name: "model", model: "sonnet" },
    });
  });

  it("/model claude-opus-4-6 → command model", () => {
    expect(parseInput("/model claude-opus-4-6")).toEqual({
      kind: "command",
      cmd: { name: "model", model: "claude-opus-4-6" },
    });
  });

  it("/model without argument → unknown_command", () => {
    expect(parseInput("/model")).toEqual({
      kind: "unknown_command",
      raw: "/model",
    });
  });

  it("/status → command status", () => {
    expect(parseInput("/status")).toEqual({
      kind: "command",
      cmd: { name: "status" },
    });
  });

  it("/help → command help", () => {
    expect(parseInput("/help")).toEqual({
      kind: "command",
      cmd: { name: "help" },
    });
  });

  it("/config show → command config_show", () => {
    expect(parseInput("/config show")).toEqual({
      kind: "command",
      cmd: { name: "config_show" },
    });
  });

  it("/config without show → unknown_command", () => {
    expect(parseInput("/config")).toEqual({
      kind: "unknown_command",
      raw: "/config",
    });
    expect(parseInput("/config set foo bar")).toEqual({
      kind: "unknown_command",
      raw: "/config set foo bar",
    });
  });

  it("unknown /foo → unknown_command", () => {
    expect(parseInput("/foo")).toEqual({
      kind: "unknown_command",
      raw: "/foo",
    });
  });

  it("/etc/hosts → run (not a known command word)", () => {
    // Slash followed by a non-command word falls through to run
    expect(parseInput("/etc/hosts")).toEqual({
      kind: "run",
      text: "/etc/hosts",
    });
  });

  it("'/stop now' still falls through to run (existing behavior)", () => {
    expect(parseInput("/stop now")).toEqual({
      kind: "run",
      text: "/stop now",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/commands/router.test.ts`
Expected: New tests FAIL (parseInput doesn't return `command` or `unknown_command` kinds yet)

- [ ] **Step 3: Implement command parsing**

Replace `src/commands/router.ts` with:

```ts
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type ParsedCommand =
  | { name: "new" }
  | { name: "cd"; path: string }
  | { name: "project"; alias: string }
  | { name: "mode"; mode: PermissionMode }
  | { name: "model"; model: string }
  | { name: "status" }
  | { name: "help" }
  | { name: "config_show" };

export type CommandRouterResult =
  | { kind: "run"; text: string }
  | { kind: "stop" }
  | { kind: "interrupt_and_run"; text: string }
  | { kind: "command"; cmd: ParsedCommand }
  | { kind: "unknown_command"; raw: string };

const VALID_MODES = new Set<string>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

/** Command words that the parser recognizes after a leading `/`. */
const KNOWN_COMMANDS = new Set([
  "new",
  "cd",
  "project",
  "mode",
  "model",
  "status",
  "help",
  "config",
  "stop",
]);

export function parseInput(text: string): CommandRouterResult {
  // /stop (case-insensitive, optional trailing whitespace, nothing else)
  if (/^\/stop\s*$/i.test(text)) {
    return { kind: "stop" };
  }

  // ! prefix interrupt
  if (text.startsWith("!")) {
    let payload = text.slice(1);
    if (payload.startsWith(" ")) payload = payload.slice(1);
    if (payload.length > 0 && payload.trim().length > 0) {
      return { kind: "interrupt_and_run", text: payload };
    }
  }

  // Slash-command detection: /word at the start
  const slashMatch = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/i);
  if (slashMatch) {
    const word = slashMatch[1]!.toLowerCase();
    const rest = slashMatch[2]?.trim() ?? "";

    if (!KNOWN_COMMANDS.has(word)) {
      // Not a known command word — fall through to run so messages
      // like "/etc/hosts" reach Claude unmodified.
      return { kind: "run", text };
    }

    // /stop with trailing text already fell through above
    if (word === "stop") {
      return { kind: "run", text };
    }

    const cmd = parseCommand(word, rest, text);
    if (cmd) return { kind: "command", cmd };
    return { kind: "unknown_command", raw: text };
  }

  return { kind: "run", text };
}

function parseCommand(
  word: string,
  rest: string,
  raw: string,
): ParsedCommand | null {
  switch (word) {
    case "new":
      return { name: "new" };
    case "cd":
      return rest ? { name: "cd", path: rest } : null;
    case "project":
      return rest ? { name: "project", alias: rest } : null;
    case "mode":
      if (VALID_MODES.has(rest)) {
        return { name: "mode", mode: rest as PermissionMode };
      }
      return null;
    case "model":
      return rest ? { name: "model", model: rest } : null;
    case "status":
      return { name: "status" };
    case "help":
      return { name: "help" };
    case "config":
      if (rest === "show") return { name: "config_show" };
      return null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/commands/router.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/router.ts test/unit/commands/router.test.ts
git commit -m "feat(commands): extend parseInput with Phase 6 command parsing"
```

---

### Task 2: Config extension — projects table

**Files:**
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `config.example.toml`
- Test: `test/unit/config.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/unit/config.test.ts`:

```ts
describe("projects table", () => {
  it("parses [projects] as Record<string, string>", async () => {
    const toml = `${MINIMAL_TOML}
[projects]
my-app = "~/projects/my-app"
infra = "/abs/path"
`;
    const tmp = join(tmpdir(), `cfc-test-projects-${Date.now()}.toml`);
    await writeFile(tmp, toml, "utf8");
    try {
      const config = await loadConfig(tmp);
      expect(config.projects).toEqual({
        "my-app": join(homedir(), "projects/my-app"),
        infra: "/abs/path",
      });
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });

  it("defaults to empty object when [projects] is omitted", async () => {
    const tmp = join(tmpdir(), `cfc-test-noproj-${Date.now()}.toml`);
    await writeFile(tmp, MINIMAL_TOML, "utf8");
    try {
      const config = await loadConfig(tmp);
      expect(config.projects).toEqual({});
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });
});
```

Note: `MINIMAL_TOML` is the existing test fixture that has all required sections. Ensure the test file already imports `homedir` from `node:os` and `join` from `node:path` — add them if not present. Also import `unlink` from `node:fs/promises`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/config.test.ts`
Expected: FAIL — `config.projects` is undefined

- [ ] **Step 3: Add projects to AppConfig type**

In `src/types.ts`, add after the `logging` section (inside `AppConfig`):

```ts
  /** Project aliases — map of alias → absolute cwd path. */
  projects: Record<string, string>;
```

- [ ] **Step 4: Add projects to config schema + loadConfig**

In `src/config.ts`, add a schema before `ConfigSchema`:

```ts
const ProjectsSchema = z.record(z.string(), z.string()).default({});
```

Add `projects: ProjectsSchema,` inside `ConfigSchema`'s `z.object({...})`.

In the `loadConfig` return object, after `logging: { ... }`, add:

```ts
    projects: Object.fromEntries(
      Object.entries(data.projects ?? {}).map(([k, v]) => [k, expandHome(v)]),
    ),
```

- [ ] **Step 5: Update config.example.toml**

Add at the end of the file, before `# ─── Logging ─`:

```toml
# ─── Project aliases ─────────────────────────────────────────────────
# Aliases for /project command — quickly switch cwd by name.
# [projects]
# my-app = "~/projects/my-app"
# infra = "~/projects/infrastructure"
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run test/unit/config.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/types.ts config.example.toml test/unit/config.test.ts
git commit -m "feat(config): add optional [projects] table for /project aliases"
```

---

### Task 3: Session API extensions

**Files:**
- Modify: `src/claude/session.ts`
- Test: `test/unit/claude/session-state-machine.test.ts`

- [ ] **Step 1: Write failing tests for new session API**

Add a new `describe` block in `test/unit/claude/session-state-machine.test.ts`:

```ts
describe("Session runtime overrides + stats", () => {
  it("getState() returns idle initially", () => {
    const h = makeHarness();
    expect(h.session.getState()).toBe("idle");
  });

  it("setPermissionModeOverride causes processLoop to use the override", async () => {
    const h = makeHarness();
    h.session.setPermissionModeOverride("plan");
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
    expect(fake.options.permissionMode).toBe("plan");
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
    await outcome.done;
  });

  it("setPermissionModeOverride('acceptEdits') sets sessionAcceptEditsSticky", async () => {
    const h = makeHarness();
    h.session.setPermissionModeOverride("acceptEdits");
    expect(h.session._testGetSessionAcceptEditsSticky()).toBe(true);
  });

  it("setPermissionModeOverride('default') clears sessionAcceptEditsSticky", async () => {
    const h = makeHarness();
    h.session._testSetSessionAcceptEditsSticky(true);
    h.session.setPermissionModeOverride("default");
    expect(h.session._testGetSessionAcceptEditsSticky()).toBe(false);
  });

  it("setModelOverride causes processLoop to use the override", async () => {
    const h = makeHarness();
    h.session.setModelOverride("claude-sonnet-4-6");
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
    expect(fake.options.model).toBe("claude-sonnet-4-6");
    fake.finishWithSuccess({ durationMs: 1, inputTokens: 10, outputTokens: 20 });
    await outcome.done;
  });

  it("getStatus() returns correct values", async () => {
    const h = makeHarness();
    const status = h.session.getStatus();
    expect(status.state).toBe("idle");
    expect(status.turnCount).toBe(0);
    expect(status.totalInputTokens).toBe(0);
    expect(status.totalOutputTokens).toBe(0);
    expect(status.queueLength).toBe(0);
  });

  it("turnCount and token counters accumulate after a turn", async () => {
    const h = makeHarness();
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
    h.fakes[0]!.finishWithSuccess({
      durationMs: 100,
      inputTokens: 500,
      outputTokens: 1200,
    });
    await outcome.done;
    const status = h.session.getStatus();
    expect(status.turnCount).toBe(1);
    expect(status.totalInputTokens).toBe(500);
    expect(status.totalOutputTokens).toBe(1200);
  });
});
```

The `makeHarness()` and `SpyRenderer` helpers already exist in the file. `FakeQueryHandle.options` needs to expose the `permissionMode` and `model` that were passed to `queryFn`. Check that `FakeQueryHandle` in `test/unit/claude/fakes/fake-query-handle.ts` already captures `options` — it does (from Phase 5 work). If it doesn't store `model`, extend it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: FAIL — `getState`, `setPermissionModeOverride`, `setModelOverride`, `getStatus` don't exist yet

- [ ] **Step 3: Add override fields, counters, and public methods to session**

In `src/claude/session.ts`, add the `SessionStatus` interface after the `SessionState` type:

```ts
export interface SessionStatus {
  state: SessionState;
  permissionMode: string;
  model: string;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  queueLength: number;
}
```

Add fields in `ClaudeSession` after `sessionAcceptEditsSticky`:

```ts
  private permissionModeOverride?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  private modelOverride?: string;
  private turnCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
```

Add public methods (before the test seams section):

```ts
  getState(): SessionState {
    return this.state;
  }

  setPermissionModeOverride(
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
  ): void {
    this.permissionModeOverride = mode;
    this.sessionAcceptEditsSticky = mode === "acceptEdits";
  }

  setModelOverride(model: string): void {
    this.modelOverride = model;
  }

  getStatus(): SessionStatus {
    return {
      state: this.state,
      permissionMode: this.sessionAcceptEditsSticky
        ? "acceptEdits"
        : (this.permissionModeOverride ?? this.config.defaultPermissionMode),
      model: this.modelOverride ?? this.config.defaultModel,
      turnCount: this.turnCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      queueLength: this.inputQueue.length,
    };
  }
```

In `processLoop`, update the `permissionMode` and model lines (around line 413-430):

```ts
      const permissionMode = this.sessionAcceptEditsSticky
        ? ("acceptEdits" as const)
        : (this.permissionModeOverride ?? this.config.defaultPermissionMode);
      // ...existing code to build askUserMcp...
      const handle = this.queryFn({
        prompt: next.text,
        options: {
          cwd: this.config.defaultCwd,
          model: this.modelOverride ?? this.config.defaultModel,
          permissionMode,
          // ...rest unchanged
        },
        canUseTool: this.buildCanUseToolClosure(next),
      });
```

In `runTurn`, after the final `logger.info("Claude turn complete")` line, accumulate stats:

```ts
    this.turnCount++;
    this.totalInputTokens += resultMsg.usage?.input_tokens ?? 0;
    this.totalOutputTokens += resultMsg.usage?.output_tokens ?? 0;
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/claude/session-state-machine.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts test/unit/claude/session-state-machine.test.ts
git commit -m "feat(claude): add session runtime overrides (mode/model) and turn stats"
```

---

### Task 4: SessionManager extensions

**Files:**
- Modify: `src/claude/session-manager.ts`
- Test: `test/unit/claude/session-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/unit/claude/session-manager.test.ts`:

```ts
  it("delete() removes session from the map", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    const a = mgr.getOrCreate("oc_1");
    mgr.delete("oc_1");
    const b = mgr.getOrCreate("oc_1");
    expect(a).not.toBe(b);
  });

  it("delete() on nonexistent chatId is a no-op", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    expect(() => mgr.delete("oc_nonexistent")).not.toThrow();
  });

  it("setCwdOverride causes getOrCreate to use override cwd", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    mgr.setCwdOverride("oc_1", "/custom/path");
    const session = mgr.getOrCreate("oc_1");
    // The session's status should reflect the override cwd
    expect(session.getStatus().cwd).toBe("/custom/path");
  });

  it("getOrCreate without cwdOverride uses config default", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    const session = mgr.getOrCreate("oc_1");
    expect(session.getStatus().cwd).toBe("/tmp/cfc-test");
  });
```

Note: `getStatus().cwd` doesn't exist on SessionStatus yet. We'll add it in this task alongside the session changes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/claude/session-manager.test.ts`
Expected: FAIL — `delete`, `setCwdOverride`, `getStatus().cwd` don't exist

- [ ] **Step 3: Add cwd to SessionStatus**

In `src/claude/session.ts`, add `cwd: string` to `SessionStatus` and update `getStatus()`:

```ts
export interface SessionStatus {
  state: SessionState;
  cwd: string;
  permissionMode: string;
  model: string;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  queueLength: number;
}
```

Update `getStatus()` to include:
```ts
  getStatus(): SessionStatus {
    return {
      state: this.state,
      cwd: this.config.defaultCwd,
      // ... rest unchanged
    };
  }
```

- [ ] **Step 4: Implement SessionManager extensions**

Replace `src/claude/session-manager.ts` with:

```ts
import type { Logger } from "pino";
import { ClaudeSession, type QueryFn } from "./session.js";
import type { Clock } from "../util/clock.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { QuestionBroker } from "./question-broker.js";
import type { AppConfig } from "../types.js";

export interface ClaudeSessionManagerOptions {
  config: AppConfig["claude"];
  queryFn: QueryFn;
  clock: Clock;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  logger: Logger;
}

export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly cwdOverrides = new Map<string, string>();
  private readonly opts: ClaudeSessionManagerOptions;

  constructor(opts: ClaudeSessionManagerOptions) {
    this.opts = opts;
  }

  getOrCreate(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (session === undefined) {
      const cwd = this.cwdOverrides.get(chatId) ?? this.opts.config.defaultCwd;
      session = new ClaudeSession({
        chatId,
        config: { ...this.opts.config, defaultCwd: cwd },
        queryFn: this.opts.queryFn,
        clock: this.opts.clock,
        permissionBroker: this.opts.permissionBroker,
        questionBroker: this.opts.questionBroker,
        logger: this.opts.logger,
      });
      this.sessions.set(chatId, session);
    }
    return session;
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
  }

  setCwdOverride(chatId: string, cwd: string): void {
    this.cwdOverrides.set(chatId, cwd);
  }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/unit/claude/session-manager.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/claude/session.ts src/claude/session-manager.ts test/unit/claude/session-manager.test.ts
git commit -m "feat(claude): SessionManager delete, cwdOverride; session.getStatus().cwd"
```

---

### Task 5: cd-confirm-card builders

**Files:**
- Create: `src/feishu/cards/cd-confirm-card.ts`
- Test: `test/unit/feishu/cards/cd-confirm-card.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/unit/feishu/cards/cd-confirm-card.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildCdConfirmCard,
  buildCdConfirmResolved,
  buildCdConfirmCancelled,
  buildCdConfirmTimedOut,
} from "../../../../src/feishu/cards/cd-confirm-card.js";

describe("buildCdConfirmCard (pending)", () => {
  it("includes the target path and two buttons", () => {
    const card = buildCdConfirmCard({
      requestId: "req_1",
      targetPath: "/Users/me/projects/foo",
    });
    const json = JSON.stringify(card);
    expect(json).toContain("/Users/me/projects/foo");
    expect(json).toContain("确认");
    expect(json).toContain("取消");
    expect(json).toContain('"tag":"button"');
  });

  it("buttons carry cd_confirm kind with request_id and accepted flag", () => {
    const card = buildCdConfirmCard({
      requestId: "req_abc",
      targetPath: "/tmp",
    });
    const json = JSON.stringify(card);
    expect(json).toContain('"kind":"cd_confirm"');
    expect(json).toContain('"request_id":"req_abc"');
    expect(json).toContain('"accepted":true');
    expect(json).toContain('"accepted":false');
  });

  it("has update_multi: true", () => {
    const card = buildCdConfirmCard({
      requestId: "req_1",
      targetPath: "/tmp",
    });
    expect(card.config?.update_multi).toBe(true);
  });
});

describe("buildCdConfirmResolved", () => {
  it("shows the path and has no buttons", () => {
    const card = buildCdConfirmResolved({ targetPath: "/new/path" });
    const json = JSON.stringify(card);
    expect(json).toContain("/new/path");
    expect(json).not.toContain('"tag":"button"');
  });
});

describe("buildCdConfirmCancelled", () => {
  it("shows cancel text and has no buttons", () => {
    const card = buildCdConfirmCancelled();
    const json = JSON.stringify(card);
    expect(json).toMatch(/取消/);
    expect(json).not.toContain('"tag":"button"');
  });
});

describe("buildCdConfirmTimedOut", () => {
  it("shows timeout text and has no buttons", () => {
    const card = buildCdConfirmTimedOut();
    const json = JSON.stringify(card);
    expect(json).toMatch(/超时/);
    expect(json).not.toContain('"tag":"button"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/feishu/cards/cd-confirm-card.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement cd-confirm-card builders**

Create `src/feishu/cards/cd-confirm-card.ts`:

```ts
import type {
  FeishuCardV2,
  FeishuElement,
  FeishuButtonElement,
} from "../card-types.js";

interface BuildPendingArgs {
  requestId: string;
  targetPath: string;
}

export function buildCdConfirmCard(args: BuildPendingArgs): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { content: "📁 切换工作目录", tag: "plain_text" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**目标路径:** \`${escapeMd(args.targetPath)}\``,
        },
        {
          tag: "markdown",
          content: "<font color='grey'>仅发起者可操作 · 60s 后自动取消</font>",
        },
        buttonRow([
          makeButton("✅ 确认", true, args.requestId, "primary"),
          makeButton("❌ 取消", false, args.requestId, "danger"),
        ]),
      ],
    },
  };
}

export function buildCdConfirmResolved(args: {
  targetPath: string;
}): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `📁 工作目录已切换为 \`${escapeMd(args.targetPath)}\``,
        },
      ],
    },
  };
}

export function buildCdConfirmCancelled(): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "🛑 已取消切换工作目录",
        },
      ],
    },
  };
}

export function buildCdConfirmTimedOut(): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "⏰ 切换工作目录已超时",
        },
      ],
    },
  };
}

function makeButton(
  label: string,
  accepted: boolean,
  requestId: string,
  type: FeishuButtonElement["type"],
): FeishuButtonElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    value: {
      kind: "cd_confirm",
      request_id: requestId,
      accepted,
    },
  };
}

function buttonRow(buttons: FeishuButtonElement[]): FeishuElement {
  return {
    tag: "column_set",
    flex_mode: "bisect",
    horizontal_spacing: "default",
    columns: buttons.map((btn) => ({
      tag: "column" as const,
      width: "weighted",
      weight: 1,
      vertical_align: "top" as const,
      elements: [btn],
    })),
  };
}

function escapeMd(text: string): string {
  return text.replace(/([*_~`\[\]\\])/g, "\\$1");
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/feishu/cards/cd-confirm-card.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/feishu/cards/cd-confirm-card.ts test/unit/feishu/cards/cd-confirm-card.test.ts
git commit -m "feat(feishu): add cd-confirm-card builders (pending/resolved/cancelled/timed-out)"
```

---

### Task 6: CommandDispatcher — simple read-only commands

**Files:**
- Create: `src/commands/dispatcher.ts`
- Test: `test/unit/commands/dispatcher.test.ts`

- [ ] **Step 1: Write failing tests for /help, /status, /config show, unknown**

Create `test/unit/commands/dispatcher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandDispatcher } from "../../../src/commands/dispatcher.js";
import type { FeishuClient } from "../../../src/feishu/client.js";
import type { AppConfig } from "../../../src/types.js";
import { ClaudeSessionManager } from "../../../src/claude/session-manager.js";
import type { QueryFn, SDKMessageLike } from "../../../src/claude/session.js";
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "./fakes/fake-question-broker.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT = createLogger({ level: "error", pretty: false });

const BASE_CONFIG: AppConfig = {
  feishu: {
    appId: "cli_test",
    appSecret: "secret_test_value",
    encryptKey: "",
    verificationToken: "",
  },
  access: {
    allowedOpenIds: ["ou_alice"],
    unauthorizedBehavior: "ignore",
  },
  claude: {
    defaultCwd: "/tmp/test-cwd",
    defaultPermissionMode: "default",
    defaultModel: "claude-opus-4-6",
    cliPath: "claude",
    permissionTimeoutMs: 300_000,
    permissionWarnBeforeMs: 60_000,
  },
  render: {
    inlineMaxBytes: 2048,
    hideThinking: false,
    showTurnStats: true,
  },
  persistence: {
    stateFile: "/tmp/state.json",
    logDir: "/tmp/logs",
  },
  logging: { level: "info" },
  projects: { "my-app": "/home/user/my-app" },
};

const NOOP_QUERY: QueryFn = () => ({
  messages: {
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessageLike, void> {
      yield { type: "result", subtype: "success", result: "" };
    },
  },
  interrupt: async () => {},
  setPermissionMode: () => {},
});

const CTX = {
  chatId: "oc_1",
  senderOpenId: "ou_alice",
  parentMessageId: "om_p1",
};

function makeHarness() {
  const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
  const replyCard = vi.fn().mockResolvedValue({ messageId: "om_card" });
  const patchCard = vi.fn().mockResolvedValue(undefined);
  const feishu = { replyText, replyCard, patchCard } as unknown as FeishuClient;
  const clock = new FakeClock();
  const permissionBroker = new FakePermissionBroker();
  const questionBroker = new FakeQuestionBroker();
  const sessionManager = new ClaudeSessionManager({
    config: BASE_CONFIG.claude,
    queryFn: NOOP_QUERY,
    clock,
    permissionBroker,
    questionBroker,
    logger: SILENT,
  });
  const dispatcher = new CommandDispatcher({
    sessionManager,
    feishu,
    config: BASE_CONFIG,
    permissionBroker,
    questionBroker,
    clock,
    logger: SILENT,
  });
  return { dispatcher, feishu, sessionManager, replyText, replyCard, patchCard, clock };
}

describe("CommandDispatcher — /help", () => {
  it("replies with text listing all commands", async () => {
    const h = makeHarness();
    await h.dispatcher.dispatch({ name: "help" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    const text = h.replyText.mock.calls[0]![1] as string;
    expect(text).toContain("/new");
    expect(text).toContain("/cd");
    expect(text).toContain("/mode");
    expect(text).toContain("/model");
    expect(text).toContain("/status");
    expect(text).toContain("/help");
    expect(text).toContain("/stop");
    expect(text).toContain("/config");
    expect(text).toContain("/project");
  });
});

describe("CommandDispatcher — /status", () => {
  it("replies with session state info", async () => {
    const h = makeHarness();
    // Ensure a session exists
    h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "status" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    const text = h.replyText.mock.calls[0]![1] as string;
    expect(text).toContain("idle");
    expect(text).toContain("/tmp/test-cwd");
    expect(text).toContain("default");
    expect(text).toContain("claude-opus-4-6");
  });
});

describe("CommandDispatcher — /config show", () => {
  it("replies with config and masks app_secret", async () => {
    const h = makeHarness();
    await h.dispatcher.dispatch({ name: "config_show" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    const text = h.replyText.mock.calls[0]![1] as string;
    expect(text).toContain("cli_test");
    expect(text).not.toContain("secret_test_value");
    expect(text).toContain("***");
  });
});

describe("CommandDispatcher — unknown command", () => {
  it("replies with hint to use /help", async () => {
    const h = makeHarness();
    await h.dispatcher.dispatchUnknown("/foo", CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    const text = h.replyText.mock.calls[0]![1] as string;
    expect(text).toContain("/help");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement CommandDispatcher with simple commands**

Create `src/commands/dispatcher.ts`:

```ts
import crypto from "node:crypto";
import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import type { FeishuClient } from "../feishu/client.js";
import type { AppConfig } from "../types.js";
import type { ClaudeSessionManager } from "../claude/session-manager.js";
import type { PermissionBroker } from "../claude/permission-broker.js";
import type { QuestionBroker } from "../claude/question-broker.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { FeishuCardV2 } from "../feishu/card-types.js";
import type { ParsedCommand } from "./router.js";
import {
  buildCdConfirmCard,
  buildCdConfirmResolved,
  buildCdConfirmCancelled,
  buildCdConfirmTimedOut,
} from "../feishu/cards/cd-confirm-card.js";

export interface CommandContext {
  chatId: string;
  senderOpenId: string;
  parentMessageId: string;
}

export type CdConfirmResult =
  | { kind: "resolved"; card: FeishuCardV2 }
  | { kind: "not_found" }
  | { kind: "forbidden"; ownerOpenId: string };

interface PendingCdConfirm {
  requestId: string;
  ownerOpenId: string;
  cardMessageId: string;
  targetPath: string;
  chatId: string;
  timer: TimeoutHandle;
}

export interface CommandDispatcherOptions {
  sessionManager: ClaudeSessionManager;
  feishu: FeishuClient;
  config: AppConfig;
  permissionBroker: PermissionBroker;
  questionBroker: QuestionBroker;
  clock: Clock;
  logger: Logger;
}

export class CommandDispatcher {
  private readonly sessionManager: ClaudeSessionManager;
  private readonly feishu: FeishuClient;
  private readonly config: AppConfig;
  private readonly permissionBroker: PermissionBroker;
  private readonly questionBroker: QuestionBroker;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly pendingCdConfirms = new Map<string, PendingCdConfirm>();

  constructor(opts: CommandDispatcherOptions) {
    this.sessionManager = opts.sessionManager;
    this.feishu = opts.feishu;
    this.config = opts.config;
    this.permissionBroker = opts.permissionBroker;
    this.questionBroker = opts.questionBroker;
    this.clock = opts.clock;
    this.logger = opts.logger.child({ component: "command-dispatcher" });
  }

  async dispatch(cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
    switch (cmd.name) {
      case "help":
        return this.handleHelp(ctx);
      case "status":
        return this.handleStatus(ctx);
      case "config_show":
        return this.handleConfigShow(ctx);
      case "new":
        return this.handleNew(ctx);
      case "mode":
        return this.handleMode(ctx, cmd.mode);
      case "model":
        return this.handleModel(ctx, cmd.model);
      case "cd":
        return this.handleCd(ctx, cmd.path);
      case "project":
        return this.handleProject(ctx, cmd.alias);
    }
  }

  async dispatchUnknown(raw: string, ctx: CommandContext): Promise<void> {
    await this.feishu.replyText(
      ctx.parentMessageId,
      "未知命令，发 /help 查看可用命令",
    );
  }

  private async handleHelp(ctx: CommandContext): Promise<void> {
    const text = `📖 可用命令

**会话管理**
/new — 结束当前会话，下条消息开启新对话
/cd <路径> — 切换工作目录（需确认）
/project <别名> — 按别名切换工作目录

**模式切换**
/mode <模式> — 切换权限模式（default / acceptEdits / plan / bypassPermissions）
/model <模型> — 切换模型（如 claude-opus-4-6、sonnet）

**执行控制**
/stop — 停止当前执行
!<消息> — 打断当前执行并发送新消息

**查询**
/status — 显示当前会话状态
/help — 显示本帮助
/config show — 显示当前配置`;
    await this.feishu.replyText(ctx.parentMessageId, text);
  }

  private async handleStatus(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    const s = session.getStatus();
    const text = `📊 会话状态
状态: ${s.state}
工作目录: ${s.cwd}
权限模式: ${s.permissionMode}
模型: ${s.model}
已完成轮次: ${s.turnCount}
累计 token: ${s.totalInputTokens} in / ${s.totalOutputTokens} out
队列长度: ${s.queueLength}`;
    await this.feishu.replyText(ctx.parentMessageId, text);
  }

  private async handleConfigShow(ctx: CommandContext): Promise<void> {
    const c = this.config;
    const text = `📋 当前配置
feishu.app_id: ${c.feishu.appId}
feishu.app_secret: ***
claude.default_cwd: ${c.claude.defaultCwd}
claude.default_permission_mode: ${c.claude.defaultPermissionMode}
claude.default_model: ${c.claude.defaultModel}
claude.cli_path: ${c.claude.cliPath}
claude.permission_timeout_seconds: ${c.claude.permissionTimeoutMs / 1000}
render.inline_max_bytes: ${c.render.inlineMaxBytes}
render.hide_thinking: ${c.render.hideThinking}
render.show_turn_stats: ${c.render.showTurnStats}
logging.level: ${c.logging.level}
projects: ${Object.keys(c.projects).length === 0 ? "(none)" : Object.entries(c.projects).map(([k, v]) => `${k} → ${v}`).join(", ")}`;
    await this.feishu.replyText(ctx.parentMessageId, text);
  }

  // Placeholder methods for subsequent tasks — they'll be implemented
  // in Tasks 7-9. Having them here avoids compile errors from the
  // switch statement.
  private async handleNew(_ctx: CommandContext): Promise<void> {
    throw new Error("not implemented");
  }
  private async handleMode(
    _ctx: CommandContext,
    _mode: string,
  ): Promise<void> {
    throw new Error("not implemented");
  }
  private async handleModel(
    _ctx: CommandContext,
    _model: string,
  ): Promise<void> {
    throw new Error("not implemented");
  }
  private async handleCd(
    _ctx: CommandContext,
    _path: string,
  ): Promise<void> {
    throw new Error("not implemented");
  }
  private async handleProject(
    _ctx: CommandContext,
    _alias: string,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  async resolveCdConfirm(_args: {
    requestId: string;
    senderOpenId: string;
    accepted: boolean;
  }): Promise<CdConfirmResult> {
    throw new Error("not implemented");
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: ALL PASS (only the 4 simple-command tests run)

- [ ] **Step 5: Commit**

```bash
git add src/commands/dispatcher.ts test/unit/commands/dispatcher.test.ts
git commit -m "feat(commands): CommandDispatcher with /help /status /config-show /unknown"
```

---

### Task 7: CommandDispatcher — /new

**Files:**
- Modify: `src/commands/dispatcher.ts`
- Test: `test/unit/commands/dispatcher.test.ts`

- [ ] **Step 1: Write failing tests for /new**

Add to `test/unit/commands/dispatcher.test.ts`:

```ts
describe("CommandDispatcher — /new", () => {
  it("in idle state: deletes session and replies", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "new" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    const text = h.replyText.mock.calls[0]![1] as string;
    expect(text).toContain("新会话");
    // Session should be fresh after /new
    const fresh = h.sessionManager.getOrCreate("oc_1");
    expect(fresh.getStatus().turnCount).toBe(0);
  });

  it("in generating state: calls stop() first, then deletes", async () => {
    const h = makeHarness();
    const session = h.sessionManager.getOrCreate("oc_1");
    // Start a turn to move to generating state
    const spy = new SpyRenderer();
    const outcome = await session.submit(
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
    expect(session.getState()).toBe("generating");

    await h.dispatcher.dispatch({ name: "new" }, CTX);
    // The old session's turn was stopped
    expect(h.replyText).toHaveBeenCalled();
    const text = h.replyText.mock.calls.at(-1)![1] as string;
    expect(text).toContain("新会话");
  });
});
```

Import `SpyRenderer` and `flushMicrotasks` from the session test helpers or define them inline. If the dispatcher test file doesn't have these, add:

```ts
class SpyRenderer {
  events: import("../../../src/claude/render-event.js").RenderEvent[] = [];
  emit = async (e: import("../../../src/claude/render-event.js").RenderEvent) => {
    this.events.push(e);
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: FAIL — `handleNew` throws "not implemented"

- [ ] **Step 3: Implement handleNew**

In `src/commands/dispatcher.ts`, replace the `handleNew` placeholder:

```ts
  private async handleNew(ctx: CommandContext): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      // Stop the current turn first — this interrupts, cancels
      // pending permission/question cards, and drains the queue.
      const noopEmit = async () => {};
      await session.stop(noopEmit);
    }
    this.permissionBroker.cancelAll("new session");
    this.questionBroker.cancelAll("new session");
    this.sessionManager.delete(ctx.chatId);
    await this.feishu.replyText(
      ctx.parentMessageId,
      "新会话已开始，下条消息将开启新对话",
    );
  }
```

Note: `session.stop()` requires an `EmitFn`. We pass a no-op since the stop events for the old session are irrelevant after `/new`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/dispatcher.ts test/unit/commands/dispatcher.test.ts
git commit -m "feat(commands): implement /new command handler"
```

---

### Task 8: CommandDispatcher — /mode, /model

**Files:**
- Modify: `src/commands/dispatcher.ts`
- Test: `test/unit/commands/dispatcher.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/unit/commands/dispatcher.test.ts`:

```ts
describe("CommandDispatcher — /mode", () => {
  it("sets permission mode override on idle session", async () => {
    const h = makeHarness();
    const session = h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "mode", mode: "acceptEdits" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    expect(h.replyText.mock.calls[0]![1]).toContain("acceptEdits");
    expect(session.getStatus().permissionMode).toBe("acceptEdits");
  });

  it("setting mode to default clears sticky flag", async () => {
    const h = makeHarness();
    const session = h.sessionManager.getOrCreate("oc_1");
    session.setPermissionModeOverride("acceptEdits");
    expect(session._testGetSessionAcceptEditsSticky()).toBe(true);
    await h.dispatcher.dispatch({ name: "mode", mode: "default" }, CTX);
    expect(session._testGetSessionAcceptEditsSticky()).toBe(false);
    expect(session.getStatus().permissionMode).toBe("default");
  });

  it("rejects when session is not idle", async () => {
    const h = makeHarness();
    const session = h.sessionManager.getOrCreate("oc_1");
    const spy = new SpyRenderer();
    const outcome = await session.submit(
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

    await h.dispatcher.dispatch({ name: "mode", mode: "plan" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    expect(h.replyText.mock.calls[0]![1]).toContain("执行中");
    // Mode should NOT have changed
    expect(session.getStatus().permissionMode).not.toBe("plan");
  });
});

describe("CommandDispatcher — /model", () => {
  it("sets model override on idle session", async () => {
    const h = makeHarness();
    const session = h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "model", model: "sonnet" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    expect(h.replyText.mock.calls[0]![1]).toContain("sonnet");
    expect(session.getStatus().model).toBe("sonnet");
  });

  it("rejects when session is not idle", async () => {
    const h = makeHarness();
    const session = h.sessionManager.getOrCreate("oc_1");
    const spy = new SpyRenderer();
    const outcome = await session.submit(
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

    await h.dispatcher.dispatch({ name: "model", model: "haiku" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    expect(h.replyText.mock.calls[0]![1]).toContain("执行中");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: FAIL — "not implemented"

- [ ] **Step 3: Implement handleMode and handleModel**

In `src/commands/dispatcher.ts`, replace the placeholders:

```ts
  private async handleMode(
    ctx: CommandContext,
    mode: string,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(
        ctx.parentMessageId,
        "会话正在执行中，请先发送 /stop 或等待完成",
      );
      return;
    }
    session.setPermissionModeOverride(
      mode as "default" | "acceptEdits" | "plan" | "bypassPermissions",
    );
    await this.feishu.replyText(
      ctx.parentMessageId,
      `权限模式已切换为 ${mode}`,
    );
  }

  private async handleModel(
    ctx: CommandContext,
    model: string,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(
        ctx.parentMessageId,
        "会话正在执行中，请先发送 /stop 或等待完成",
      );
      return;
    }
    session.setModelOverride(model);
    await this.feishu.replyText(
      ctx.parentMessageId,
      `模型已切换为 ${model}`,
    );
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/dispatcher.ts test/unit/commands/dispatcher.test.ts
git commit -m "feat(commands): implement /mode and /model command handlers"
```

---

### Task 9: CommandDispatcher — /cd, /project, resolveCdConfirm

**Files:**
- Modify: `src/commands/dispatcher.ts`
- Test: `test/unit/commands/dispatcher.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/unit/commands/dispatcher.test.ts`:

```ts
describe("CommandDispatcher — /cd", () => {
  it("sends confirmation card for valid path", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    // /tmp always exists
    await h.dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    expect(h.replyCard).toHaveBeenCalledTimes(1);
    const cardJson = JSON.stringify(h.replyCard.mock.calls[0]![1]);
    expect(cardJson).toContain("/tmp");
    expect(cardJson).toContain("确认");
  });

  it("rejects with error for nonexistent path", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch(
      { name: "cd", path: "/nonexistent/path/that/does/not/exist" },
      CTX,
    );
    expect(h.replyText).toHaveBeenCalledTimes(1);
    expect(h.replyText.mock.calls[0]![1]).toContain("路径不存在");
  });

  it("rejects when session is not idle", async () => {
    const h = makeHarness();
    const session = h.sessionManager.getOrCreate("oc_1");
    const spy = new SpyRenderer();
    const outcome = await session.submit(
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

    await h.dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    expect(h.replyText.mock.calls[0]![1]).toContain("执行中");
  });
});

describe("CommandDispatcher — /cd confirm click", () => {
  it("confirm click deletes old session, sets cwd override, returns resolved card", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    const cardJson = JSON.stringify(h.replyCard.mock.calls[0]![1]);
    const requestId = JSON.parse(cardJson.match(/"request_id":"([^"]+)"/)?.[0]?.replace("request_id", "id") || "{}").id
      || cardJson.match(/"request_id":"([^"]+)"/)?.[1];

    const result = await h.dispatcher.resolveCdConfirm({
      requestId: requestId!,
      senderOpenId: "ou_alice",
      accepted: true,
    });
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    const rJson = JSON.stringify(result.card);
    expect(rJson).toContain("/tmp");
    expect(rJson).not.toContain('"tag":"button"');
  });

  it("cancel click returns resolved card with cancelled text", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    const cardJson = JSON.stringify(h.replyCard.mock.calls[0]![1]);
    const requestId = cardJson.match(/"request_id":"([^"]+)"/)?.[1];

    const result = await h.dispatcher.resolveCdConfirm({
      requestId: requestId!,
      senderOpenId: "ou_alice",
      accepted: false,
    });
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    expect(JSON.stringify(result.card)).toContain("取消");
  });

  it("non-owner click returns forbidden", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    const cardJson = JSON.stringify(h.replyCard.mock.calls[0]![1]);
    const requestId = cardJson.match(/"request_id":"([^"]+)"/)?.[1];

    const result = await h.dispatcher.resolveCdConfirm({
      requestId: requestId!,
      senderOpenId: "ou_intruder",
      accepted: true,
    });
    expect(result).toEqual({ kind: "forbidden", ownerOpenId: "ou_alice" });
  });

  it("unknown requestId returns not_found", async () => {
    const h = makeHarness();
    const result = await h.dispatcher.resolveCdConfirm({
      requestId: "req_unknown",
      senderOpenId: "ou_alice",
      accepted: true,
    });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("timeout auto-cancels and patches card", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    // Advance clock past 60s timeout
    h.clock.advance(60_000);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(h.patchCard).toHaveBeenCalled();
    const patchedJson = JSON.stringify(h.patchCard.mock.calls.at(-1)![1]);
    expect(patchedJson).toContain("超时");
  });
});

describe("CommandDispatcher — /project", () => {
  it("resolves alias to path and sends confirm card", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    // config has "my-app" → "/home/user/my-app"
    await h.dispatcher.dispatch({ name: "project", alias: "my-app" }, CTX);
    expect(h.replyCard).toHaveBeenCalledTimes(1);
    const cardJson = JSON.stringify(h.replyCard.mock.calls[0]![1]);
    expect(cardJson).toContain("/home/user/my-app");
  });

  it("unknown alias replies with error listing available aliases", async () => {
    const h = makeHarness();
    h.sessionManager.getOrCreate("oc_1");
    await h.dispatcher.dispatch({ name: "project", alias: "unknown" }, CTX);
    expect(h.replyText).toHaveBeenCalledTimes(1);
    const text = h.replyText.mock.calls[0]![1] as string;
    expect(text).toContain("未知项目别名");
    expect(text).toContain("my-app");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: FAIL — "not implemented"

- [ ] **Step 3: Implement handleCd, handleProject, resolveCdConfirm**

In `src/commands/dispatcher.ts`, replace the three placeholders:

```ts
  private async handleCd(ctx: CommandContext, path: string): Promise<void> {
    const session = this.sessionManager.getOrCreate(ctx.chatId);
    if (session.getState() !== "idle") {
      await this.feishu.replyText(
        ctx.parentMessageId,
        "会话正在执行中，请先发送 /stop 或等待完成",
      );
      return;
    }

    // Validate path exists
    try {
      const s = await stat(path);
      if (!s.isDirectory()) {
        await this.feishu.replyText(
          ctx.parentMessageId,
          `路径不是目录: ${path}`,
        );
        return;
      }
    } catch {
      await this.feishu.replyText(
        ctx.parentMessageId,
        `路径不存在: ${path}`,
      );
      return;
    }

    const requestId = crypto.randomUUID();
    const card = buildCdConfirmCard({ requestId, targetPath: path });
    let cardMessageId: string;
    try {
      const res = await this.feishu.replyCard(ctx.parentMessageId, card);
      cardMessageId = res.messageId;
    } catch (err) {
      this.logger.error({ err }, "Failed to send cd confirm card");
      await this.feishu.replyText(
        ctx.parentMessageId,
        "发送确认卡片失败",
      );
      return;
    }

    const timer = this.clock.setTimeout(
      () => this.cdTimeout(requestId),
      60_000,
    );

    this.pendingCdConfirms.set(requestId, {
      requestId,
      ownerOpenId: ctx.senderOpenId,
      cardMessageId,
      targetPath: path,
      chatId: ctx.chatId,
      timer,
    });
  }

  private async handleProject(
    ctx: CommandContext,
    alias: string,
  ): Promise<void> {
    const resolved = this.config.projects[alias];
    if (!resolved) {
      const available = Object.keys(this.config.projects);
      const list =
        available.length > 0 ? available.join(", ") : "(none configured)";
      await this.feishu.replyText(
        ctx.parentMessageId,
        `未知项目别名: ${alias}，可用别名: ${list}`,
      );
      return;
    }
    return this.handleCd(ctx, resolved);
  }

  async resolveCdConfirm(args: {
    requestId: string;
    senderOpenId: string;
    accepted: boolean;
  }): Promise<CdConfirmResult> {
    const p = this.pendingCdConfirms.get(args.requestId);
    if (!p) return { kind: "not_found" };
    if (args.senderOpenId !== p.ownerOpenId) {
      return { kind: "forbidden", ownerOpenId: p.ownerOpenId };
    }

    this.clock.clearTimeout(p.timer);
    this.pendingCdConfirms.delete(args.requestId);

    if (args.accepted) {
      this.sessionManager.delete(p.chatId);
      this.sessionManager.setCwdOverride(p.chatId, p.targetPath);
      return {
        kind: "resolved",
        card: buildCdConfirmResolved({ targetPath: p.targetPath }),
      };
    }

    return {
      kind: "resolved",
      card: buildCdConfirmCancelled(),
    };
  }

  private cdTimeout(requestId: string): void {
    const p = this.pendingCdConfirms.get(requestId);
    if (!p) return;
    this.pendingCdConfirms.delete(requestId);
    void this.feishu
      .patchCard(p.cardMessageId, buildCdConfirmTimedOut())
      .catch((err) => {
        this.logger.warn({ err, requestId }, "cd timeout patch failed");
      });
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/commands/dispatcher.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/dispatcher.ts test/unit/commands/dispatcher.test.ts
git commit -m "feat(commands): implement /cd /project commands with confirmation card"
```

---

### Task 10: Wire into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import CommandDispatcher and route commands**

In `src/index.ts`, add import at the top:

```ts
import { CommandDispatcher } from "./commands/dispatcher.js";
```

After the `questionBroker` construction (around line 130), construct the dispatcher:

```ts
  const commandDispatcher = new CommandDispatcher({
    sessionManager,
    feishu: feishuClient,
    config,
    permissionBroker,
    questionBroker,
    clock,
    logger,
  });
```

In the `onMessage` function, after the `parseInput` call and the `/stop` check, add command routing before the `session.submit()` call:

```ts
      if (parsed.kind === "command") {
        await commandDispatcher.dispatch(parsed.cmd, {
          chatId: msg.chatId,
          senderOpenId: msg.senderOpenId,
          parentMessageId: msg.messageId,
        });
        return;
      }
      if (parsed.kind === "unknown_command") {
        await commandDispatcher.dispatchUnknown(parsed.raw, {
          chatId: msg.chatId,
          senderOpenId: msg.senderOpenId,
          parentMessageId: msg.messageId,
        });
        return;
      }
```

- [ ] **Step 2: Add cd_confirm branch to onCardAction**

In the `onCardAction` function, after the `kind === "question"` block and before the final `logger.warn`, add:

```ts
    if (kind === "cd_confirm") {
      const requestId = value.request_id;
      const accepted = value.accepted;
      if (typeof requestId !== "string") {
        logger.warn({ value }, "cd_confirm action missing request_id");
        return;
      }
      if (typeof accepted !== "boolean") {
        logger.warn({ value }, "cd_confirm action has invalid accepted");
        return;
      }
      const result = await commandDispatcher.resolveCdConfirm({
        requestId,
        senderOpenId,
        accepted,
      });
      if (result.kind === "forbidden") {
        logger.warn(
          {
            request_id: requestId,
            clicker: senderOpenId,
            owner: result.ownerOpenId,
          },
          "Non-owner cd_confirm click — ignored",
        );
        return;
      }
      if (result.kind === "not_found") {
        logger.info(
          { request_id: requestId },
          "cd_confirm for unknown request — likely already resolved",
        );
        return;
      }
      if (result.card) {
        return { card: result.card };
      }
      return;
    }
```

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: Clean typecheck, ALL tests pass

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire CommandDispatcher into main bootstrap + card action routing"
```

---

### Task 11: Full validation

- [ ] **Step 1: Run full typecheck + test suite**

Run: `pnpm typecheck && pnpm test`
Expected: Clean typecheck, all tests pass (existing ~255 + ~40 new)

- [ ] **Step 2: Restart dev server**

```bash
# Kill existing dev server
pkill -f "tsx src/index.ts" || true
sleep 1
# Restart
pnpm dev &
sleep 3
tail -5 /tmp/claude-feishu-dev.log  # verify startup
```

- [ ] **Step 3: Manual E2E verification**

Test in Feishu:
1. `/help` → list of commands
2. `/status` → session state info
3. `/config show` → config with masked secret
4. `/mode acceptEdits` → "权限模式已切换为 acceptEdits"
5. `/model sonnet` → "模型已切换为 sonnet"
6. `/new` → "新会话已开始"
7. `/cd /tmp` → confirm card → click confirm → card collapses
8. `/project my-app` → confirm card (if alias configured)
9. `/foo` → "未知命令，发 /help 查看可用命令"
10. Send a normal message → Claude responds normally (no command interference)

- [ ] **Step 4: Commit all remaining changes + tag release**

```bash
git tag -a v0.6.0-phase6 -m "Phase 6: Command set (/new /cd /project /mode /model /status /help /config-show)"
```

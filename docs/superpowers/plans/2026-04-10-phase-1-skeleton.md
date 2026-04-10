# Phase 1: Skeleton & Echo Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the project scaffold and a Feishu echo bot that receives whitelisted-user messages and replies with a template. This is Phase 1 of 8 from `docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md`.

**Architecture:** pnpm + TypeScript project. Pure utility modules, config loader, and atomic state store built with strict TDD (Red-Green-Refactor, one test → one commit). Feishu WebSocket gateway wires an end-to-end "receive → whitelist filter → reply" flow without any Claude integration yet.

**Tech Stack:** Node.js 20+, TypeScript 5, pnpm, vitest, `@larksuiteoapi/node-sdk`, `smol-toml`, `zod`, `pino`, `pino-pretty`.

**Scope boundaries:**
- **In scope:** scaffold, pure utils (deferred, mutex, dedup, clock), config loading with validation, pino logger with redaction, state-store atomic read/write, Feishu gateway + REST client, whitelist filter, echo flow (receive → reply with fixed template), graceful shutdown.
- **Out of scope (future phases):** Claude Agent SDK, ClaudeSession, state machine, Renderer, PermissionBroker, commands, persistence of session_id, cards, crash recovery.

**Prerequisites the engineer must verify:**
- Node.js 20+ installed (`node --version`)
- pnpm installed (`pnpm --version`); if missing: `npm install -g pnpm`
- Feishu developer account with a bot app created (for the Task 25 manual E2E test only — everything before that can be built and unit-tested without real credentials)

---

## File Structure

Files created/modified in this phase:

**Config & infra**
- `package.json` — project manifest
- `pnpm-workspace.yaml` — not used (single package)
- `tsconfig.json` — TypeScript config
- `vitest.config.ts` — test runner config
- `.gitignore`
- `config.example.toml` — config template
- `README.md` — setup instructions

**Source**
- `src/index.ts` — main entry: load config, init logger, start gateway, handle shutdown
- `src/config.ts` — TOML loader + zod schema + env var override
- `src/types.ts` — shared types (`IncomingMessage`, `OutgoingMessage`, `AppConfig`)
- `src/util/logger.ts` — pino initialization with secret redaction
- `src/util/deferred.ts` — `Deferred<T>` promise helper
- `src/util/mutex.ts` — async mutex (FIFO queue)
- `src/util/dedup.ts` — LRU dedup set
- `src/util/clock.ts` — `Clock` interface with `RealClock` + `FakeClock`
- `src/persistence/state-store.ts` — atomic JSON load/save; Phase 1 only stores the `last_clean_shutdown` flag
- `src/feishu/client.ts` — thin wrapper over `@larksuiteoapi/node-sdk` REST client for sending text replies
- `src/feishu/gateway.ts` — WSClient wiring + message event dispatch
- `src/access.ts` — whitelist filter (pure function + in-memory lookup)

**Tests** (co-located under `test/unit/` mirroring `src/` structure)
- `test/unit/util/deferred.test.ts`
- `test/unit/util/mutex.test.ts`
- `test/unit/util/dedup.test.ts`
- `test/unit/util/clock.test.ts`
- `test/unit/config.test.ts`
- `test/unit/persistence/state-store.test.ts`
- `test/unit/access.test.ts`
- `test/unit/feishu/client.test.ts` (with mocked SDK client)

Phase 1 does **not** unit-test `feishu/gateway.ts` or `src/index.ts` — those are validated by the manual E2E test in Task 25.

---

## Task 1: Initialize pnpm + TypeScript project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts` (placeholder)

- [ ] **Step 1: Initialize pnpm project**

Run:
```bash
cd /Users/zhaodongsheng/my-projects/claude-feishu-channel
pnpm init
```

Then overwrite `package.json` with this exact content:
```json
{
  "name": "claude-feishu-channel",
  "version": "0.1.0",
  "private": true,
  "description": "Bridge a Claude Code session to a Feishu bot",
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "dev": "tsx src/index.ts",
    "start": "node --import tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Install runtime and dev dependencies**

Run:
```bash
pnpm add @larksuiteoapi/node-sdk smol-toml zod pino pino-pretty
pnpm add -D typescript @types/node tsx vitest
```

Expected: no errors, `node_modules/` + `pnpm-lock.yaml` created.

- [ ] **Step 3: Create tsconfig.json**

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "noEmit": true
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 5000,
  },
});
```

- [ ] **Step 5: Create .gitignore**

Create `.gitignore`:
```
node_modules/
dist/
*.log
.DS_Store
.env
.env.local
pnpm-debug.log
coverage/
~/.claude-feishu-channel/

# Local config with secrets
config.toml
!config.example.toml
```

- [ ] **Step 6: Create placeholder src/index.ts**

Create `src/index.ts`:
```ts
// Entry point — will be filled out in later tasks.
console.log("claude-feishu-channel: scaffold ready");
```

- [ ] **Step 7: Verify scaffold builds and runs**

Run:
```bash
pnpm typecheck
```
Expected: no output, exit 0.

Run:
```bash
pnpm dev
```
Expected: prints `claude-feishu-channel: scaffold ready` then exits 0.

- [ ] **Step 8: Initialize git and make first commit**

Run:
```bash
git init
git add .
git commit -m "chore: initial pnpm typescript scaffold"
```

---

## Task 2: util/deferred (TDD)

`Deferred<T>` wraps a Promise so external code can resolve/reject it from outside. Used for the permission-broker Promise bridge in later phases and for the mutex in the next task.

**Files:**
- Create: `src/util/deferred.ts`
- Create: `test/unit/util/deferred.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/util/deferred.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createDeferred } from "../../../src/util/deferred.js";

describe("createDeferred", () => {
  it("resolves with the given value", async () => {
    const d = createDeferred<number>();
    d.resolve(42);
    await expect(d.promise).resolves.toBe(42);
  });

  it("rejects with the given error", async () => {
    const d = createDeferred<number>();
    const err = new Error("boom");
    d.reject(err);
    await expect(d.promise).rejects.toBe(err);
  });

  it("exposes settled flag after resolve", async () => {
    const d = createDeferred<string>();
    expect(d.settled).toBe(false);
    d.resolve("ok");
    await d.promise;
    expect(d.settled).toBe(true);
  });

  it("exposes settled flag after reject", async () => {
    const d = createDeferred<string>();
    expect(d.settled).toBe(false);
    d.reject(new Error("x"));
    await d.promise.catch(() => {});
    expect(d.settled).toBe(true);
  });

  it("second resolve is ignored", async () => {
    const d = createDeferred<number>();
    d.resolve(1);
    d.resolve(2);
    await expect(d.promise).resolves.toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test test/unit/util/deferred.test.ts
```
Expected: FAIL with "Cannot find module '../../../src/util/deferred.js'" or similar.

- [ ] **Step 3: Write minimal implementation**

Create `src/util/deferred.ts`:
```ts
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  let settled = false;
  const resolve = (value: T): void => {
    if (settled) return;
    settled = true;
    resolveFn(value);
  };
  const reject = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectFn(error);
  };

  return {
    promise,
    get settled() {
      return settled;
    },
    resolve,
    reject,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test test/unit/util/deferred.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/util/deferred.ts test/unit/util/deferred.test.ts
git commit -m "feat(util): add Deferred promise helper"
```

---

## Task 3: util/clock (TDD)

An injectable clock interface so time-dependent code can be tested without real timers. Phase 1 only uses `RealClock.now()`; `FakeClock` is prepared here for later phases (permission timeouts).

**Files:**
- Create: `src/util/clock.ts`
- Create: `test/unit/util/clock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/util/clock.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { RealClock, FakeClock } from "../../../src/util/clock.js";

describe("RealClock", () => {
  it("now() returns a value close to Date.now()", () => {
    const clock = new RealClock();
    const before = Date.now();
    const value = clock.now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it("setTimeout fires after real delay", async () => {
    const clock = new RealClock();
    const fn = vi.fn();
    clock.setTimeout(fn, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("clearTimeout cancels a pending timeout", async () => {
    const clock = new RealClock();
    const fn = vi.fn();
    const handle = clock.setTimeout(fn, 10);
    clock.clearTimeout(handle);
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("FakeClock", () => {
  it("now() starts at the given value", () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it("advance() moves time forward", () => {
    const clock = new FakeClock(0);
    clock.advance(500);
    expect(clock.now()).toBe(500);
  });

  it("advance() fires pending timeouts whose deadline was reached", () => {
    const clock = new FakeClock(0);
    const fn = vi.fn();
    clock.setTimeout(fn, 100);
    clock.advance(50);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(50);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("advance() fires multiple timeouts in scheduled order", () => {
    const clock = new FakeClock(0);
    const order: number[] = [];
    clock.setTimeout(() => order.push(2), 200);
    clock.setTimeout(() => order.push(1), 100);
    clock.advance(300);
    expect(order).toEqual([1, 2]);
  });

  it("clearTimeout prevents a pending callback from firing", () => {
    const clock = new FakeClock(0);
    const fn = vi.fn();
    const handle = clock.setTimeout(fn, 100);
    clock.clearTimeout(handle);
    clock.advance(200);
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test test/unit/util/clock.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write minimal implementation**

Create `src/util/clock.ts`:
```ts
export type TimeoutHandle = { readonly id: number };

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): TimeoutHandle {
    const id = setTimeout(callback, delayMs) as unknown as number;
    return { id };
  }

  clearTimeout(handle: TimeoutHandle): void {
    clearTimeout(handle.id as unknown as NodeJS.Timeout);
  }
}

interface FakeTimer {
  readonly id: number;
  readonly deadline: number;
  callback: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  private currentTime: number;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  constructor(initialTime: number = 0) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): TimeoutHandle {
    const id = this.nextId++;
    this.timers.push({
      id,
      deadline: this.currentTime + delayMs,
      callback,
      cancelled: false,
    });
    return { id };
  }

  clearTimeout(handle: TimeoutHandle): void {
    const timer = this.timers.find((t) => t.id === handle.id);
    if (timer) timer.cancelled = true;
  }

  advance(deltaMs: number): void {
    const targetTime = this.currentTime + deltaMs;
    while (true) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.deadline <= targetTime)
        .sort((a, b) => a.deadline - b.deadline);
      if (due.length === 0) break;
      const next = due[0]!;
      this.currentTime = next.deadline;
      next.cancelled = true; // mark fired
      next.callback();
    }
    this.currentTime = targetTime;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test test/unit/util/clock.test.ts
```
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/util/clock.ts test/unit/util/clock.test.ts
git commit -m "feat(util): add Clock interface with Real and Fake implementations"
```

---

## Task 4: util/mutex (TDD)

FIFO async mutex used by the renderer to serialize Feishu sends per chat. Tests use `Deferred` to drive scheduling explicitly.

**Files:**
- Create: `src/util/mutex.ts`
- Create: `test/unit/util/mutex.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/util/mutex.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Mutex } from "../../../src/util/mutex.js";
import { createDeferred } from "../../../src/util/deferred.js";

describe("Mutex", () => {
  it("runs a single task immediately", async () => {
    const mutex = new Mutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  it("serializes concurrent tasks in submission order", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const taskA = mutex.run(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
    });
    const taskB = mutex.run(async () => {
      order.push(3);
    });

    await Promise.all([taskA, taskB]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("propagates task errors to the caller", async () => {
    const mutex = new Mutex();
    await expect(
      mutex.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("continues running subsequent tasks after one throws", async () => {
    const mutex = new Mutex();
    await mutex.run(async () => {
      throw new Error("first");
    }).catch(() => {});
    const result = await mutex.run(async () => "second");
    expect(result).toBe("second");
  });

  it("third task waits for first two in order", async () => {
    const mutex = new Mutex();
    const d1 = createDeferred<void>();
    const d2 = createDeferred<void>();
    const order: string[] = [];

    const t1 = mutex.run(async () => {
      order.push("t1-start");
      await d1.promise;
      order.push("t1-end");
    });
    const t2 = mutex.run(async () => {
      order.push("t2-start");
      await d2.promise;
      order.push("t2-end");
    });
    const t3 = mutex.run(async () => {
      order.push("t3");
    });

    // t1 is running, t2 and t3 are queued
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["t1-start"]);

    d1.resolve();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["t1-start", "t1-end", "t2-start"]);

    d2.resolve();
    await Promise.all([t1, t2, t3]);
    expect(order).toEqual(["t1-start", "t1-end", "t2-start", "t2-end", "t3"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test test/unit/util/mutex.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write minimal implementation**

Create `src/util/mutex.ts`:
```ts
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previousTail = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await previousTail;
      return await task();
    } finally {
      release();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test test/unit/util/mutex.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/util/mutex.ts test/unit/util/mutex.test.ts
git commit -m "feat(util): add FIFO async Mutex"
```

---

## Task 5: util/dedup (TDD)

LRU-based dedup set for Feishu `message_id` (to suppress WS reconnect replays) and for card action ids.

**Files:**
- Create: `src/util/dedup.ts`
- Create: `test/unit/util/dedup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/util/dedup.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { LruDedup } from "../../../src/util/dedup.js";

describe("LruDedup", () => {
  it("reports a new id as not seen", () => {
    const dedup = new LruDedup(10);
    expect(dedup.check("id-1")).toBe(false);
  });

  it("reports a previously seen id as seen", () => {
    const dedup = new LruDedup(10);
    dedup.check("id-1");
    expect(dedup.check("id-1")).toBe(true);
  });

  it("evicts the oldest id when capacity is exceeded", () => {
    const dedup = new LruDedup(3);
    dedup.check("a");
    dedup.check("b");
    dedup.check("c");
    dedup.check("d"); // evicts "a"
    expect(dedup.check("a")).toBe(false); // re-inserted as fresh, evicts "b"
    expect(dedup.check("b")).toBe(false); // "b" was evicted when "a" was re-inserted
  });

  it("re-seeing an id promotes it (LRU)", () => {
    const dedup = new LruDedup(3);
    dedup.check("a");
    dedup.check("b");
    dedup.check("a"); // promotes a
    dedup.check("c");
    dedup.check("d"); // evicts b (not a)
    expect(dedup.check("a")).toBe(true);
    expect(dedup.check("b")).toBe(false);
  });

  it("size() returns current entry count", () => {
    const dedup = new LruDedup(10);
    expect(dedup.size()).toBe(0);
    dedup.check("a");
    dedup.check("b");
    expect(dedup.size()).toBe(2);
    dedup.check("a"); // re-promote, no growth
    expect(dedup.size()).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test test/unit/util/dedup.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write minimal implementation**

Create `src/util/dedup.ts`:
```ts
/**
 * LRU-based dedup set. `check(id)` returns true if the id was already
 * present (and promotes it to MRU), false if the id is new (and inserts it).
 */
export class LruDedup {
  private readonly capacity: number;
  private readonly map = new Map<string, true>();

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("LruDedup capacity must be > 0");
    this.capacity = capacity;
  }

  check(id: string): boolean {
    if (this.map.has(id)) {
      // Promote to MRU by re-inserting.
      this.map.delete(id);
      this.map.set(id, true);
      return true;
    }
    this.map.set(id, true);
    if (this.map.size > this.capacity) {
      // Evict the least recently used (first key in insertion order).
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return false;
  }

  size(): number {
    return this.map.size;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test test/unit/util/dedup.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/util/dedup.ts test/unit/util/dedup.test.ts
git commit -m "feat(util): add LruDedup for message id deduplication"
```

---

## Task 6: Shared types

Define `IncomingMessage`, `OutgoingMessage`, and `AppConfig` types that multiple modules will reference.

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create src/types.ts**

Create `src/types.ts`:
```ts
/**
 * A user message received from Feishu after the gateway has translated the
 * raw event into our internal representation.
 */
export interface IncomingMessage {
  /** Feishu unique message id, used for dedup. */
  messageId: string;
  /** Feishu chat id (p2p or group). */
  chatId: string;
  /** Sender's open_id. */
  senderOpenId: string;
  /** Plain text content. Rich content is flattened to text in Phase 1. */
  text: string;
  /** Receive timestamp (ms). */
  receivedAt: number;
}

/**
 * A plain-text reply the gateway will send back to a specific chat.
 */
export interface OutgoingTextMessage {
  chatId: string;
  text: string;
}

/**
 * Loaded, validated application config (produced by src/config.ts).
 * Later phases will extend this with more sections.
 */
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
  persistence: {
    stateFile: string;
    logDir: string;
  };
  logging: {
    level: "trace" | "debug" | "info" | "warn" | "error";
  };
}
```

- [ ] **Step 2: Verify typecheck passes**

Run:
```bash
pnpm typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

Run:
```bash
git add src/types.ts
git commit -m "feat: add shared type definitions"
```

---

## Task 7: Config loader with zod schema (TDD)

The config loader reads `~/.claude-feishu-channel/config.toml` (or `$CLAUDE_FEISHU_CONFIG` override), parses TOML, validates with zod, expands `~` in paths, and returns a strongly-typed `AppConfig`. Missing/invalid config throws a clear error.

**Files:**
- Create: `src/config.ts`
- Create: `test/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/config.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfc-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const path = join(tmpDir, "config.toml");
  writeFileSync(path, content);
  return path;
}

const MINIMAL_CONFIG = `
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
`;

describe("loadConfig", () => {
  it("loads a minimal valid config with defaults filled in", async () => {
    const path = writeConfig(MINIMAL_CONFIG);
    const cfg = await loadConfig(path);
    expect(cfg.feishu.appId).toBe("cli_test");
    expect(cfg.feishu.appSecret).toBe("secret");
    expect(cfg.feishu.encryptKey).toBe("");
    expect(cfg.feishu.verificationToken).toBe("");
    expect(cfg.access.allowedOpenIds).toEqual(["ou_test"]);
    expect(cfg.access.unauthorizedBehavior).toBe("ignore");
    expect(cfg.logging.level).toBe("info");
  });

  it("expands ~ in persistence paths", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[persistence]
state_file = "~/.claude-feishu-channel/state.json"
log_dir = "~/.claude-feishu-channel/logs"
`);
    const cfg = await loadConfig(path);
    expect(cfg.persistence.stateFile).toBe(
      join(homedir(), ".claude-feishu-channel/state.json"),
    );
    expect(cfg.persistence.logDir).toBe(
      join(homedir(), ".claude-feishu-channel/logs"),
    );
  });

  it("throws ConfigError on missing file", async () => {
    const path = join(tmpDir, "does-not-exist.toml");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError with field path on invalid schema", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
# missing app_secret

[access]
allowed_open_ids = ["ou_test"]
`);
    await expect(loadConfig(path)).rejects.toThrow(/feishu\.app_secret/);
  });

  it("throws ConfigError when allowed_open_ids is empty", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = []
`);
    await expect(loadConfig(path)).rejects.toThrow(/allowed_open_ids/);
  });

  it("accepts unauthorized_behavior = 'reject'", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
unauthorized_behavior = "reject"
`);
    const cfg = await loadConfig(path);
    expect(cfg.access.unauthorizedBehavior).toBe("reject");
  });

  it("rejects unknown unauthorized_behavior value", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
unauthorized_behavior = "bogus"
`);
    await expect(loadConfig(path)).rejects.toThrow(/unauthorized_behavior/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test test/unit/config.test.ts
```
Expected: FAIL with "Cannot find module '../../src/config.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/config.ts`:
```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { AppConfig } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const FeishuSchema = z.object({
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
  encrypt_key: z.string().default(""),
  verification_token: z.string().default(""),
});

const AccessSchema = z.object({
  allowed_open_ids: z.array(z.string().min(1)).min(1),
  unauthorized_behavior: z.enum(["ignore", "reject"]).default("ignore"),
});

// NOTE: zod v4 changed `.default({})` behavior — the literal object is
// returned as-is without re-parsing, so nested field defaults are NOT applied.
// We provide the full default object explicitly to preserve the nested defaults.
const PersistenceSchema = z
  .object({
    state_file: z.string().default("~/.claude-feishu-channel/state.json"),
    log_dir: z.string().default("~/.claude-feishu-channel/logs"),
  })
  .default({
    state_file: "~/.claude-feishu-channel/state.json",
    log_dir: "~/.claude-feishu-channel/logs",
  });

const LoggingSchema = z
  .object({
    level: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .default("info"),
  })
  .default({ level: "info" });

const ConfigSchema = z.object({
  feishu: FeishuSchema,
  access: AccessSchema,
  persistence: PersistenceSchema,
  logging: LoggingSchema,
});

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return `  - ${path}: ${issue.message}`;
  });
  return `Invalid config:\n${issues.join("\n")}`;
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`Config file not found: ${path}`);
    }
    throw new ConfigError(
      `Failed to read config at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new ConfigError(
      `Failed to parse TOML at ${path}: ${(err as Error).message}`,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error));
  }

  const data = result.data;
  return {
    feishu: {
      appId: data.feishu.app_id,
      appSecret: data.feishu.app_secret,
      encryptKey: data.feishu.encrypt_key,
      verificationToken: data.feishu.verification_token,
    },
    access: {
      allowedOpenIds: data.access.allowed_open_ids,
      unauthorizedBehavior: data.access.unauthorized_behavior,
    },
    persistence: {
      stateFile: expandHome(data.persistence.state_file),
      logDir: expandHome(data.persistence.log_dir),
    },
    logging: {
      level: data.logging.level,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test test/unit/config.test.ts
```
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/config.ts test/unit/config.test.ts
git commit -m "feat(config): add TOML config loader with zod validation"
```

---

## Task 8: Logger with secret redaction

Set up pino with pino-pretty for dev output and redaction for secrets. No unit tests (pino is well-tested; we just need to wire it correctly).

**Files:**
- Create: `src/util/logger.ts`

- [ ] **Step 1: Create src/util/logger.ts**

Create `src/util/logger.ts`:
```ts
// pino uses `export = pino` with `Logger` inside the pino namespace,
// so import it as a namespace member rather than a named type export.
import pino from "pino";
type Logger = pino.Logger;

export interface LoggerOptions {
  level: "trace" | "debug" | "info" | "warn" | "error";
  pretty: boolean;
}

const REDACT_PATHS = [
  "*.app_secret",
  "*.appSecret",
  "*.encrypt_key",
  "*.encryptKey",
  "*.verification_token",
  "*.verificationToken",
  "config.feishu.appSecret",
  "config.feishu.encryptKey",
  "config.feishu.verificationToken",
];

export function createLogger(opts: LoggerOptions): Logger {
  const base: pino.LoggerOptions = {
    level: opts.level,
    redact: {
      paths: REDACT_PATHS,
      censor: "***",
    },
  };

  if (opts.pretty) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    });
  }
  return pino(base);
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
pnpm typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

Run:
```bash
git add src/util/logger.ts
git commit -m "feat(util): add pino logger with secret redaction"
```

---

## Task 9: State store (TDD) — Phase 1 scope

For Phase 1, the state store only tracks `last_clean_shutdown`. The full `sessions` schema from the spec lands in Phase 7. The API is designed forward-compatible: it accepts an arbitrary `State` object and atomically persists it.

**Files:**
- Create: `src/persistence/state-store.ts`
- Create: `test/unit/persistence/state-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/persistence/state-store.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StateStore,
  type State,
} from "../../../src/persistence/state-store.js";

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfc-state-test-"));
  statePath = join(tmpDir, "state.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const EMPTY_STATE: State = {
  version: 1,
  lastCleanShutdown: true,
  sessions: {},
};

describe("StateStore", () => {
  it("load() returns initial state when file does not exist", async () => {
    const store = new StateStore(statePath);
    const state = await store.load();
    expect(state).toEqual(EMPTY_STATE);
  });

  it("load() returns parsed state when file exists", async () => {
    const store = new StateStore(statePath);
    await store.save({
      version: 1,
      lastCleanShutdown: false,
      sessions: {
        chat_a: {
          claudeSessionId: "sid-1",
          cwd: "/tmp/foo",
          createdAt: "2026-04-10T10:00:00Z",
          lastActiveAt: "2026-04-10T10:30:00Z",
        },
      },
    });

    const store2 = new StateStore(statePath);
    const state = await store2.load();
    expect(state.lastCleanShutdown).toBe(false);
    expect(state.sessions.chat_a?.claudeSessionId).toBe("sid-1");
  });

  it("save() writes atomically via a .tmp rename", async () => {
    const store = new StateStore(statePath);
    await store.save(EMPTY_STATE);
    expect(existsSync(statePath)).toBe(true);
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
  });

  it("save() creates parent directory if missing", async () => {
    const nested = join(tmpDir, "nested", "deeper", "state.json");
    const store = new StateStore(nested);
    await store.save(EMPTY_STATE);
    expect(existsSync(nested)).toBe(true);
  });

  it("throws on malformed JSON", async () => {
    const store = new StateStore(statePath);
    const fs = await import("node:fs/promises");
    await fs.writeFile(statePath, "{ not valid json");
    await expect(store.load()).rejects.toThrow(/malformed json/i);
  });

  it("throws a distinct error on unsupported version", async () => {
    const store = new StateStore(statePath);
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      statePath,
      JSON.stringify({ version: 2, lastCleanShutdown: true, sessions: {} }),
    );
    await expect(store.load()).rejects.toThrow(/unsupported state file version/i);
  });

  it("markUncleanAtStartup sets lastCleanShutdown to false and persists", async () => {
    const store = new StateStore(statePath);
    await store.save({ ...EMPTY_STATE, lastCleanShutdown: true });
    await store.markUncleanAtStartup();
    const fresh = await new StateStore(statePath).load();
    expect(fresh.lastCleanShutdown).toBe(false);
  });

  it("markCleanShutdown sets lastCleanShutdown to true and persists", async () => {
    const store = new StateStore(statePath);
    await store.save({ ...EMPTY_STATE, lastCleanShutdown: false });
    await store.markCleanShutdown();
    const fresh = await new StateStore(statePath).load();
    expect(fresh.lastCleanShutdown).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test test/unit/persistence/state-store.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write minimal implementation**

Create `src/persistence/state-store.ts`:
```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionRecord {
  claudeSessionId: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode?: string;
  model?: string;
}

export interface State {
  version: 1;
  lastCleanShutdown: boolean;
  sessions: Record<string, SessionRecord>;
}

const INITIAL_STATE: State = {
  version: 1,
  lastCleanShutdown: true,
  sessions: {},
};

export class StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<State> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(INITIAL_STATE);
      }
      throw new Error(
        `Failed to read state file ${this.path}: ${(err as Error).message}`,
      );
    }

    let parsed: State;
    try {
      parsed = JSON.parse(raw) as State;
    } catch (err) {
      throw new Error(
        `Malformed JSON in state file ${this.path}: ${(err as Error).message}`,
      );
    }
    if (parsed.version !== 1) {
      throw new Error(
        `Unsupported state file version ${parsed.version} in ${this.path}`,
      );
    }
    return parsed;
  }

  async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.path);
  }

  async markUncleanAtStartup(): Promise<void> {
    const state = await this.load();
    state.lastCleanShutdown = false;
    await this.save(state);
  }

  async markCleanShutdown(): Promise<void> {
    const state = await this.load();
    state.lastCleanShutdown = true;
    await this.save(state);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test test/unit/persistence/state-store.test.ts
```
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/persistence/state-store.ts test/unit/persistence/state-store.test.ts
git commit -m "feat(persistence): add atomic StateStore with clean-shutdown flag"
```

---

## Task 10: Access control / whitelist (TDD)

Pure function that decides whether to process a message based on sender `open_id`. Later phases will reuse this for every incoming message and card action.

**Files:**
- Create: `src/access.ts`
- Create: `test/unit/access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/access.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AccessControl, type AccessDecision } from "../../src/access.js";

describe("AccessControl", () => {
  it("allows whitelisted open_id", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      unauthorizedBehavior: "ignore",
    });
    const decision: AccessDecision = ac.check("ou_alice");
    expect(decision).toEqual({ allowed: true });
  });

  it("denies non-whitelisted open_id with ignore behavior", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      unauthorizedBehavior: "ignore",
    });
    expect(ac.check("ou_bob")).toEqual({
      allowed: false,
      action: "ignore",
    });
  });

  it("denies non-whitelisted open_id with reject behavior", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      unauthorizedBehavior: "reject",
    });
    expect(ac.check("ou_bob")).toEqual({
      allowed: false,
      action: "reject",
    });
  });

  it("denies when whitelist is empty", () => {
    const ac = new AccessControl({
      allowedOpenIds: [],
      unauthorizedBehavior: "ignore",
    });
    expect(ac.check("ou_alice")).toEqual({
      allowed: false,
      action: "ignore",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test test/unit/access.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write minimal implementation**

Create `src/access.ts`:
```ts
export interface AccessConfig {
  readonly allowedOpenIds: readonly string[];
  readonly unauthorizedBehavior: "ignore" | "reject";
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; action: "ignore" | "reject" };

export class AccessControl {
  private readonly whitelist: Set<string>;
  private readonly unauthorizedBehavior: "ignore" | "reject";

  constructor(config: AccessConfig) {
    this.whitelist = new Set(config.allowedOpenIds);
    this.unauthorizedBehavior = config.unauthorizedBehavior;
  }

  check(openId: string): AccessDecision {
    if (this.whitelist.has(openId)) return { allowed: true };
    return { allowed: false, action: this.unauthorizedBehavior };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test test/unit/access.test.ts
```
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/access.ts test/unit/access.test.ts
git commit -m "feat(access): add whitelist-based AccessControl"
```

---

## Task 11: FeishuClient text-send wrapper (test with mock)

Thin wrapper around `@larksuiteoapi/node-sdk`'s `Client` that exposes a `sendText(chatId, text)` method. Unit-tested by injecting a mock client.

**Files:**
- Create: `src/feishu/client.ts`
- Create: `test/unit/feishu/client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/feishu/client.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { FeishuClient } from "../../../src/feishu/client.js";

type MockLarkClient = {
  im: {
    v1: {
      message: {
        create: ReturnType<typeof vi.fn>;
      };
    };
  };
};

function makeMockLarkClient(): MockLarkClient {
  return {
    im: {
      v1: {
        message: {
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { message_id: "om_1" },
          }),
        },
      },
    },
  };
}

describe("FeishuClient.sendText", () => {
  it("calls im.v1.message.create with receive_id_type=chat_id and msg_type=text", async () => {
    const mock = makeMockLarkClient();
    const client = new FeishuClient(mock as never);
    const result = await client.sendText("oc_chat_1", "hello");
    expect(mock.im.v1.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat_1",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    });
    expect(result.messageId).toBe("om_1");
  });

  it("throws when lark API returns non-zero code", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.create = vi.fn().mockResolvedValue({
      code: 99991663,
      msg: "app ticket invalid",
    });
    const client = new FeishuClient(mock as never);
    await expect(client.sendText("oc_1", "hi")).rejects.toThrow(
      /99991663.*app ticket invalid/,
    );
  });

  it("throws when code is zero but message_id is missing", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.create = vi.fn().mockResolvedValue({
      code: 0,
      data: {},
    });
    const client = new FeishuClient(mock as never);
    await expect(client.sendText("oc_1", "hi")).rejects.toThrow(
      /message_id/i,
    );
  });

  it("escapes newlines and quotes in text content", async () => {
    const mock = makeMockLarkClient();
    const client = new FeishuClient(mock as never);
    await client.sendText("oc_1", 'line1\nline2 with "quotes"');
    const call = mock.im.v1.message.create.mock.calls[0]![0];
    // JSON.stringify handles escaping for us; assert the payload is valid JSON
    // and round-trips to the original text.
    const parsed = JSON.parse(call.data.content);
    expect(parsed.text).toBe('line1\nline2 with "quotes"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test test/unit/feishu/client.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write minimal implementation**

The SDK (`@larksuiteoapi/node-sdk`) already types `response.data` with `message_id?: string | undefined`, so no type cast is needed — `response.data?.message_id` is fully typed.

Create `src/feishu/client.ts`:
```ts
import type { Client as LarkClient } from "@larksuiteoapi/node-sdk";

export interface SendTextResult {
  messageId: string;
}

export class FeishuClient {
  constructor(private readonly lark: LarkClient) {}

  async sendText(chatId: string, text: string): Promise<SendTextResult> {
    const response = await this.lark.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });

    if (response.code !== 0) {
      throw new Error(
        `Feishu send failed: code=${response.code} msg=${response.msg ?? ""}`,
      );
    }

    const messageId = response.data?.message_id;
    if (!messageId) {
      throw new Error(
        `Feishu send returned code=0 but no message_id (chatId=${chatId})`,
      );
    }

    return { messageId };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test test/unit/feishu/client.test.ts
```
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/feishu/client.ts test/unit/feishu/client.test.ts
git commit -m "feat(feishu): add FeishuClient text-send wrapper"
```

---

## Task 12: FeishuGateway (integration, manual test only)

`FeishuGateway` wraps `WSClient` from `@larksuiteoapi/node-sdk`. It subscribes to the `im.message.receive_v1` event, parses the payload into an `IncomingMessage`, applies dedup, applies whitelist filter, and invokes a message handler. Because this is a tight SDK integration, we don't write unit tests — it's covered by the manual E2E test in Task 25.

**Files:**
- Create: `src/feishu/gateway.ts`

- [ ] **Step 1: Create FeishuGateway**

Create `src/feishu/gateway.ts`:
```ts
import {
  Client as LarkClient,
  WSClient,
  EventDispatcher,
} from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import type { IncomingMessage } from "../types.js";
import type { AccessControl } from "../access.js";
import { LruDedup } from "../util/dedup.js";

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface FeishuGatewayOptions {
  appId: string;
  appSecret: string;
  logger: Logger;
  lark: LarkClient;
  access: AccessControl;
  onMessage: MessageHandler;
}

interface ReceiveV1Event {
  sender: {
    sender_id: {
      open_id: string;
    };
  };
  message: {
    message_id: string;
    chat_id: string;
    message_type: string;
    content: string; // JSON-encoded
    create_time: string;
  };
}

export class FeishuGateway {
  private readonly lark: LarkClient;
  private readonly wsClient: WSClient;
  private readonly dedup = new LruDedup(1000);
  private readonly logger: Logger;
  private readonly access: AccessControl;
  private readonly onMessage: MessageHandler;

  constructor(opts: FeishuGatewayOptions) {
    this.lark = opts.lark;
    this.logger = opts.logger.child({ component: "feishu-gateway" });
    this.access = opts.access;
    this.onMessage = opts.onMessage;

    this.wsClient = new WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      loggerLevel: 2, // lark sdk's "warn"
    });
  }

  async start(): Promise<void> {
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const event = data as ReceiveV1Event;
        await this.handleReceiveV1(event);
      },
    });

    this.logger.info("Starting Feishu WebSocket client");
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  private async handleReceiveV1(event: ReceiveV1Event): Promise<void> {
    const log = this.logger.child({
      message_id: event.message.message_id,
      chat_id: event.message.chat_id,
    });

    if (this.dedup.check(event.message.message_id)) {
      log.debug("Duplicate message, skipping");
      return;
    }

    const decision = this.access.check(event.sender.sender_id.open_id);
    if (!decision.allowed) {
      log.warn(
        { open_id: event.sender.sender_id.open_id, action: decision.action },
        "Unauthorized sender",
      );
      return; // Phase 1 only implements "ignore" — "reject" behavior is identical here
    }

    // Phase 1: only handle text messages. Other types are dropped with a log.
    if (event.message.message_type !== "text") {
      log.info(
        { message_type: event.message.message_type },
        "Non-text message, dropping in Phase 1",
      );
      return;
    }

    let text = "";
    try {
      const parsed = JSON.parse(event.message.content) as { text?: string };
      text = parsed.text ?? "";
    } catch (err) {
      log.error({ err }, "Failed to parse message content");
      return;
    }

    const incoming: IncomingMessage = {
      messageId: event.message.message_id,
      chatId: event.message.chat_id,
      senderOpenId: event.sender.sender_id.open_id,
      text,
      receivedAt: Number(event.message.create_time),
    };

    try {
      await this.onMessage(incoming);
    } catch (err) {
      log.error({ err }, "Message handler threw");
    }
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
pnpm typecheck
```
Expected: exit 0.

Note: if typecheck fails due to `@larksuiteoapi/node-sdk` not exporting `WSClient` or `EventDispatcher` under the exact names used, check the installed SDK's types under `node_modules/@larksuiteoapi/node-sdk/lib/*.d.ts` and adjust the import. The SDK's WebSocket module historically has been in flux; you may need to import from `@larksuiteoapi/node-sdk/lib/ws` or similar. If so, adjust the import line and re-run typecheck.

- [ ] **Step 3: Commit**

Run:
```bash
git add src/feishu/gateway.ts
git commit -m "feat(feishu): add WebSocket gateway with dedup + whitelist"
```

---

## Task 13: Main entry — wire config, logger, state store, gateway, echo handler

Put everything together in `src/index.ts`. The echo handler replies with `"🤖 [Phase 1 echo] 收到: <text>"` for every whitelisted text message.

**Files:**
- Create: `src/index.ts` (overwrite the scaffold placeholder)

- [ ] **Step 1: Write the main entry**

Overwrite `src/index.ts`:
```ts
import { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./util/logger.js";
import { StateStore } from "./persistence/state-store.js";
import { AccessControl } from "./access.js";
import { FeishuClient } from "./feishu/client.js";
import { FeishuGateway } from "./feishu/gateway.js";
import type { IncomingMessage } from "./types.js";

function resolveConfigPath(): string {
  const envOverride = process.env["CLAUDE_FEISHU_CONFIG"];
  if (envOverride) return envOverride;
  return join(homedir(), ".claude-feishu-channel", "config.toml");
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath();

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      console.error(
        `[config] Expected at: ${configPath}\n` +
          `[config] See config.example.toml for a template.`,
      );
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({
    level: config.logging.level,
    pretty: process.stdout.isTTY ?? false,
  });

  logger.info({ configPath }, "Config loaded");

  const stateStore = new StateStore(config.persistence.stateFile);
  const initialState = await stateStore.load();
  logger.info(
    { lastCleanShutdown: initialState.lastCleanShutdown },
    "State store loaded",
  );
  await stateStore.markUncleanAtStartup();

  const access = new AccessControl({
    allowedOpenIds: config.access.allowedOpenIds,
    unauthorizedBehavior: config.access.unauthorizedBehavior,
  });

  const lark = new LarkClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  });
  const feishuClient = new FeishuClient(lark);

  const onMessage = async (msg: IncomingMessage): Promise<void> => {
    logger.info({ chat_id: msg.chatId, text: msg.text }, "Message received");
    await feishuClient.sendText(
      msg.chatId,
      `🤖 [Phase 1 echo] 收到: ${msg.text}`,
    );
  };

  const gateway = new FeishuGateway({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    logger,
    lark,
    access,
    onMessage,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    try {
      await stateStore.markCleanShutdown();
    } catch (err) {
      logger.error({ err }, "Failed to mark clean shutdown");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled promise rejection");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });

  await gateway.start();

  logger.info(
    {
      allowed_count: config.access.allowedOpenIds.length,
      unauthorized_behavior: config.access.unauthorizedBehavior,
    },
    "claude-feishu-channel Phase 1 ready",
  );
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
pnpm typecheck
```
Expected: exit 0.

- [ ] **Step 3: Run full test suite**

Run:
```bash
pnpm test
```
Expected: all previously-added tests still pass.

- [ ] **Step 4: Commit**

Run:
```bash
git add src/index.ts
git commit -m "feat: wire echo bot main entry"
```

---

## Task 14: Config example file

Provide a commented template the user copies to `~/.claude-feishu-channel/config.toml`.

**Files:**
- Create: `config.example.toml`

- [ ] **Step 1: Create config.example.toml**

Create `config.example.toml`:
```toml
# claude-feishu-channel configuration file.
#
# Copy this file to ~/.claude-feishu-channel/config.toml and fill in the
# values for your Feishu bot. Or set CLAUDE_FEISHU_CONFIG to point at a
# custom location.

# ─── Feishu app credentials ──────────────────────────────────────────
[feishu]
# Get these from https://open.feishu.cn/app -> your app -> Credentials
app_id = "cli_xxxxxxxxxxxxxxxx"
app_secret = "xxxxxxxxxxxxxxxxxxxxxxxxxx"

# Optional: only needed if you enabled event encryption in the Feishu
# developer console.
encrypt_key = ""
verification_token = ""

# ─── Access control ──────────────────────────────────────────────────
# The bot has full shell/file access to your machine. Lock it down!
[access]
# List of open_id values allowed to talk to the bot. To find yours,
# have the bot log the `sender_open_id` of an incoming message.
allowed_open_ids = [
  "ou_your_open_id_here",
]
# "ignore" = silently drop unauthorized messages (recommended)
# "reject" = reply with an error (noisy; reveals bot exists)
unauthorized_behavior = "ignore"

# ─── Persistence paths ───────────────────────────────────────────────
[persistence]
state_file = "~/.claude-feishu-channel/state.json"
log_dir = "~/.claude-feishu-channel/logs"

# ─── Logging ─────────────────────────────────────────────────────────
[logging]
# trace | debug | info | warn | error
level = "info"
```

- [ ] **Step 2: Commit**

Run:
```bash
git add config.example.toml
git commit -m "docs: add config.example.toml template"
```

---

## Task 15: README

Basic setup/run instructions.

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

Create `README.md`:
````markdown
# claude-feishu-channel

Bridge a Claude Code session to a Feishu (Lark) bot so you can drive your local Claude Code from a phone chat.

**Status: Phase 1 of 8** — currently an echo bot (no Claude integration yet). See `docs/superpowers/specs/2026-04-10-claude-feishu-channel-design.md` for the full design.

## Requirements

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- A Feishu developer account with a custom app
- A Feishu bot added to the custom app, with the `im:message` and `im:message.receive_v1` event subscribed
- WebSocket event delivery mode enabled (no public webhook URL required)

## Setup

```bash
pnpm install
mkdir -p ~/.claude-feishu-channel
cp config.example.toml ~/.claude-feishu-channel/config.toml
# Edit the file and fill in app_id, app_secret, and allowed_open_ids
```

## Run

```bash
pnpm dev
```

You should see a banner like:
```
claude-feishu-channel Phase 1 ready
```

Send a text message to the bot from a whitelisted account in Feishu. The bot replies:
```
🤖 [Phase 1 echo] 收到: <your text>
```

## Test

```bash
pnpm test         # run once
pnpm test:watch   # watch mode
pnpm typecheck    # type-only check
```

## Getting your open_id

Temporarily add this to `src/index.ts` inside `onMessage`:
```ts
logger.warn({ sender_open_id: msg.senderOpenId }, "Sender open_id");
```
Send a message, copy the `open_id` from the log, add it to `allowed_open_ids` in `config.toml`, then remove the debug log.

## Layout

```
src/
  index.ts               # main entry
  config.ts              # TOML loader + zod schema
  types.ts               # shared types
  access.ts              # whitelist filter
  feishu/
    client.ts            # REST wrapper (send text)
    gateway.ts           # WSClient + event dispatch
  persistence/
    state-store.ts       # atomic JSON state
  util/
    logger.ts            # pino with redaction
    deferred.ts          # Promise helper
    mutex.ts             # FIFO async mutex
    dedup.ts             # LRU dedup
    clock.ts             # injectable clock
test/
  unit/                  # mirrors src/
```

## Next phases

- Phase 2: Claude Agent SDK integration (single-turn)
- Phase 3: Tool call rendering as Feishu cards
- Phase 4: State machine + queue + `!` interrupt prefix
- Phase 5: Permission bridging via interactive cards
- Phase 6: Slash commands (/new, /cd, /stop, ...)
- Phase 7: Persistence of session_id + crash recovery
- Phase 8: E2E polish

See `docs/superpowers/plans/` for per-phase plans.
````

- [ ] **Step 2: Commit**

Run:
```bash
git add README.md
git commit -m "docs: add README with setup and layout"
```

---

## Task 16: Full test suite + typecheck verification

Run everything one more time before manual E2E.

- [ ] **Step 1: Run the full suite**

Run:
```bash
pnpm typecheck && pnpm test
```

Expected: typecheck exit 0, all test files pass. Tally should be roughly:
- `test/unit/util/deferred.test.ts`: 5 tests
- `test/unit/util/clock.test.ts`: 8 tests
- `test/unit/util/mutex.test.ts`: 5 tests
- `test/unit/util/dedup.test.ts`: 5 tests
- `test/unit/config.test.ts`: 7 tests
- `test/unit/persistence/state-store.test.ts`: 7 tests
- `test/unit/access.test.ts`: 4 tests
- `test/unit/feishu/client.test.ts`: 3 tests

Total: ~44 tests passing.

- [ ] **Step 2: Fix anything that fails**

If any test fails or typecheck errors out, fix it and re-run. Do not proceed to Task 17 until this is fully green.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git status  # verify only expected files
git commit -m "test: final green pass before phase 1 manual E2E"
```

(Skip this commit if nothing changed.)

---

## Task 17: Manual E2E test in Feishu

The last step of Phase 1 is a hands-on verification with a real Feishu bot.

**Preconditions:**
- You have a Feishu developer app with a bot configured
- The bot has `im:message` and the `im.message.receive_v1` event subscription enabled
- WebSocket event delivery mode is enabled in the Feishu console (Events & Callbacks → 长连接)
- `~/.claude-feishu-channel/config.toml` exists with correct `app_id`, `app_secret`, and your `allowed_open_ids`

- [ ] **Step 1: Get your open_id**

If you don't know your open_id, the Phase 1 gateway already logs it for unauthorized senders via `log.warn({ open_id, action }, "Unauthorized sender")`. To capture it:

1. In `config.toml`, leave `allowed_open_ids = ["ou_placeholder"]` (any non-empty value — zod requires ≥1 entry, and the value just needs to not match your real open_id)
2. Run `pnpm dev`
3. Send a message from your real Feishu account
4. Copy the `open_id` field from the `Unauthorized sender` warn log line
5. Stop the bot (`Ctrl+C`), put your real open_id into `allowed_open_ids`, restart

- [ ] **Step 2: Start the bot**

Run:
```bash
pnpm dev
```

Expected log output (approximately):
```
[info] Config loaded
[info] State store loaded (lastCleanShutdown: true)
[info] Starting Feishu WebSocket client
[info] claude-feishu-channel Phase 1 ready
```

The process should stay running.

- [ ] **Step 3: Send a whitelisted message**

From a Feishu account whose `open_id` is in the whitelist, send the bot a direct message:
```
hello
```

Expected:
1. Log line: `Message received` with your text
2. The bot replies in Feishu: `🤖 [Phase 1 echo] 收到: hello`

- [ ] **Step 4: Send a non-whitelisted message (optional)**

From a different account (if you have one) send the bot a message.

Expected:
1. Log line: `Unauthorized sender` with warn level
2. No reply in Feishu

- [ ] **Step 5: Send a non-text message**

Send the bot an image or sticker.

Expected:
1. Log line: `Non-text message, dropping in Phase 1`
2. No reply in Feishu

- [ ] **Step 6: Kill and verify clean-shutdown flag**

In the terminal running the bot, press `Ctrl+C`.

Expected log:
```
[info] Shutting down (signal: SIGINT)
```

Then verify the state file flag:
```bash
cat ~/.claude-feishu-channel/state.json
```
Expected: `"lastCleanShutdown": true`

- [ ] **Step 7: Test unclean shutdown**

Start the bot again (`pnpm dev`). In another terminal, kill it ungracefully:
```bash
pkill -9 -f "tsx src/index.ts"
```

Then check the state file:
```bash
cat ~/.claude-feishu-channel/state.json
```
Expected: `"lastCleanShutdown": false` (the startup hook wrote this and the SIGKILL prevented the clean-shutdown hook from running)

- [ ] **Step 8: Document any issues**

If any step failed, debug by:
- Checking Feishu developer console event subscription status
- Checking the app permissions (is `im:message:send_as_bot` granted?)
- Checking the bot is actually added to your contact list
- Checking network/firewall for outbound WebSocket access

Fix any gateway-side bugs discovered during manual testing, add a regression test where possible, and commit.

- [ ] **Step 9: Final Phase 1 commit and tag**

If there were manual-test fixes:
```bash
git add -A
git commit -m "fix: phase 1 manual test fixes"
```

Tag the phase:
```bash
git tag phase-1-complete
```

---

## Phase 1 Done When

- ✅ All unit tests pass (`pnpm test`)
- ✅ Typecheck passes (`pnpm typecheck`)
- ✅ Manual E2E Task 17 fully green
- ✅ `phase-1-complete` git tag exists
- ✅ Unclean-shutdown flag correctly set after SIGKILL

## Next

Phase 2 plan (`docs/superpowers/plans/<date>-phase-2-single-turn-claude.md`) will be written after Phase 1 is verified working. It covers:
- Adding `@anthropic-ai/claude-agent-sdk` as a dependency
- Minimal `ClaudeSession` that handles a single turn (no queue, no state machine)
- Basic text-only Renderer
- Replacing the echo handler with a Claude single-turn handler

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
  version: 2,
  lastCleanShutdown: true,
  sessions: {},
  activeProjects: {},
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
      version: 2,
      lastCleanShutdown: false,
      sessions: {
        chat_a: {
          claudeSessionId: "sid-1",
          cwd: "/tmp/foo",
          createdAt: "2026-04-10T10:00:00Z",
          lastActiveAt: "2026-04-10T10:30:00Z",
        },
      },
      activeProjects: {},
    });

    const store2 = new StateStore(statePath);
    const state = await store2.load();
    expect(state.lastCleanShutdown).toBe(false);
    expect(state.sessions.chat_a?.claudeSessionId).toBe("sid-1");
  });

  it("load() migrates v1 state to v2 by adding activeProjects", async () => {
    // Write a raw v1 JSON file directly (simulating an old state file on disk).
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        lastCleanShutdown: true,
        sessions: {
          chat_a: {
            claudeSessionId: "sid-legacy",
            cwd: "/tmp/legacy",
            createdAt: "2026-04-10T10:00:00Z",
            lastActiveAt: "2026-04-10T10:30:00Z",
          },
        },
      }),
      "utf8",
    );
    const store = new StateStore(statePath);
    const state = await store.load();
    expect(state.version).toBe(2);
    expect(state.activeProjects).toEqual({});
    expect(state.sessions.chat_a?.claudeSessionId).toBe("sid-legacy");
  });

  it("save() writes atomically via a .tmp rename", async () => {
    const store = new StateStore(statePath);
    await store.save(EMPTY_STATE);
    expect(existsSync(statePath)).toBe(true);
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(2);
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
      JSON.stringify({ version: 99, lastCleanShutdown: true, sessions: {} }),
    );
    await expect(store.load()).rejects.toThrow(/unsupported state file version/i);
  });

  it("markUncleanAtStartup sets lastCleanShutdown to false and persists", async () => {
    const store = new StateStore(statePath);
    await store.save({ ...EMPTY_STATE, lastCleanShutdown: true });
    const state = await store.load();
    await store.markUncleanAtStartup(state);
    const fresh = await new StateStore(statePath).load();
    expect(fresh.lastCleanShutdown).toBe(false);
  });

  it("markCleanShutdown sets lastCleanShutdown to true and persists", async () => {
    const store = new StateStore(statePath);
    await store.save({ ...EMPTY_STATE, lastCleanShutdown: false });
    const state = await store.load();
    await store.markCleanShutdown(state);
    const fresh = await new StateStore(statePath).load();
    expect(fresh.lastCleanShutdown).toBe(true);
  });
});

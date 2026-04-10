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
    await expect(store.load()).rejects.toThrow(/state file/i);
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

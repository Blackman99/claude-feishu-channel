import { describe, it, expect } from "vitest";
import { ClaudeSessionManager } from "../../../src/claude/session-manager.js";
import type { QueryFn, SDKMessageLike } from "../../../src/claude/session.js";
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "./fakes/fake-question-broker.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import type {
  StateStore,
  SessionRecord,
  State,
} from "../../../src/persistence/state-store.js";
import type { FeishuClient } from "../../../src/feishu/client.js";
import { FakeQueryHandle } from "./fakes/fake-query-handle.js";
import { SpyRenderer } from "./fakes/spy-renderer.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
  permissionTimeoutMs: 300_000,
  permissionWarnBeforeMs: 60_000,
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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

class FakeFeishuClient {
  sentTexts: Array<{ chatId: string; text: string }> = [];
  async sendText(chatId: string, text: string) {
    this.sentTexts.push({ chatId, text });
    return { messageId: "om_fake" };
  }
}

describe("ClaudeSessionManager", () => {
  it("returns the same ClaudeSession instance for the same chat_id", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
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
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    const a = mgr.getOrCreate("oc_1");
    const b = mgr.getOrCreate("oc_2");
    expect(a).not.toBe(b);
  });

  it("delete() removes session — getOrCreate returns a new instance after delete", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    const before = mgr.getOrCreate("oc_1");
    mgr.delete("oc_1");
    const after = mgr.getOrCreate("oc_1");
    expect(after).not.toBe(before);
  });

  it("delete() on nonexistent chatId is a no-op and does not throw", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    expect(() => mgr.delete("nonexistent")).not.toThrow();
  });

  it("setCwdOverride causes next getOrCreate to use the overridden cwd", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });
    mgr.setCwdOverride("oc_1", "/custom/cwd");
    const session = mgr.getOrCreate("oc_1");
    expect(session.getStatus().cwd).toBe("/custom/cwd");
  });

  it("getOrCreate without cwdOverride uses config default cwd", () => {
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
});

// --- Persistence tests ---

describe("ClaudeSessionManager — Persistence startup", () => {
  it("startupLoad populates staleRecords from state.sessions", async () => {
    const store = new FakeStateStore();
    const record: SessionRecord = {
      claudeSessionId: "ses_abc",
      cwd: "/projects/foo",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: "acceptEdits",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_chat1"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
      sessionTtlDays: 30,
    });

    await mgr.startupLoad();

    // staleRecords should now hold this session — verify via getAllSessions
    const all = mgr.getAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0]!.chatId).toBe("oc_chat1");
    expect(all[0]!.active).toBe(false);
    expect(all[0]!.record.claudeSessionId).toBe("ses_abc");
  });

  it("startupLoad prunes sessions older than TTL", async () => {
    const store = new FakeStateStore();

    // One recent, one expired (35 days ago)
    const recent: SessionRecord = {
      claudeSessionId: "ses_recent",
      cwd: "/projects/foo",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    const expired: SessionRecord = {
      claudeSessionId: "ses_expired",
      cwd: "/projects/bar",
      createdAt: new Date(Date.now() - 35 * 86400_000).toISOString(),
      lastActiveAt: new Date(Date.now() - 35 * 86400_000).toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_recent"] = recent;
    store.state.sessions["oc_expired"] = expired;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
      sessionTtlDays: 30,
    });

    await mgr.startupLoad();

    const all = mgr.getAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0]!.chatId).toBe("oc_recent");
  });

  it("getOrCreate uses stale record cwd/mode/model/sessionId", async () => {
    const store = new FakeStateStore();
    const record: SessionRecord = {
      claudeSessionId: "ses_stale",
      cwd: "/projects/stale-cwd",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: "acceptEdits",
      model: "claude-sonnet-4-20250514",
    };
    store.state.sessions["oc_stale"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
    });

    await mgr.startupLoad();

    const session = mgr.getOrCreate("oc_stale");
    const status = session.getStatus();
    expect(status.cwd).toBe("/projects/stale-cwd");
    expect(status.permissionMode).toBe("acceptEdits");
    expect(status.model).toBe("claude-sonnet-4-20250514");
    expect(status.claudeSessionId).toBe("ses_stale");
  });

  it("cwdOverride takes priority over stale record cwd", async () => {
    const store = new FakeStateStore();
    const record: SessionRecord = {
      claudeSessionId: "ses_ov",
      cwd: "/projects/stale-cwd",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_ov"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
    });

    await mgr.startupLoad();
    mgr.setCwdOverride("oc_ov", "/override/cwd");
    const session = mgr.getOrCreate("oc_ov");
    expect(session.getStatus().cwd).toBe("/override/cwd");
  });
});

describe("ClaudeSessionManager — Save triggers", () => {
  it("onSessionIdCaptured triggers immediate save", async () => {
    const store = new FakeStateStore();
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fake.options = params.options;
      fakes.push(fake);
      return fake as unknown as ReturnType<QueryFn>;
    };

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
    });

    const session = mgr.getOrCreate("oc_sid");
    const spy = new SpyRenderer();

    // Submit a turn to start the process loop
    session.submit(
      {
        kind: "run",
        text: "hello",
        senderOpenId: "ou_sender",
        parentMessageId: "om_parent",
      },
      spy.emit,
    );
    await flushMicrotasks();

    const saveCountBefore = store.saveCount;

    // Emit a message with session_id — this triggers onSessionIdCaptured
    fakes[0]!.emitMessage({
      type: "system",
      subtype: "init",
      session_id: "ses_new123",
    });
    await flushMicrotasks();

    // Finish the turn
    fakes[0]!.finishWithSuccess({
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
    });
    await flushMicrotasks();

    // saveNow should have been called at least once after session_id captured
    expect(store.saveCount).toBeGreaterThan(saveCountBefore);
    // The saved state should contain the session with the session_id
    expect(store.lastSaved?.sessions["oc_sid"]?.claudeSessionId).toBe(
      "ses_new123",
    );
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
      stateStore: store as unknown as StateStore,
    });

    mgr.getOrCreate("oc_del");
    const saveCountBefore = store.saveCount;
    mgr.delete("oc_del");
    await flushMicrotasks();

    expect(store.saveCount).toBeGreaterThan(saveCountBefore);
  });

  it("turn completion triggers debounced save at 30s", async () => {
    const store = new FakeStateStore();
    const clock = new FakeClock();
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fake.options = params.options;
      fakes.push(fake);
      return fake as unknown as ReturnType<QueryFn>;
    };

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock,
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
    });

    const session = mgr.getOrCreate("oc_debounce");
    const spy = new SpyRenderer();

    session.submit(
      {
        kind: "run",
        text: "hello",
        senderOpenId: "ou_s",
        parentMessageId: "om_p",
      },
      spy.emit,
    );
    await flushMicrotasks();

    // Finish the turn — this triggers onTurnComplete → scheduleDebouncedSave
    fakes[0]!.finishWithSuccess({
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
    });
    await flushMicrotasks();

    const saveCountAfterTurn = store.saveCount;

    // Advance less than 30s — debounced save should NOT have fired
    clock.advance(20_000);
    await flushMicrotasks();
    expect(store.saveCount).toBe(saveCountAfterTurn);

    // Advance to 30s total — debounced save fires
    clock.advance(10_000);
    await flushMicrotasks();
    expect(store.saveCount).toBeGreaterThan(saveCountAfterTurn);
  });

  it("immediate save cancels pending debounced save", async () => {
    const store = new FakeStateStore();
    const clock = new FakeClock();

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock,
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
    });

    // Schedule a debounced save
    mgr.scheduleDebouncedSave();
    await flushMicrotasks();
    const countAfterSchedule = store.saveCount;

    // Trigger an immediate save via delete — should cancel debounce
    mgr.getOrCreate("oc_cancel");
    mgr.delete("oc_cancel");
    await flushMicrotasks();
    const countAfterDelete = store.saveCount;
    expect(countAfterDelete).toBeGreaterThan(countAfterSchedule);

    // Advance past 30s — debounced timer was cancelled, so no extra save
    clock.advance(35_000);
    await flushMicrotasks();
    expect(store.saveCount).toBe(countAfterDelete);
  });
});

describe("ClaudeSessionManager — Query methods", () => {
  it("findSession by claudeSessionId in active sessions", async () => {
    const store = new FakeStateStore();
    const fakes: FakeQueryHandle[] = [];
    const queryFn: QueryFn = (params) => {
      const fake = new FakeQueryHandle();
      fake.canUseTool = params.canUseTool;
      fake.options = params.options;
      fakes.push(fake);
      return fake as unknown as ReturnType<QueryFn>;
    };

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
    });

    const session = mgr.getOrCreate("oc_find");
    const spy = new SpyRenderer();

    session.submit(
      {
        kind: "run",
        text: "hello",
        senderOpenId: "ou_s",
        parentMessageId: "om_p",
      },
      spy.emit,
    );
    await flushMicrotasks();

    // Emit session_id
    fakes[0]!.emitMessage({
      type: "system",
      subtype: "init",
      session_id: "ses_findme",
    });
    await flushMicrotasks();

    fakes[0]!.finishWithSuccess({
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
    });
    await flushMicrotasks();

    const found = mgr.findSession("ses_findme");
    expect(found).toBeDefined();
    expect(found!.chatId).toBe("oc_find");
    expect(found!.record.claudeSessionId).toBe("ses_findme");
  });

  it("findSession by chatId in active sessions", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });

    mgr.getOrCreate("oc_bychat");
    const found = mgr.findSession("oc_bychat");
    expect(found).toBeDefined();
    expect(found!.chatId).toBe("oc_bychat");
  });

  it("findSession by chatId in staleRecords", async () => {
    const store = new FakeStateStore();
    const record: SessionRecord = {
      claudeSessionId: "ses_stale2",
      cwd: "/projects/stale",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_stale2"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
    });

    await mgr.startupLoad();

    const found = mgr.findSession("oc_stale2");
    expect(found).toBeDefined();
    expect(found!.chatId).toBe("oc_stale2");
    expect(found!.record.claudeSessionId).toBe("ses_stale2");
  });

  it("findSession returns undefined for unknown target", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
    });

    expect(mgr.findSession("nonexistent")).toBeUndefined();
  });

  it("getAllSessions merges active + stale", async () => {
    const store = new FakeStateStore();
    const record: SessionRecord = {
      claudeSessionId: "ses_stale_all",
      cwd: "/projects/stale",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_stale_all"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
    });

    await mgr.startupLoad();

    // Create an active session (different chatId from stale)
    mgr.getOrCreate("oc_active_all");

    const all = mgr.getAllSessions();
    expect(all).toHaveLength(2);

    const active = all.find((s) => s.chatId === "oc_active_all");
    const stale = all.find((s) => s.chatId === "oc_stale_all");
    expect(active).toBeDefined();
    expect(active!.active).toBe(true);
    expect(stale).toBeDefined();
    expect(stale!.active).toBe(false);
  });
});

describe("ClaudeSessionManager — Crash recovery", () => {
  it("sends notification to recently active sessions on unclean shutdown", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = new FakeFeishuClient();

    // Session active 5 minutes ago — within the 1-hour window
    const record: SessionRecord = {
      claudeSessionId: "ses_crash1",
      cwd: "/projects/crash",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_crash1"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
      feishuClient: fakeFeishu as unknown as FeishuClient,
    });

    await mgr.startupLoad();
    await mgr.crashRecovery(false);

    expect(fakeFeishu.sentTexts).toHaveLength(1);
    expect(fakeFeishu.sentTexts[0]!.chatId).toBe("oc_crash1");
    expect(fakeFeishu.sentTexts[0]!.text).toContain("异常重启");
  });

  it("does NOT send when lastCleanShutdown is true", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = new FakeFeishuClient();

    const record: SessionRecord = {
      claudeSessionId: "ses_clean",
      cwd: "/projects/clean",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_clean"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
      feishuClient: fakeFeishu as unknown as FeishuClient,
    });

    await mgr.startupLoad();
    await mgr.crashRecovery(true);

    expect(fakeFeishu.sentTexts).toHaveLength(0);
  });

  it("skips sessions inactive > 1 hour", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = new FakeFeishuClient();

    // Session active 2 hours ago — outside the 1-hour window
    const record: SessionRecord = {
      claudeSessionId: "ses_old",
      cwd: "/projects/old",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_old"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
      feishuClient: fakeFeishu as unknown as FeishuClient,
    });

    await mgr.startupLoad();
    await mgr.crashRecovery(false);

    expect(fakeFeishu.sentTexts).toHaveLength(0);
  });

  it("sendText failure does not throw", async () => {
    const store = new FakeStateStore();
    const fakeFeishu = {
      async sendText(_chatId: string, _text: string) {
        throw new Error("Feishu is down");
      },
    };

    const record: SessionRecord = {
      claudeSessionId: "ses_fail",
      cwd: "/projects/fail",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      permissionMode: "default",
      model: "claude-opus-4-6",
    };
    store.state.sessions["oc_fail"] = record;

    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
      clock: new FakeClock(),
      permissionBroker: new FakePermissionBroker(),
      questionBroker: new FakeQuestionBroker(),
      logger: SILENT_LOGGER,
      stateStore: store as unknown as StateStore,
      feishuClient: fakeFeishu as unknown as FeishuClient,
    });

    await mgr.startupLoad();
    // Should NOT throw even though sendText throws
    await expect(mgr.crashRecovery(false)).resolves.toBeUndefined();
  });
});

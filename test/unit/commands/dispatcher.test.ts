import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandDispatcher } from "../../../src/commands/dispatcher.js";
import type { CommandContext } from "../../../src/commands/dispatcher.js";
import { ClaudeSessionManager } from "../../../src/claude/session-manager.js";
import { FakePermissionBroker } from "../claude/fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "../claude/fakes/fake-question-broker.js";
import { FakeQueryHandle } from "../claude/fakes/fake-query-handle.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import type { QueryFn, SDKMessageLike } from "../../../src/claude/session.js";
import type { AppConfig } from "../../../src/types.js";
import type { FeishuClient } from "../../../src/feishu/client.js";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const NOOP_QUERY: QueryFn = () => ({
  messages: {
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessageLike, void> {
      yield { type: "result", subtype: "success", result: "" };
    },
  },
  interrupt: async () => {},
  setPermissionMode: () => {},
});

const BASE_CONFIG: AppConfig = {
  feishu: {
    appId: "cli_test",
    appSecret: "secret_test_value",
    encryptKey: "enc_key",
    verificationToken: "vt_token",
  },
  access: {
    allowedOpenIds: ["ou_alice"],
    unauthorizedBehavior: "ignore",
  },
  claude: {
    defaultCwd: "/tmp/cfc-test",
    defaultPermissionMode: "default",
    defaultModel: "claude-opus-4-6",
    cliPath: "claude",
    permissionTimeoutMs: 300_000,
    permissionWarnBeforeMs: 60_000,
  },
  render: {
    inlineMaxBytes: 8192,
    hideThinking: false,
    showTurnStats: true,
  },
  persistence: {
    stateFile: "/tmp/state.json",
    logDir: "/tmp/logs",
  },
  logging: {
    level: "info",
  },
  projects: {
    "my-app": "/home/user/my-app",
  },
};

const CTX: CommandContext = {
  chatId: "oc_1",
  senderOpenId: "ou_alice",
  parentMessageId: "om_p1",
};

function makeHarness() {
  const feishu = {
    replyText: vi.fn().mockResolvedValue({ messageId: "om_reply" }),
    replyCard: vi.fn().mockResolvedValue({ messageId: "om_card" }),
    patchCard: vi.fn().mockResolvedValue(undefined),
  } as unknown as FeishuClient;

  const permissionBroker = new FakePermissionBroker();
  const questionBroker = new FakeQuestionBroker();
  const clock = new FakeClock(0);

  const sessionManager = new ClaudeSessionManager({
    config: BASE_CONFIG.claude,
    queryFn: NOOP_QUERY,
    clock,
    permissionBroker,
    questionBroker,
    logger: SILENT_LOGGER,
  });

  const dispatcher = new CommandDispatcher({
    sessionManager,
    feishu,
    config: BASE_CONFIG,
    permissionBroker,
    questionBroker,
    clock,
    logger: SILENT_LOGGER,
  });

  return { feishu, sessionManager, dispatcher, clock };
}

/**
 * Harness with a blocking queryFn — turns stay in "generating" state
 * until the caller explicitly finishes them. Useful for testing
 * commands that require checking session state.
 */
function makeBlockingHarness() {
  const feishu = {
    replyText: vi.fn().mockResolvedValue({ messageId: "om_reply" }),
    replyCard: vi.fn().mockResolvedValue({ messageId: "om_card" }),
    patchCard: vi.fn().mockResolvedValue(undefined),
  } as unknown as FeishuClient;

  const permissionBroker = new FakePermissionBroker();
  const questionBroker = new FakeQuestionBroker();
  const clock = new FakeClock(0);
  const handles: FakeQueryHandle[] = [];

  const blockingQueryFn: QueryFn = () => {
    const handle = new FakeQueryHandle();
    handles.push(handle);
    return handle;
  };

  const sessionManager = new ClaudeSessionManager({
    config: BASE_CONFIG.claude,
    queryFn: blockingQueryFn,
    clock,
    permissionBroker,
    questionBroker,
    logger: SILENT_LOGGER,
  });

  const dispatcher = new CommandDispatcher({
    sessionManager,
    feishu,
    config: BASE_CONFIG,
    permissionBroker,
    questionBroker,
    clock,
    logger: SILENT_LOGGER,
  });

  return { feishu, sessionManager, dispatcher, handles };
}

describe("CommandDispatcher — simple commands", () => {
  describe("/help", () => {
    it("replies with text containing all command names", async () => {
      const { feishu, dispatcher } = makeHarness();

      await dispatcher.dispatch({ name: "help" }, CTX);

      expect(feishu.replyText).toHaveBeenCalledOnce();
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
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

  describe("/status", () => {
    it("replies with idle state, cwd, mode, and model", async () => {
      const { feishu, sessionManager, dispatcher } = makeHarness();

      // Create the session first
      sessionManager.getOrCreate("oc_1");

      await dispatcher.dispatch({ name: "status" }, CTX);

      expect(feishu.replyText).toHaveBeenCalledOnce();
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("idle");
      expect(text).toContain("/tmp/cfc-test"); // defaultCwd
      expect(text).toContain("default");       // defaultPermissionMode
      expect(text).toContain("claude-opus-4-6"); // defaultModel
    });
  });

  describe("/config show", () => {
    it("shows appId but masks appSecret with ***", async () => {
      const { feishu, dispatcher } = makeHarness();

      await dispatcher.dispatch({ name: "config_show" }, CTX);

      expect(feishu.replyText).toHaveBeenCalledOnce();
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("cli_test");
      expect(text).not.toContain("secret_test_value");
      expect(text).toContain("***");
    });
  });

  describe("unknown command", () => {
    it("dispatchUnknown replies with a hint to use /help", async () => {
      const { feishu, dispatcher } = makeHarness();

      await dispatcher.dispatchUnknown("/foo", CTX);

      expect(feishu.replyText).toHaveBeenCalledOnce();
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("/help");
    });
  });
});

describe("CommandDispatcher — /mode", () => {
  it("sets permission mode override on idle session and replies with mode name", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    const session = sessionManager.getOrCreate(CTX.chatId);
    expect(session.getState()).toBe("idle");

    await dispatcher.dispatch({ name: "mode", mode: "acceptEdits" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("acceptEdits");
    expect(session.getStatus().permissionMode).toBe("acceptEdits");
  });

  it("setting mode to 'default' clears the sticky flag", async () => {
    const { sessionManager, dispatcher } = makeHarness();

    const session = sessionManager.getOrCreate(CTX.chatId);
    // Set sticky flag manually
    session._testSetSessionAcceptEditsSticky(true);
    expect(session._testGetSessionAcceptEditsSticky()).toBe(true);

    await dispatcher.dispatch({ name: "mode", mode: "default" }, CTX);

    expect(session._testGetSessionAcceptEditsSticky()).toBe(false);
  });

  it("rejects when session is not idle — replyText contains '执行中', mode NOT changed", async () => {
    const { feishu, sessionManager, dispatcher } = makeBlockingHarness();

    const session = sessionManager.getOrCreate(CTX.chatId);
    // Start a turn to put session in generating state
    const noopEmit = async () => {};
    session.submit(
      { kind: "run", text: "hello", senderOpenId: "ou_alice", parentMessageId: "om_p0" },
      noopEmit,
    );
    await flushMicrotasks();
    expect(session.getState()).toBe("generating");

    await dispatcher.dispatch({ name: "mode", mode: "bypassPermissions" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("执行中");
    // Mode should NOT have been changed to bypassPermissions
    expect(session.getStatus().permissionMode).not.toBe("bypassPermissions");
  });
});

describe("CommandDispatcher — /model", () => {
  it("sets model override on idle session and replies with model name", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    const session = sessionManager.getOrCreate(CTX.chatId);
    expect(session.getState()).toBe("idle");

    await dispatcher.dispatch({ name: "model", model: "claude-opus-4-5" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("claude-opus-4-5");
    expect(session.getStatus().model).toBe("claude-opus-4-5");
  });

  it("rejects when session is not idle — replyText contains '执行中'", async () => {
    const { feishu, sessionManager, dispatcher } = makeBlockingHarness();

    const session = sessionManager.getOrCreate(CTX.chatId);
    // Start a turn to put session in generating state
    const noopEmit = async () => {};
    session.submit(
      { kind: "run", text: "hello", senderOpenId: "ou_alice", parentMessageId: "om_p0" },
      noopEmit,
    );
    await flushMicrotasks();
    expect(session.getState()).toBe("generating");

    await dispatcher.dispatch({ name: "model", model: "claude-haiku-3-5" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("执行中");
    // Model should NOT have been changed
    expect(session.getStatus().model).not.toBe("claude-haiku-3-5");
  });
});

describe("CommandDispatcher — /new", () => {
  it("in idle state: deletes session and replies", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    // Create a session with some turns
    const session = sessionManager.getOrCreate(CTX.chatId);
    // Confirm session exists (idle state)
    expect(session.getState()).toBe("idle");

    await dispatcher.dispatch({ name: "new" }, CTX);

    // Should reply with the expected message
    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("新会话");

    // After deletion, getOrCreate should return a fresh session (new object)
    const freshSession = sessionManager.getOrCreate(CTX.chatId);
    expect(freshSession).not.toBe(session);
    expect(freshSession.getStatus().turnCount).toBe(0);
  });

  it("with no existing session: just replies (no crash)", async () => {
    const { feishu, dispatcher } = makeHarness();

    // Dispatch /new without creating a session first — should not crash
    await expect(
      dispatcher.dispatch({ name: "new" }, CTX),
    ).resolves.toBeUndefined();

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("新会话");
  });
});

// Helper: extract requestId from card sent via replyCard
function extractRequestIdFromCard(feishu: FeishuClient): string {
  const cardArg = (feishu.replyCard as ReturnType<typeof vi.fn>).mock.calls[0]![1];
  const json = JSON.stringify(cardArg);
  const match = /"request_id":"([^"]+)"/.exec(json);
  if (!match) throw new Error("No request_id found in card JSON: " + json);
  return match[1]!;
}

describe("CommandDispatcher — /cd", () => {
  it("sends confirmation card for valid path (/tmp)", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);

    expect(feishu.replyCard).toHaveBeenCalledOnce();
    const cardArg = (feishu.replyCard as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const json = JSON.stringify(cardArg);
    expect(json).toContain("/tmp");
    expect(json).toContain("确认");
  });

  it("rejects with error for nonexistent path", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "cd", path: "/this/path/does/not/exist/xyz123" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("路径不存在");
  });

  it("rejects when session is not idle", async () => {
    const { feishu, sessionManager, dispatcher } = makeBlockingHarness();

    const session = sessionManager.getOrCreate(CTX.chatId);
    const noopEmit = async () => {};
    session.submit(
      { kind: "run", text: "hello", senderOpenId: "ou_alice", parentMessageId: "om_p0" },
      noopEmit,
    );
    await flushMicrotasks();
    expect(session.getState()).toBe("generating");

    await dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("执行中");
  });
});

describe("CommandDispatcher — /cd confirm click (resolveCdConfirm)", () => {
  it("confirm (accept): deletes old session, sets cwd override, returns resolved card with path", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    const requestId = extractRequestIdFromCard(feishu);

    const result = await dispatcher.resolveCdConfirm({
      requestId,
      senderOpenId: "ou_alice",
      accepted: true,
    });

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      const json = JSON.stringify(result.card);
      expect(json).toContain("/tmp");
      // No buttons (no request_id in resolved card)
      expect(json).not.toContain("request_id");
    }

    // Session should be fresh (deleted and CWD overridden)
    const newSession = sessionManager.getOrCreate(CTX.chatId);
    expect(newSession.getStatus().cwd).toBe("/tmp");
  });

  it("cancel (reject): returns resolved card with cancelled text", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    const requestId = extractRequestIdFromCard(feishu);

    const result = await dispatcher.resolveCdConfirm({
      requestId,
      senderOpenId: "ou_alice",
      accepted: false,
    });

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      const json = JSON.stringify(result.card);
      expect(json).toContain("取消");
    }
  });

  it("non-owner click: returns { kind: 'forbidden', ownerOpenId: 'ou_alice' }", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);
    const requestId = extractRequestIdFromCard(feishu);

    const result = await dispatcher.resolveCdConfirm({
      requestId,
      senderOpenId: "ou_bob",
      accepted: true,
    });

    expect(result).toEqual({ kind: "forbidden", ownerOpenId: "ou_alice" });
  });

  it("unknown requestId: returns { kind: 'not_found' }", async () => {
    const { dispatcher } = makeHarness();

    const result = await dispatcher.resolveCdConfirm({
      requestId: "non-existent-uuid",
      senderOpenId: "ou_alice",
      accepted: true,
    });

    expect(result).toEqual({ kind: "not_found" });
  });

  it("timeout: after 60s FakeClock advance, patchCard called with timed-out card", async () => {
    const { feishu, dispatcher, clock } = makeHarness();

    await dispatcher.dispatch({ name: "cd", path: "/tmp" }, CTX);

    clock.advance(60_000);
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(feishu.patchCard).toHaveBeenCalledOnce();
    const patchedCard = (feishu.patchCard as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const json = JSON.stringify(patchedCard);
    expect(json).toContain("超时");
  });
});

// Config with projects pointing to /tmp (always exists)
const CONFIG_WITH_REAL_PROJECT: AppConfig = {
  ...BASE_CONFIG,
  projects: {
    "my-app": "/tmp",
  },
};

describe("CommandDispatcher — /project", () => {
  it("resolves alias to path and sends confirm card with path", async () => {
    const feishu = {
      replyText: vi.fn().mockResolvedValue({ messageId: "om_reply" }),
      replyCard: vi.fn().mockResolvedValue({ messageId: "om_card" }),
      patchCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeishuClient;
    const permissionBroker = new FakePermissionBroker();
    const questionBroker = new FakeQuestionBroker();
    const clock = new FakeClock(0);
    const sessionManager = new ClaudeSessionManager({
      config: CONFIG_WITH_REAL_PROJECT.claude,
      queryFn: NOOP_QUERY,
      clock,
      permissionBroker,
      questionBroker,
      logger: SILENT_LOGGER,
    });
    const dispatcher = new CommandDispatcher({
      sessionManager,
      feishu,
      config: CONFIG_WITH_REAL_PROJECT,
      permissionBroker,
      questionBroker,
      clock,
      logger: SILENT_LOGGER,
    });

    await dispatcher.dispatch({ name: "project", alias: "my-app" }, CTX);

    expect(feishu.replyCard).toHaveBeenCalledOnce();
    const cardArg = (feishu.replyCard as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const json = JSON.stringify(cardArg);
    expect(json).toContain("/tmp");
  });

  it("unknown alias replies with error listing available aliases", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "project", alias: "unknown-alias" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("未知项目别名");
    expect(text).toContain("my-app");
  });
});

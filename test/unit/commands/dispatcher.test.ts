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
  agent: {
    defaultProvider: "claude",
    defaultCwd: "/tmp/cfc-test",
    defaultPermissionMode: "default",
    permissionTimeoutMs: 300_000,
    permissionWarnBeforeMs: 60_000,
  },
  claude: {
    defaultCwd: "/tmp/cfc-test",
    defaultPermissionMode: "default",
    defaultModel: "claude-opus-4-6",
    cliPath: "claude",
    permissionTimeoutMs: 300_000,
    permissionWarnBeforeMs: 60_000,
  },
  codex: {
    defaultModel: "gpt-5.4",
    cliPath: "codex",
  },
  render: {
    inlineMaxBytes: 8192,
    hideThinking: false,
    showTurnStats: true,
  },
  persistence: {
    stateFile: "/tmp/state.json",
    logDir: "/tmp/logs",
    sessionTtlDays: 30,
  },
  logging: {
    level: "info",
  },
  projects: {
    "my-app": "/home/user/my-app",
  },
  mcp: [],
};

const CTX: CommandContext = {
  chatId: "oc_1",
  senderOpenId: "ou_alice",
  parentMessageId: "om_p1",
  locale: "zh",
};

function makeHarness(configOverrides?: Partial<AppConfig>) {
  const feishu = {
    replyText: vi.fn().mockResolvedValue({ messageId: "om_reply" }),
    replyCard: vi.fn().mockResolvedValue({ messageId: "om_card" }),
    patchCard: vi.fn().mockResolvedValue(undefined),
  } as unknown as FeishuClient;

  const permissionBroker = new FakePermissionBroker();
  const questionBroker = new FakeQuestionBroker();
  const clock = new FakeClock(0);
  const config: AppConfig = { ...BASE_CONFIG, ...configOverrides };

  const sessionManager = new ClaudeSessionManager({
    config: config.claude,
    queryFn: NOOP_QUERY,
    clock,
    permissionBroker,
    questionBroker,
    logger: SILENT_LOGGER,
  });

  const dispatcher = new CommandDispatcher({
    sessionManager,
    feishu,
    config,
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
      expect(text).toContain("/config set");
      expect(text).toContain("/project");
    });
  });

  describe("/status", () => {
    it("replies with idle state, provider, cwd, mode, and model", async () => {
      const { feishu, sessionManager, dispatcher } = makeHarness();

      // Create the session first
      sessionManager.getOrCreate("oc_1");

      await dispatcher.dispatch({ name: "status" }, CTX);

      expect(feishu.replyText).toHaveBeenCalledOnce();
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("idle");
      expect(text).toContain("claude");
      expect(text).toContain("/tmp/cfc-test"); // defaultCwd
      expect(text).toContain("default");       // defaultPermissionMode
      expect(text).toContain("claude-opus-4-6"); // defaultModel
    });

    it("uses the effective provider after /provider switch", async () => {
      const { feishu, sessionManager, dispatcher } = makeHarness();

      await dispatcher.dispatch({ name: "provider", provider: "codex" }, CTX);
      expect(sessionManager.getEffectiveProvider(CTX.chatId)).toBe("codex");

      (feishu.replyText as ReturnType<typeof vi.fn>).mockClear();
      await dispatcher.dispatch({ name: "status" }, CTX);

      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("codex");
      expect(text).toContain("gpt-5.4");
    });

    it("reports the codex provider and project cwd after switching provider and project", async () => {
      const { feishu, dispatcher } = makeHarness();

      await dispatcher.dispatch({ name: "provider", provider: "codex" }, CTX);
      await dispatcher.dispatch({ name: "project", alias: "my-app" }, CTX);

      (feishu.replyText as ReturnType<typeof vi.fn>).mockClear();
      await dispatcher.dispatch({ name: "status" }, CTX);

      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("codex");
      expect(text).toContain("gpt-5.4");
      expect(text).toContain("/home/user/my-app");
    });

    it("reports the restored provider from a stale codex session", async () => {
      const { feishu, sessionManager, dispatcher } = makeHarness();

      sessionManager.setStaleRecord("oc_restore_status", {
        provider: "codex",
        providerSessionId: "ses_restore_status",
        cwd: "/projects/codex-status",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        permissionMode: "default",
        model: "gpt-5.4",
      });

      await dispatcher.dispatch(
        { name: "resume", target: "oc_restore_status" },
        CTX,
      );

      (feishu.replyText as ReturnType<typeof vi.fn>).mockClear();
      await dispatcher.dispatch({ name: "status" }, CTX);

      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("codex");
      expect(text).toContain("gpt-5.4");
    });
  });

  describe("/cost", () => {
    it("replies with token totals", async () => {
      const { feishu, sessionManager, dispatcher } = makeHarness();
      sessionManager.getOrCreate("oc_1");
      await dispatcher.dispatch({ name: "cost" }, CTX);
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("Token");
      expect(text).toContain("0");
    });
  });

  describe("/context", () => {
    it("replies with context usage", async () => {
      const { feishu, dispatcher } = makeHarness();
      await dispatcher.dispatch({ name: "context" }, CTX);
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("上下文窗口");
      expect(text).toContain("200,000");
    });

  it("explains staged mitigation in /context output when usage is high", async () => {
    const { feishu, dispatcher, sessionManager } = makeHarness();
    const session = sessionManager.getOrCreate(CTX.chatId) as any;
    session.totalInputTokens = 165_000;

      await dispatcher.dispatch({ name: "context" }, CTX);

      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("预警");
      expect(text).toContain("兜底重置");
      expect(text).toContain("系统处理顺序：预警 -> 最后兜底重置");
      expect(text).not.toContain("压缩");
    });
  });

  describe("/config show", () => {
    it("shows appId, [agent], [claude], and [codex], but masks appSecret with ***", async () => {
      const { feishu, dispatcher } = makeHarness();

      await dispatcher.dispatch({ name: "config_show" }, CTX);

      expect(feishu.replyText).toHaveBeenCalledOnce();
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).toContain("cli_test");
      expect(text).toContain("[agent]");
      expect(text).toContain("[claude]");
      expect(text).toContain("[codex]");
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
      { kind: "run", text: "hello", senderOpenId: "ou_alice", parentMessageId: "om_p0", locale: "zh" },
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
      { kind: "run", text: "hello", senderOpenId: "ou_alice", parentMessageId: "om_p0", locale: "zh" },
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

  it("does not switch provider implicitly", async () => {
    const { sessionManager, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "provider", provider: "codex" }, CTX);
    await dispatcher.dispatch({ name: "model", model: "gpt-5.4-mini" }, CTX);

    expect(sessionManager.getEffectiveProvider(CTX.chatId)).toBe("codex");
  });
});

describe("CommandDispatcher — /provider", () => {
  it("sets provider override on idle session, resets the session, and replies", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    const before = sessionManager.getOrCreate(CTX.chatId);
    expect(sessionManager.getEffectiveProvider(CTX.chatId)).toBe("claude");

    await dispatcher.dispatch({ name: "provider", provider: "codex" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("codex");
    expect(sessionManager.getEffectiveProvider(CTX.chatId)).toBe("codex");

    const after = sessionManager.getOrCreate(CTX.chatId);
    expect(after).not.toBe(before);
    expect(after.getStatus().model).toBe("gpt-5.4");
  });

  it("rejects when session is not idle", async () => {
    const { feishu, sessionManager, dispatcher } = makeBlockingHarness();

    const session = sessionManager.getOrCreate(CTX.chatId);
    const noopEmit = async () => {};
    session.submit(
      { kind: "run", text: "hello", senderOpenId: "ou_alice", parentMessageId: "om_p0", locale: "zh" },
      noopEmit,
    );
    await flushMicrotasks();
    expect(session.getState()).toBe("generating");

    await dispatcher.dispatch({ name: "provider", provider: "codex" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("执行中");
    expect(sessionManager.getEffectiveProvider(CTX.chatId)).toBe("claude");
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

describe("CommandDispatcher — /compact", () => {
  it("resets an idle session and replies", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();
    const before = sessionManager.getOrCreate(CTX.chatId);
    await dispatcher.dispatch({ name: "compact" }, CTX);
    expect(feishu.replyText).toHaveBeenCalledOnce();
    const after = sessionManager.getOrCreate(CTX.chatId);
    expect(after).not.toBe(before);
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("会话已重置");
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
      { kind: "run", text: "hello", senderOpenId: "ou_alice", parentMessageId: "om_p0", locale: "zh" },
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
  it("resolves alias to path, switches project session, and replies with confirmation", async () => {
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

    // /project now switches instantly — no confirm card, just a text reply.
    expect(feishu.replyCard).not.toHaveBeenCalled();
    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("my-app");
    expect(text).toContain("/tmp");
    // Active project should be updated in session manager.
    expect(sessionManager.getActiveProject(CTX.chatId)).toBe("my-app");
  });

  it("keeps codex selected and uses the project cwd when switching projects after /provider codex", async () => {
    const { sessionManager, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "provider", provider: "codex" }, CTX);
    await dispatcher.dispatch({ name: "project", alias: "my-app" }, CTX);

    const session = sessionManager.getOrCreate(CTX.chatId);
    expect(sessionManager.getEffectiveProvider(CTX.chatId)).toBe("codex");
    expect(session.getStatus().provider).toBe("codex");
    expect(session.getStatus().cwd).toBe("/home/user/my-app");
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

describe("CommandDispatcher — /sessions", () => {
  it("replies '暂无会话记录' when no sessions exist", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "sessions" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("暂无会话记录");
  });

  it("replies with a card when sessions exist", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    // Create an active session
    sessionManager.getOrCreate("oc_session1");

    await dispatcher.dispatch({ name: "sessions" }, CTX);

    expect(feishu.replyCard).toHaveBeenCalledOnce();
    const card = (feishu.replyCard as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(card).toHaveProperty("schema", "2.0");
    expect(card).toHaveProperty("header");
    // Body should contain session info as markdown elements
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain("活跃");
  });
});

describe("CommandDispatcher — /projects", () => {
  it("replies '暂无已配置项目' when projects config is empty", async () => {
    const { feishu, dispatcher } = makeHarness({ projects: {} });

    await dispatcher.dispatch({ name: "projects" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("暂无已配置项目");
  });

  it("replies with a card listing configured projects", async () => {
    // BASE_CONFIG has projects: { "my-app": "/home/user/my-app" }
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "projects" }, CTX);

    expect(feishu.replyCard).toHaveBeenCalledOnce();
    const card = (feishu.replyCard as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(card).toHaveProperty("schema", "2.0");
    expect(card.header?.title.content).toContain("项目");
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain("my-app");
    expect(bodyJson).toContain("/home/user/my-app");
  });

  it("marks the active project with 📌 当前", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();
    sessionManager.switchProject(CTX.chatId, "my-app", "/home/user/my-app");

    await dispatcher.dispatch({ name: "projects" }, CTX);

    expect(feishu.replyCard).toHaveBeenCalledOnce();
    const card = (feishu.replyCard as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(JSON.stringify(card.body)).toContain("📌");
  });

  it("shows 🟢 活跃会话 when the project has an active session", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();
    // Create an active session for my-app in this chat
    sessionManager.switchProject(CTX.chatId, "my-app", "/home/user/my-app");
    sessionManager.getOrCreate(CTX.chatId);

    await dispatcher.dispatch({ name: "projects" }, CTX);

    const card = (feishu.replyCard as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(JSON.stringify(card.body)).toContain("🟢");
  });
});

describe("CommandDispatcher — /resume", () => {
  it("replies '未找到会话' for unknown target", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch({ name: "resume", target: "nonexistent" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("未找到会话");
  });

  it("replies '已经在该会话中' when target resolves to own chatId", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    // Create a session for the current chatId so findSession can find it
    sessionManager.getOrCreate(CTX.chatId);

    await dispatcher.dispatch({ name: "resume", target: CTX.chatId }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("已经在该会话中");
  });

  it("replies '正在执行中' when session is not idle", async () => {
    const { feishu, sessionManager, dispatcher } = makeBlockingHarness();

    // Put the current session in generating state
    const session = sessionManager.getOrCreate(CTX.chatId);
    const noopEmit = async () => {};
    session.submit(
      { kind: "run", text: "hello", senderOpenId: "ou_alice", parentMessageId: "om_p0", locale: "zh" },
      noopEmit,
    );
    await flushMicrotasks();
    expect(session.getState()).toBe("generating");

    // Create a target session to resume
    sessionManager.getOrCreate("oc_target");

    await dispatcher.dispatch({ name: "resume", target: "oc_target" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("执行中");
  });

  it("successfully resumes another session and replies '已恢复会话'", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    // Create a target session at a different chatId
    sessionManager.getOrCreate("oc_target");

    await dispatcher.dispatch({ name: "resume", target: "oc_target" }, CTX);

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("已恢复会话");
  });

  it("preserves provider across resume flows", async () => {
    const { feishu, sessionManager, dispatcher } = makeHarness();

    sessionManager.setStaleRecord("oc_resume_codex", {
      provider: "codex",
      providerSessionId: "ses_resume_codex",
      cwd: "/projects/codex-resume",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      permissionMode: "default",
      model: "gpt-5.4",
    });

    await dispatcher.dispatch({ name: "resume", target: "oc_resume_codex" }, CTX);

    expect(sessionManager.getEffectiveProvider(CTX.chatId)).toBe("codex");
    expect(sessionManager.getOrCreate(CTX.chatId).getStatus().provider).toBe("codex");

    (feishu.replyText as ReturnType<typeof vi.fn>).mockClear();
    await dispatcher.dispatch({ name: "status" }, CTX);
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("codex");
  });
});

describe("CommandDispatcher — /config set", () => {
  it("sets a boolean config key and replies with confirmation", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "render.hide_thinking", value: "true", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("render.hide_thinking");
    expect(text).toContain("true");
    expect(text).toContain("已更新");
  });

  it("sets a numeric config key (render.inline_max_bytes)", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "render.inline_max_bytes", value: "4096", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("4096");
    expect(text).toContain("已更新");
  });

  it("sets an enum config key (logging.level)", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "logging.level", value: "debug", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("debug");
    expect(text).toContain("已更新");
  });

  it("sets a string config key (claude.default_model)", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "claude.default_model", value: "claude-sonnet-4-6", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("claude-sonnet-4-6");
  });

  it("converts permission_timeout_seconds to ms", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "claude.permission_timeout_seconds", value: "120", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("120");
    expect(text).toContain("已更新");
  });

  it("rejects unknown key with error listing valid keys", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "feishu.app_id", value: "new_id", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("不支持");
    expect(text).toContain("render.hide_thinking"); // lists valid keys
  });

  it("rejects removed auto compact config key", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      {
        name: "config_set",
        key: "claude.auto_compact_threshold",
        value: "0.8",
        persist: false,
      },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("不支持");
  });

  it("rejects invalid boolean value", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "render.hide_thinking", value: "maybe", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("无效");
  });

  it("rejects invalid enum value for logging.level", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "logging.level", value: "verbose", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("无效");
  });

  it("rejects non-positive number for render.inline_max_bytes", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "render.inline_max_bytes", value: "0", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("无效");
  });

  it("rejects non-integer for render.inline_max_bytes", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "render.inline_max_bytes", value: "abc", persist: false },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(text).toContain("无效");
  });

  it("with persist=true includes note about persist in reply", async () => {
    const { feishu, dispatcher } = makeHarness();

    await dispatcher.dispatch(
      { name: "config_set", key: "render.hide_thinking", value: "true", persist: true },
      CTX,
    );

    expect(feishu.replyText).toHaveBeenCalledOnce();
    const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    // In test harness, configPath is undefined so it shows skip message
    expect(text).toContain("已更新");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandDispatcher } from "../../../src/commands/dispatcher.js";
import type { CommandContext } from "../../../src/commands/dispatcher.js";
import { ClaudeSessionManager } from "../../../src/claude/session-manager.js";
import { FakePermissionBroker } from "../claude/fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "../claude/fakes/fake-question-broker.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import type { QueryFn, SDKMessageLike } from "../../../src/claude/session.js";
import type { AppConfig } from "../../../src/types.js";
import type { FeishuClient } from "../../../src/feishu/client.js";

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

  return { feishu, sessionManager, dispatcher };
}

describe("CommandDispatcher — simple commands", () => {
  describe("/help", () => {
    it("replies with text containing all command names", async () => {
      const { feishu, dispatcher } = makeHarness();

      await dispatcher.dispatch({ name: "help" }, CTX);

      expect(feishu.replyText).toHaveBeenCalledOnce();
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0][1];
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
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0][1];
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
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0][1];
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
      const text: string = (feishu.replyText as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(text).toContain("/help");
    });
  });
});

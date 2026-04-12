import { describe, it, expect } from "vitest";
import { ClaudeSessionManager } from "../../../src/claude/session-manager.js";
import type { QueryFn, SDKMessageLike } from "../../../src/claude/session.js";
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "./fakes/fake-question-broker.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";

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

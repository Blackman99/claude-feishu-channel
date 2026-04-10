import { describe, it, expect } from "vitest";
import { ClaudeSessionManager } from "../../../src/claude/session-manager.js";
import type { QueryFn, SDKMessageLike } from "../../../src/claude/session.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
};

const NOOP_QUERY: QueryFn = () => ({
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessageLike, void> {
    yield { type: "result", subtype: "success", result: "" };
  },
});

describe("ClaudeSessionManager", () => {
  it("returns the same ClaudeSession instance for the same chat_id", () => {
    const mgr = new ClaudeSessionManager({
      config: BASE_CLAUDE_CONFIG,
      queryFn: NOOP_QUERY,
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
      logger: SILENT_LOGGER,
    });
    const a = mgr.getOrCreate("oc_1");
    const b = mgr.getOrCreate("oc_2");
    expect(a).not.toBe(b);
  });
});

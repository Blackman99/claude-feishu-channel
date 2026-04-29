import { describe, it, expect } from "vitest";
import {
  formatResultTip,
  formatErrorText,
  formatQueuedTip,
  formatStopAck,
  formatInterruptDropAck,
  formatContextWarning,
  formatContextReset,
} from "../../../src/feishu/messages.js";
import type { IncomingMessage } from "../../../src/types.js";

describe("formatResultTip", () => {
  it("formats duration + token usage", () => {
    expect(formatResultTip({
      durationMs: 5234,
      inputTokens: 1200,
      outputTokens: 3400,
    })).toBe("✅ 本轮耗时 5.2s · 输入 1.2k / 输出 3.4k tokens");
  });

  it("formats sub-second duration", () => {
    expect(formatResultTip({
      durationMs: 450,
      inputTokens: 100,
      outputTokens: 50,
    })).toBe("✅ 本轮耗时 0.5s · 输入 100 / 输出 50 tokens");
  });

  it("formats long duration (> 60s) as seconds", () => {
    expect(formatResultTip({
      durationMs: 125_000,
      inputTokens: 5000,
      outputTokens: 2000,
    })).toBe("✅ 本轮耗时 125.0s · 输入 5.0k / 输出 2.0k tokens");
  });

  it("does not use k suffix below 1000", () => {
    expect(formatResultTip({
      durationMs: 1000,
      inputTokens: 999,
      outputTokens: 1,
    })).toBe("✅ 本轮耗时 1.0s · 输入 999 / 输出 1 tokens");
  });
});

describe("formatErrorText", () => {
  it("prepends the ❌ marker", () => {
    expect(formatErrorText("boom")).toBe("❌ 错误: boom");
  });

  it("handles multiline errors", () => {
    expect(formatErrorText("line one\nline two"))
      .toBe("❌ 错误: line one\nline two");
  });
});

describe("formatQueuedTip", () => {
  it("renders the queue position with a hint that the user can /stop", () => {
    expect(formatQueuedTip(1)).toBe(
      "📥 已加入队列 #1（当前有一个轮次在运行，发 `/stop` 可取消）",
    );
  });

  it("renders higher positions without shifting", () => {
    expect(formatQueuedTip(5)).toBe(
      "📥 已加入队列 #5（当前有一个轮次在运行，发 `/stop` 可取消）",
    );
  });

  it("throws on position < 1 — queue positions are 1-indexed", () => {
    expect(() => formatQueuedTip(0)).toThrow(/position/);
    expect(() => formatQueuedTip(-1)).toThrow(/position/);
  });
});

describe("formatStopAck", () => {
  it("renders a neutral stop acknowledgement", () => {
    expect(formatStopAck()).toBe("🛑 已停止");
  });
});

describe("formatInterruptDropAck", () => {
  it("renders a neutral 'your message was dropped' ack", () => {
    expect(formatInterruptDropAck()).toBe(
      "⚠️ 你之前的消息在被当前 agent 处理前已被后续指令打断丢弃",
    );
  });
});

describe("context mitigation notices", () => {
  it("renders a visible warning notice", () => {
    expect(formatContextWarning()).toContain("上下文");
    expect(formatContextWarning()).toContain("50MB");
  });

  it("renders a visible reset notice", () => {
    expect(formatContextReset()).toContain("会话已重置");
    expect(formatContextReset()).toContain("新的会话上下文");
  });
});

describe("IncomingMessage image support", () => {
  it("supports imageDataUris on image-bearing messages", () => {
    const msg: IncomingMessage = {
      messageId: "om_x",
      chatId: "oc_x",
      senderOpenId: "ou_x",
      text: "",
      imageDataUris: ["data:image/png;base64,iVBOR..."],
      receivedAt: Date.now(),
    };
    expect(msg.imageDataUris?.[0]).toMatch(/^data:image\//);
  });
});

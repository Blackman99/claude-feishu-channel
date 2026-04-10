import { describe, it, expect } from "vitest";
import {
  formatThinkingText,
  formatResultTip,
  formatErrorText,
} from "../../../src/feishu/messages.js";

describe("formatThinkingText", () => {
  it("prepends the 💭 header", () => {
    expect(formatThinkingText("I should check the docs first"))
      .toBe("💭 思考过程\n\nI should check the docs first");
  });

  it("handles empty input", () => {
    expect(formatThinkingText("")).toBe("💭 思考过程\n\n");
  });
});

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

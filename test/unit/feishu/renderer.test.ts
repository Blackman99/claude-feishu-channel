import { describe, it, expect } from "vitest";
import { extractAssistantText } from "../../../src/feishu/renderer.js";

describe("extractAssistantText", () => {
  it("returns the text of a single text block", () => {
    expect(
      extractAssistantText([{ type: "text", text: "hello" }]),
    ).toBe("hello");
  });

  it("joins multiple text blocks with \\n", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ]),
    ).toBe("line 1\nline 2");
  });

  it("ignores tool_use blocks", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "before" },
        { type: "tool_use" },
        { type: "text", text: "after" },
      ]),
    ).toBe("before\nafter");
  });

  it("ignores thinking blocks (hidden in Phase 2)", () => {
    expect(
      extractAssistantText([
        { type: "thinking", text: "secret reasoning" },
        { type: "text", text: "public answer" },
      ]),
    ).toBe("public answer");
  });

  it("returns null when there is no text content", () => {
    expect(extractAssistantText([{ type: "tool_use" }])).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractAssistantText([])).toBeNull();
  });

  it("skips text blocks with empty string", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "" },
        { type: "text", text: "real" },
      ]),
    ).toBe("real");
  });
});

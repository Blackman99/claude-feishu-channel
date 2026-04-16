import { describe, it, expect } from "vitest";
import { extractToolResultText } from "../../../src/feishu/tool-result.js";

describe("extractToolResultText", () => {
  it("returns a string content as-is", () => {
    expect(extractToolResultText("hello output")).toBe("hello output");
  });

  it("returns empty string for undefined content", () => {
    expect(extractToolResultText(undefined)).toBe("");
  });

  it("joins text blocks from an array with newlines", () => {
    expect(extractToolResultText([
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ])).toBe("line one\nline two");
  });

  it("replaces image blocks with a placeholder", () => {
    expect(extractToolResultText([
      { type: "text", text: "here:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
    ])).toBe("here:\n[image]");
  });

  it("replaces unknown block types with a placeholder", () => {
    expect(extractToolResultText([
      { type: "text", text: "ok" },
      { type: "widget_frobnicator" },
    ])).toBe("ok\n[widget_frobnicator]");
  });

  it("returns empty string for empty array", () => {
    expect(extractToolResultText([])).toBe("");
  });

  it("skips text blocks with no text field", () => {
    expect(extractToolResultText([
      { type: "text", text: "keep" },
      { type: "text" },
      { type: "text", text: "also keep" },
    ])).toBe("keep\nalso keep");
  });
});

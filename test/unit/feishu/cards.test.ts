import { describe, it, expect } from "vitest";
import {
  buildToolUseCard,
  buildToolResultCard,
} from "../../../src/feishu/cards.js";

function firstMarkdownContent(card: {
  body?: { elements: readonly { tag: string }[] };
}): string {
  const elements = card.body?.elements ?? [];
  const first = elements[0] as { tag: string; content?: string } | undefined;
  if (!first || first.tag !== "markdown" || typeof first.content !== "string") {
    throw new Error("expected first body element to be a markdown element");
  }
  return first.content;
}

describe("buildToolUseCard", () => {
  it("renders a blue-header Card v2 with tool name and param summary", () => {
    const card = buildToolUseCard(
      { id: "tu_1", name: "Bash", input: { command: "npm test" } },
      { inlineMaxBytes: 2048 },
    );
    expect(card.schema).toBe("2.0");
    expect(card.header?.title.content).toBe("🔧 Bash");
    expect(card.header?.template).toBe("blue");
    expect(firstMarkdownContent(card)).toContain("$ npm test");
  });

  it("uses the per-tool formatter (Read → path:start-end)", () => {
    const card = buildToolUseCard(
      { id: "tu_2", name: "Read", input: { file_path: "src/a.ts", offset: 1, limit: 10 } },
      { inlineMaxBytes: 2048 },
    );
    expect(firstMarkdownContent(card)).toContain("src/a.ts:1-10");
  });

  it("truncates inline body at inlineMaxBytes", () => {
    const hugeInput = { data: "x".repeat(10000) };
    const card = buildToolUseCard(
      { id: "tu_3", name: "WeirdTool", input: hugeInput },
      { inlineMaxBytes: 100 },
    );
    // Body should be at most ~100 bytes plus the "(N more bytes omitted)" footer.
    expect(firstMarkdownContent(card)).toContain("more bytes omitted");
  });
});

describe("buildToolResultCard", () => {
  it("renders a green-header Card v2 on success", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "42 files changed",
      inlineMaxBytes: 2048,
    });
    expect(card.schema).toBe("2.0");
    expect(card.header?.title.content).toBe("✅ Result");
    expect(card.header?.template).toBe("green");
    expect(firstMarkdownContent(card)).toContain("42 files changed");
  });

  it("renders a red-header Card v2 on error", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: true,
      text: "Permission denied",
      inlineMaxBytes: 2048,
    });
    expect(card.header?.title.content).toBe("❌ Error");
    expect(card.header?.template).toBe("red");
    expect(firstMarkdownContent(card)).toContain("Permission denied");
  });

  it("truncates long output", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "x".repeat(10000),
      inlineMaxBytes: 100,
    });
    expect(firstMarkdownContent(card)).toContain("more bytes omitted");
  });

  it("shows an empty placeholder when result text is blank", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "",
      inlineMaxBytes: 2048,
    });
    expect(firstMarkdownContent(card)).toBe("_(no output)_");
  });
});

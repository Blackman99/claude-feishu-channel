import { describe, it, expect } from "vitest";
import {
  buildToolUseCard,
  buildToolResultCard,
} from "../../../src/feishu/cards.js";

describe("buildToolUseCard", () => {
  it("renders a blue-header card with tool name and param summary", () => {
    const card = buildToolUseCard(
      { id: "tu_1", name: "Bash", input: { command: "npm test" } },
      { inlineMaxBytes: 2048 },
    );
    expect(card.version).toBe("1.0");
    expect(card.header?.title.content).toBe("🔧 Bash");
    expect(card.header?.template).toBe("blue");
    // Body should mention the command summary.
    const bodyText = card.elements
      .filter((e): e is { tag: "markdown"; content: string } => e.tag === "markdown")
      .map((e) => e.content)
      .join("\n");
    expect(bodyText).toContain("$ npm test");
  });

  it("uses the per-tool formatter (Read → path:start-end)", () => {
    const card = buildToolUseCard(
      { id: "tu_2", name: "Read", input: { file_path: "src/a.ts", offset: 1, limit: 10 } },
      { inlineMaxBytes: 2048 },
    );
    const body = (card.elements[0] as { content: string }).content;
    expect(body).toContain("src/a.ts:1-10");
  });

  it("truncates inline body at inlineMaxBytes", () => {
    const hugeInput = { data: "x".repeat(10000) };
    const card = buildToolUseCard(
      { id: "tu_3", name: "WeirdTool", input: hugeInput },
      { inlineMaxBytes: 100 },
    );
    const body = (card.elements[0] as { content: string }).content;
    // Body should be at most ~100 bytes plus the "(N more bytes omitted)" footer.
    expect(body).toContain("more bytes omitted");
  });
});

describe("buildToolResultCard", () => {
  it("renders a green-header card on success", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "42 files changed",
      inlineMaxBytes: 2048,
    });
    expect(card.header?.title.content).toBe("✅ Result");
    expect(card.header?.template).toBe("green");
    expect((card.elements[0] as { content: string }).content).toContain("42 files changed");
  });

  it("renders a red-header card on error", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: true,
      text: "Permission denied",
      inlineMaxBytes: 2048,
    });
    expect(card.header?.title.content).toBe("❌ Error");
    expect(card.header?.template).toBe("red");
    expect((card.elements[0] as { content: string }).content).toContain("Permission denied");
  });

  it("truncates long output", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "x".repeat(10000),
      inlineMaxBytes: 100,
    });
    const body = (card.elements[0] as { content: string }).content;
    expect(body).toContain("more bytes omitted");
  });

  it("shows an empty placeholder when result text is blank", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "",
      inlineMaxBytes: 2048,
    });
    const body = (card.elements[0] as { content: string }).content;
    expect(body).toBe("_(no output)_");
  });
});

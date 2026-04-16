import { describe, it, expect } from "vitest";
import { formatToolParams } from "../../../src/feishu/tool-formatters.js";

describe("formatToolParams", () => {
  describe("Read", () => {
    it("formats path + line range", () => {
      expect(formatToolParams("Read", { file_path: "src/app.ts", offset: 42, limit: 39 }))
        .toBe("src/app.ts:42-80");
    });

    it("formats path without line range", () => {
      expect(formatToolParams("Read", { file_path: "src/app.ts" }))
        .toBe("src/app.ts");
    });

    it("formats path with offset only", () => {
      expect(formatToolParams("Read", { file_path: "src/app.ts", offset: 10 }))
        .toBe("src/app.ts:10-");
    });
  });

  describe("Edit", () => {
    it("formats just file_path (diff stats not available at call site)", () => {
      expect(formatToolParams("Edit", {
        file_path: "src/app.ts",
        old_string: "foo",
        new_string: "bar",
      })).toBe("src/app.ts");
    });
  });

  describe("Write", () => {
    it("formats path + content byte length", () => {
      expect(formatToolParams("Write", {
        file_path: "out.txt",
        content: "hello world",
      })).toBe("out.txt (11 bytes)");
    });
  });

  describe("Bash", () => {
    it("formats command with $ prefix", () => {
      expect(formatToolParams("Bash", { command: "npm test" }))
        .toBe("$ npm test");
    });

    it("truncates commands over 80 chars", () => {
      const cmd = "echo " + "x".repeat(100);
      const out = formatToolParams("Bash", { command: cmd });
      expect(out.startsWith("$ ")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(80 + 2 /* "$ " */ + 1 /* ellipsis */);
      expect(out.endsWith("…")).toBe(true);
    });
  });

  describe("Grep", () => {
    it("formats pattern + glob", () => {
      expect(formatToolParams("Grep", {
        pattern: "TODO",
        glob: "*.ts",
      })).toBe('"TODO" in *.ts');
    });

    it("formats pattern alone when no glob", () => {
      expect(formatToolParams("Grep", { pattern: "TODO" }))
        .toBe('"TODO"');
    });
  });

  describe("default fallback", () => {
    it("returns single-line JSON for unknown tools", () => {
      expect(formatToolParams("WeirdTool", { a: 1, b: "x" }))
        .toBe('{"a":1,"b":"x"}');
    });

    it("truncates very long JSON", () => {
      const big = { data: "x".repeat(500) };
      const out = formatToolParams("WeirdTool", big);
      expect(out.length).toBeLessThanOrEqual(200);
    });

    it("handles malformed input (non-object) gracefully", () => {
      expect(formatToolParams("WeirdTool", null)).toBe("null");
      expect(formatToolParams("WeirdTool", 42)).toBe("42");
      expect(formatToolParams("WeirdTool", "string input")).toBe('"string input"');
    });
  });
});

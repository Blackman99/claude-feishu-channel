import { describe, it, expect } from "vitest";
import {
  sanitizeForFeishuMarkdown,
  truncateForInline,
} from "../../../src/feishu/truncate.js";

describe("truncateForInline", () => {
  it("returns the input unchanged when within byte budget", () => {
    expect(truncateForInline("hello", 100)).toBe("hello");
  });

  it("returns the input unchanged at exactly the byte budget", () => {
    expect(truncateForInline("hello", 5)).toBe("hello");
  });

  it("truncates and appends an omitted-bytes suffix when over budget", () => {
    const input = "a".repeat(100);
    const out = truncateForInline(input, 20);
    // Byte length of preview part should be <= 20. Suffix is appended.
    expect(out).toMatch(/^a{20}\n… \(80 more bytes omitted\)$/);
  });

  it("counts UTF-8 bytes, not code units (CJK = 3 bytes each)", () => {
    // "你好" is 6 bytes, "世界" is 6 bytes — 12 bytes total.
    const input = "你好世界"; // 12 bytes
    // With budget 6 we should keep "你好" (6 bytes) and mark 6 omitted.
    expect(truncateForInline(input, 6)).toBe("你好\n… (6 more bytes omitted)");
  });

  it("never splits a multi-byte character in the middle", () => {
    // Budget of 4 bytes cannot fit a second "你" (would need 6). So only
    // "你" (3 bytes) is kept.
    const input = "你好"; // 6 bytes
    expect(truncateForInline(input, 4)).toBe("你\n… (3 more bytes omitted)");
  });

  it("handles emoji (4-byte UTF-8)", () => {
    const input = "🎉🎉🎉"; // 12 bytes
    // Budget 5 → only one 🎉 (4 bytes) fits.
    expect(truncateForInline(input, 5)).toBe("🎉\n… (8 more bytes omitted)");
  });

  it("returns empty string unchanged", () => {
    expect(truncateForInline("", 100)).toBe("");
  });

  it("throws on non-positive budget", () => {
    expect(() => truncateForInline("abc", 0)).toThrow();
    expect(() => truncateForInline("abc", -1)).toThrow();
  });
});

describe("sanitizeForFeishuMarkdown", () => {
  it("demotes a markdown image reference to a plain link", () => {
    // Feishu rejects `![alt](https://...)` with code=230099 "invalid
    // image keys" because its parser only accepts internal img_key
    // values. Stripping the leading `!` keeps the URL visible as a
    // clickable link while the parser stops trying to resolve it.
    expect(
      sanitizeForFeishuMarkdown(
        "![Node](https://img.shields.io/badge/Node-16-green)",
      ),
    ).toBe("[Node](https://img.shields.io/badge/Node-16-green)");
  });

  it("handles multiple images on separate lines", () => {
    const input =
      "![a](https://x.test/a.png)\n\nsome text\n\n![b](https://x.test/b.png)";
    const out = sanitizeForFeishuMarkdown(input);
    expect(out).toBe(
      "[a](https://x.test/a.png)\n\nsome text\n\n[b](https://x.test/b.png)",
    );
  });

  it("handles multiple images on the same line", () => {
    expect(
      sanitizeForFeishuMarkdown(
        "badges: ![one](https://x.test/1) ![two](https://x.test/2)",
      ),
    ).toBe("badges: [one](https://x.test/1) [two](https://x.test/2)");
  });

  it("leaves plain links untouched", () => {
    const input = "see [the docs](https://example.com) for details";
    expect(sanitizeForFeishuMarkdown(input)).toBe(input);
  });

  it("leaves standalone exclamation marks untouched", () => {
    expect(sanitizeForFeishuMarkdown("hello world!")).toBe("hello world!");
    expect(sanitizeForFeishuMarkdown("wow! really")).toBe("wow! really");
  });

  it("does not strip an escaped bang", () => {
    // `\![x](y)` means the user escaped the image syntax on purpose;
    // leave the `!` and the escape alone.
    const input = "\\![x](https://example.com)";
    expect(sanitizeForFeishuMarkdown(input)).toBe(input);
  });

  it("returns the empty string unchanged", () => {
    expect(sanitizeForFeishuMarkdown("")).toBe("");
  });

  it("leaves text without any image refs unchanged", () => {
    const input = "## Heading\n\nplain prose with no images at all.";
    expect(sanitizeForFeishuMarkdown(input)).toBe(input);
  });
});

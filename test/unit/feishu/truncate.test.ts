import { describe, it, expect } from "vitest";
import { truncateForInline } from "../../../src/feishu/truncate.js";

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

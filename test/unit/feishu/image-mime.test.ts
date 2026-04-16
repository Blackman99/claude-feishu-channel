import { describe, it, expect } from "vitest";
import { detectImageMime } from "../../../src/feishu/image-mime.js";

describe("detectImageMime", () => {
  it("detects PNG from magic bytes 89 50 4E 47", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectImageMime(buf)).toBe("image/png");
  });

  it("detects JPEG from magic bytes FF D8 FF", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMime(buf)).toBe("image/jpeg");
  });

  it("detects GIF from magic bytes 47 49 46", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageMime(buf)).toBe("image/gif");
  });

  it("detects WebP from RIFF … WEBP", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectImageMime(buf)).toBe("image/webp");
  });

  it("falls back to image/jpeg for unknown bytes", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(detectImageMime(buf)).toBe("image/jpeg");
  });

  it("falls back to image/jpeg when buffer is shorter than signature length", () => {
    expect(detectImageMime(Buffer.from([]))).toBe("image/jpeg");
    expect(detectImageMime(Buffer.from([0x89, 0x50]))).toBe("image/jpeg");
  });

  it("rejects RIFF without WEBP marker", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, // "WAVE"
    ]);
    expect(detectImageMime(buf)).toBe("image/jpeg");
  });
});

export type SupportedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/**
 * Identify an image MIME type from the first ~12 bytes of the buffer.
 * Covers the four formats the Claude API accepts. Falls back to
 * image/jpeg when the signature is unrecognized.
 */
export function detectImageMime(buf: Buffer): SupportedImageMime {
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 &&
      buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 3 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return "image/gif";
  }
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return "image/webp";
  }
  return "image/jpeg";
}

/**
 * Truncate a string so its UTF-8 byte length does not exceed `maxBytes`.
 * When truncation happens, append "\n… (N more bytes omitted)" where N
 * is the byte count of the omitted suffix. The truncation boundary
 * never falls in the middle of a multi-byte character.
 *
 * Used to clip tool input / tool output for inline display inside
 * Feishu cards, which have a total content byte limit.
 */
export function truncateForInline(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    throw new Error(`truncateForInline: maxBytes must be positive (got ${maxBytes})`);
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;

  // Walk code points and accumulate bytes until we'd exceed the budget.
  let byteCount = 0;
  let kept = "";
  for (const ch of text) {
    const chBytes = encoder.encode(ch).length;
    if (byteCount + chBytes > maxBytes) break;
    byteCount += chBytes;
    kept += ch;
  }
  const omittedBytes = bytes.length - byteCount;
  return `${kept}\n… (${omittedBytes} more bytes omitted)`;
}

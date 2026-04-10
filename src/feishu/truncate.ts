/**
 * Neutralize markdown image references so Feishu's card validator
 * doesn't reject the whole card.
 *
 * Feishu's markdown parser treats `![alt](url)` as a reference to an
 * uploaded-image `img_key` (their internal format, e.g. `img_v2_xxx`).
 * When the URL is an ordinary HTTP link (shields.io badges, GitHub
 * avatars, etc.) the server responds with
 *   code=230099 "card contains invalid image keys"
 * and the entire card — including anything else we were trying to
 * show the user — fails to render. Tool output from Claude routinely
 * contains exactly that syntax (READMEs full of badges, for example),
 * so we can't rely on the source being image-free.
 *
 * The simplest durable fix is to demote image refs to plain links by
 * stripping the leading `!`. The URL still displays as a clickable
 * link, no content is lost, and the parser is happy.
 */
export function sanitizeForFeishuMarkdown(text: string): string {
  // Match only the `!` directly before `[alt](url)` markdown image
  // syntax. Keep the `[alt](url)` intact so it renders as a normal
  // link. A negative lookbehind for `\` avoids touching already-
  // escaped sequences. `[^\]]*` for alt text and `[^)\s]+` for the
  // URL stay on a single line — multiline images are exotic enough
  // to not be worth the regex complexity.
  return text.replace(/(?<!\\)!(\[[^\]]*\]\([^)\s]+\))/g, "$1");
}

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

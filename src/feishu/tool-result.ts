/**
 * Shallow structural type of a tool_result content block. The real
 * SDK type is a broader union from @anthropic-ai/sdk; we only narrow
 * on fields we render.
 */
export interface ToolResultBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Flatten a `tool_result` block's `content` into a single display string.
 * The SDK allows content to be either a raw string OR an array of
 * content blocks (text, image, etc.). Non-text blocks are replaced with
 * a `[blockType]` placeholder so the card always has *something* to show.
 * Text blocks with no `text` field are dropped entirely.
 */
export function extractToolResultText(
  content: string | readonly ToolResultBlock[] | undefined,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (typeof block.text === "string") {
        parts.push(block.text);
      }
      // type=text but no text field → drop entirely
    } else {
      parts.push(`[${block.type}]`);
    }
  }
  return parts.join("\n");
}

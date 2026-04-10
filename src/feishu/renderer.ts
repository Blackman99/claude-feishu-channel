/**
 * Shallow structural type of an assistant content block. The real SDK
 * type comes from @anthropic-ai/sdk's BetaMessage.content. We only care
 * about the `text` branch in Phase 2, so this stays minimal.
 */
export interface AssistantContentBlock {
  type: string;
  text?: string;
}

/**
 * Extract user-visible text from an assistant message's content blocks.
 * Multiple text blocks are joined with newlines. Non-text blocks
 * (tool_use, thinking, image, ...) are ignored. Returns `null` if the
 * message carries no renderable text (e.g. a pure tool_use turn).
 */
export function extractAssistantText(
  content: readonly AssistantContentBlock[],
): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

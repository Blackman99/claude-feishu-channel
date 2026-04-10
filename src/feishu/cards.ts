import type { FeishuCardV2 } from "./card-types.js";
import { formatToolParams } from "./tool-formatters.js";
import { truncateForInline } from "./truncate.js";

export interface ToolUseBlockInput {
  id: string;
  name: string;
  input: unknown;
}

export interface CardRenderConfig {
  inlineMaxBytes: number;
}

/**
 * Build a Feishu Card v2 JSON representing a Claude tool_use block.
 * Header: 🔧 <ToolName> with blue template. Body: per-tool param summary,
 * truncated to `inlineMaxBytes`.
 */
export function buildToolUseCard(
  block: ToolUseBlockInput,
  config: CardRenderConfig,
): FeishuCardV2 {
  const summary = formatToolParams(block.name, block.input);
  const body = truncateForInline(summary, config.inlineMaxBytes);
  return {
    version: "1.0",
    header: {
      title: { content: `🔧 ${block.name}`, tag: "plain_text" },
      template: "blue",
    },
    elements: [{ tag: "markdown", content: body }],
  };
}

export interface ToolResultCardParams {
  toolUseId: string;
  isError: boolean;
  text: string;
  inlineMaxBytes: number;
}

/**
 * Build a Feishu Card v2 JSON representing a tool_result. Green header
 * on success, red on error. Body is the extracted result text,
 * truncated to `inlineMaxBytes`.
 */
export function buildToolResultCard(params: ToolResultCardParams): FeishuCardV2 {
  const headerTitle = params.isError ? "❌ Error" : "✅ Result";
  const template = params.isError ? "red" : "green";
  const body =
    params.text.length === 0
      ? "_(no output)_"
      : truncateForInline(params.text, params.inlineMaxBytes);
  return {
    version: "1.0",
    header: {
      title: { content: headerTitle, tag: "plain_text" },
      template,
    },
    elements: [{ tag: "markdown", content: body }],
  };
}

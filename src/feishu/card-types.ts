/**
 * Narrow TypeScript interface for Feishu Card v2 JSON. The Lark Node
 * SDK does not export any card types, so we define exactly the subset
 * Phase 3 needs and pass card objects to the SDK as
 * `JSON.stringify(card)`.
 *
 * Reference: Feishu open-platform docs, "消息卡片 v2 元素级"
 */
export interface FeishuCardV2 {
  version: "1.0";
  header?: FeishuHeader;
  elements: FeishuElement[];
}

export interface FeishuHeader {
  title: { content: string; tag: "plain_text" };
  subtitle?: { content: string; tag: "plain_text" };
  /** `green` | `red` | `yellow` | `blue` | `grey` (+ others). */
  template?: FeishuHeaderColor;
}

export type FeishuHeaderColor =
  | "green"
  | "red"
  | "yellow"
  | "blue"
  | "grey";

export type FeishuElement =
  | FeishuMarkdownElement
  | FeishuDividerElement;

export interface FeishuMarkdownElement {
  tag: "markdown";
  content: string;
}

export interface FeishuDividerElement {
  tag: "hr";
}

/**
 * Narrow TypeScript interface for Feishu Card v2 (消息卡片 2.0) JSON.
 * The Lark Node SDK does not export any card types, so we define the
 * subset Phase 3 needs and pass card objects to the SDK as
 * `JSON.stringify(card)`.
 *
 * Top-level v2 shape: `{ schema: "2.0", header?, body? }`. Elements
 * live under `body.elements` — NOT at the top level (that's v1 and
 * rejected by the current API with 230099 "Failed to create card
 * content").
 *
 * Reference: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure
 */
export interface FeishuCardV2 {
  schema: "2.0";
  header?: FeishuHeader;
  body?: FeishuCardBody;
}

export interface FeishuCardBody {
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

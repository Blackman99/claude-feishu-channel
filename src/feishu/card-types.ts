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
  /**
   * Card config.
   *
   * - `update_multi: true` is REQUIRED if this card will later be
   *   updated via `im.v1.message.patch`, and it's required at both
   *   send and patch time. In JSON 2.0 `update_multi` only accepts
   *   `true`.
   *
   * - `streaming_mode: true` opts the card into Feishu CardKit's
   *   typewriter rendering. When the card's streamable elements
   *   (markdown / plain_text with `element_id`) receive content
   *   updates via `cardkit.v1.cardElement.content`, the client
   *   diffs against the previous content and animates the delta
   *   with a typing cursor instead of snapping to the new state.
   *
   * - `streaming_config` tunes that animation — see docs for the
   *   full list of knobs. Defaults are reasonable but we tighten
   *   the frequency a bit so Claude's thinking tokens don't stall.
   */
  config?: {
    update_multi?: true;
    streaming_mode?: boolean;
    streaming_config?: {
      print_frequency_ms?: {
        default?: number;
        pc?: number;
        android?: number;
        ios?: number;
      };
      print_step?: {
        default?: number;
        pc?: number;
        android?: number;
        ios?: number;
      };
      print_strategy?: "fast" | "delay";
    };
  };
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
  | FeishuDividerElement
  | FeishuCollapsiblePanelElement;

export interface FeishuMarkdownElement {
  tag: "markdown";
  content: string;
  /**
   * Stable identifier for streaming updates. REQUIRED on any element
   * we intend to target with `cardkit.v1.cardElement.content` — the
   * CardKit endpoint addresses elements by `element_id`, not by
   * position in the body.elements array. Must be 1–20 chars,
   * [a-zA-Z][a-zA-Z0-9_]*. Optional because not every markdown
   * element needs to be streamable (e.g. the tool-activity card
   * body, which is full-replaced via patchCard).
   */
  element_id?: string;
}

export interface FeishuDividerElement {
  tag: "hr";
}

/**
 * Collapsible panel (折叠面板). Phase 3 uses this to render Claude
 * thinking blocks as a default-collapsed card — the user can expand
 * it on demand, and when collapsed the panel does not eat into the
 * final answer's vertical real estate in the Feishu chat timeline.
 *
 * IMPORTANT: the `header.icon` / `icon_position` / `icon_expanded_angle`
 * fields are what make the panel interactive. Without them Feishu
 * renders the panel in a fixed state with NO toggle arrow — the user
 * has no way to expand or collapse it. Always supply the icon.
 *
 * Reference: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/containers/collapsible-panel
 */
export interface FeishuCollapsiblePanelElement {
  tag: "collapsible_panel";
  /** Initial open state. Defaults to false when omitted. */
  expanded?: boolean;
  /**
   * Optional panel background color. Feishu's standard pattern for
   * collapsible panels in AI/assistant use cases uses `grey-100` so
   * the panel sits visually apart from the surrounding body text.
   */
  background_color?: string;
  header: {
    title: { tag: "markdown" | "plain_text"; content: string };
    vertical_align?: "top" | "center" | "bottom";
    padding?: string;
    /**
     * The chevron/arrow icon that the user clicks to toggle the
     * panel. REQUIRED in practice — omitting it produces a panel
     * with no toggle affordance.
     */
    icon?: {
      tag: "standard_icon";
      token: string;
      color?: string;
      size?: string;
    };
    /** `"right"` is the conventional position (matches the docs example). */
    icon_position?: "left" | "right" | "follow_text";
    /**
     * Angle (degrees) the icon rotates when the panel is expanded.
     * `-180` flips a `down-small-ccm_outlined` chevron to point up,
     * which is the visual convention for "open" state.
     */
    icon_expanded_angle?: number;
  };
  vertical_spacing?: string;
  padding?: string;
  border?: {
    color?: string;
    corner_radius?: string;
  };
  elements: FeishuElement[];
}

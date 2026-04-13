import type {
  FeishuCardV2,
  FeishuCollapsiblePanelElement,
  FeishuElement,
} from "./card-types.js";
import { formatToolParams } from "./tool-formatters.js";
import { sanitizeForFeishuMarkdown, truncateForInline } from "./truncate.js";
import { t, type Locale } from "../util/i18n.js";
import type { SessionRecord } from "../persistence/state-store.js";

/**
 * Sanitize then truncate. The order matters: sanitization shortens
 * the string by at most 1 byte per image reference, so it can't
 * push content over the budget, while truncating first could cut
 * off a `![alt](url` mid-URL and leave a partial reference the
 * sanitizer can no longer recognize.
 *
 * Exported because the CardKit streaming path in the dispatcher
 * bypasses `buildThinkingCard` entirely — when we push text via
 * `cardElement.content`, we still need to run the same sanitize +
 * truncate pipeline so the streamed content matches what the card
 * builder would have produced.
 */
export function prepareInline(text: string, maxBytes: number): string {
  return truncateForInline(sanitizeForFeishuMarkdown(text), maxBytes);
}

/**
 * Build a `collapsible_panel` header with all the fields Feishu
 * requires to render a working toggle arrow. Without the `icon` /
 * `icon_position` / `icon_expanded_angle` trio the panel renders
 * with no interactive affordance — the user sees a static section
 * with no way to fold or unfold it, which is how the tool-activity
 * card first shipped and why everything showed expanded with no
 * collapse option.
 *
 * The `down-small-ccm_outlined` chevron flipped `-180°` when open is
 * Feishu's standard pattern for AI/assistant collapsible panels and
 * matches the example in their official docs.
 */
function collapsiblePanelHeader(
  content: string,
): FeishuCollapsiblePanelElement["header"] {
  return {
    title: { tag: "markdown", content },
    vertical_align: "center",
    padding: "4px 0px 4px 8px",
    icon: {
      tag: "standard_icon",
      token: "down-small-ccm_outlined",
      size: "16px 16px",
    },
    icon_position: "right",
    icon_expanded_angle: -180,
  };
}

export interface CardRenderConfig {
  inlineMaxBytes: number;
}

/**
 * The streaming element inside the thinking card. The dispatcher
 * targets this exact id when pushing incremental content to
 * `cardkit.v1.cardElement.content`, so it has to match between the
 * card builder and the caller. Short, lowercase, underscore-safe.
 */
export const THINKING_ELEMENT_ID = "thinking_md";

/**
 * Same as THINKING_ELEMENT_ID but for the aggregated tool activity
 * card. The dispatcher streams the full accumulated "render of all
 * entries" text into this element on every tool_use / tool_result
 * event, so new entries appended at the end render with a
 * typewriter effect (prefix-extension case) and mid-text changes
 * like `⏳ → ✅` fall through to an immediate snap.
 */
export const TOOL_ACTIVITY_ELEMENT_ID = "tool_activity_md";

/**
 * Single-line status card. The dispatcher sends one of these at the
 * very start of each turn (replacing the old "⏳ 收到" text ACK) and
 * then streams short status lines into this element as Claude works —
 * "💭 思考中...", "🔧 Bash: npm test", "✅ 完成" — so the user always
 * sees what the agent is currently doing without having to expand the
 * accumulated thinking/tool cards. Mirrors the Claude CLI's single
 * status line UX. Replaces by snap (not prefix extension), which is
 * exactly what we want for a live cursor.
 */
export const STATUS_ELEMENT_ID = "status_md";

/**
 * Build a Feishu Card v2 representing accumulated Claude thinking
 * text for the current turn. Renders as a default-collapsed
 * `collapsible_panel` titled "💭 思考" — expanding it reveals the
 * full thought text (truncated to `inlineMaxBytes`). The card has no
 * top-level header so the collapsed footprint is minimal.
 *
 * The card opts into CardKit's streaming mode: subsequent thinking
 * blocks within the same turn are delivered via
 * `cardkit.v1.cardElement.content` targeting `THINKING_ELEMENT_ID`,
 * which diffs the text and renders the new suffix with a typewriter
 * cursor animation instead of snapping to the replacement. We still
 * keep `update_multi: true` so the patch endpoint remains a valid
 * fallback (e.g. for the initial send of the card).
 */
export function buildThinkingCard(
  text: string,
  config: CardRenderConfig,
  locale: Locale = "zh",
): FeishuCardV2 {
  const inner =
    text.length === 0 ? "_(empty)_" : prepareInline(text, config.inlineMaxBytes);
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      streaming_config: {
        // Defaults from the CardKit docs are 70ms / 1 char / "fast".
        // Claude's thinking tokens arrive in reasonably large chunks
        // (whole sentences), so we bias slightly toward more chars
        // per tick to keep the cursor moving without outpacing the
        // real stream.
        print_frequency_ms: { default: 50 },
        print_step: { default: 2 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        {
          tag: "collapsible_panel",
          expanded: false,
          background_color: "grey-100",
          header: collapsiblePanelHeader(t(locale).thinkingPanelHeader),
          elements: [
            { tag: "markdown", element_id: THINKING_ELEMENT_ID, content: inner },
          ],
        },
      ],
    },
  };
}

/**
 * Upper byte budget for a final answer card. Feishu caps card
 * payloads at 30KB; we leave some headroom for envelope overhead
 * (schema/config/element wrappers + JSON escaping) and land at
 * 28,000 bytes of markdown content.
 */
const ANSWER_MAX_BYTES = 28_000;

/**
 * Build a Feishu Card v2 for a final assistant answer. Claude's
 * output routinely contains markdown (code fences, bold, lists) and
 * sending it as `msg_type: "text"` would show the markers literally
 * — so final answers go through a card with a single markdown
 * element instead. Card has no header and no config.update_multi
 * because it is never patched after send. The body is capped at
 * `ANSWER_MAX_BYTES` (not `inlineMaxBytes`, which is meant for tool
 * input/output summaries).
 */
export function buildAnswerCard(text: string): FeishuCardV2 {
  const body =
    text.length === 0 ? "_(empty)_" : prepareInline(text, ANSWER_MAX_BYTES);
  return {
    schema: "2.0",
    body: {
      elements: [{ tag: "markdown", content: body }],
    },
  };
}

/**
 * Build a single-line status card used as the turn's "live cursor".
 * Rendered as a headerless Card v2 with one streamable markdown
 * element — the dispatcher sends this at turn start and then pushes
 * short lines ("💭 思考中...", "🔧 Bash", "✅ 完成") into it via
 * `cardkit.v1.cardElement.content` so the user always sees what
 * Claude is currently doing. The thinking and tool activity cards
 * accumulate below it for on-demand inspection; this card is the
 * always-visible "what's happening now" line.
 *
 * Streaming mode is on so the card qualifies for
 * `cardElement.content` updates, and `update_multi` stays on as a
 * fallback path in case `idConvert` fails on the initial send.
 */
export function buildStatusCard(initial: string, locale: Locale = "zh"): FeishuCardV2 {
  const text = initial.length === 0 ? t(locale).statusProcessing : initial;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      // Status text is a single short line replaced in-place — no
      // real typewriter animation is desired. A fast print strategy
      // still lets the snap happen immediately when the content
      // changes (e.g. 思考中 → Bash 执行中).
      streaming_config: {
        print_frequency_ms: { default: 10 },
        print_step: { default: 4 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: STATUS_ELEMENT_ID,
          content: text,
        },
      ],
    },
  };
}

/**
 * A single tool invocation entry for the aggregated tool activity
 * card. `result` is undefined while the tool is still running (e.g.
 * between the tool_use and tool_result stream events).
 */
export interface ToolActivityEntry {
  toolUseId: string;
  name: string;
  input: unknown;
  result?: { text: string; isError: boolean };
}

/**
 * Build the single "tool activity" card for a turn. Rendered as a
 * default-**collapsed** `collapsible_panel` titled "🔧 工具活动" — the
 * running single-line "what's happening now" view lives in the
 * separate status card instead, so this card only exists as an
 * on-demand audit trail. Users expand it when they want the full
 * per-tool history. Panel body is a single markdown element with
 * one block per tool (index, name, input summary, result or pending
 * marker), streamed via `cardkit.v1.cardElement.content` on every
 * tool_use / tool_result event. There is no top-level card header
 * because the panel's own header carries the label.
 */
export function buildToolActivityCard(
  entries: readonly ToolActivityEntry[],
  config: CardRenderConfig,
  locale: Locale = "zh",
): FeishuCardV2 {
  const bodyText = renderToolActivityBody(entries, config.inlineMaxBytes, locale);
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      // Tighter tick than the thinking card: tool text arrives
      // event-driven (one burst per tool_use / tool_result), not
      // token-by-token, so a faster typewriter keeps the animation
      // from feeling "behind" the real stream.
      streaming_config: {
        print_frequency_ms: { default: 30 },
        print_step: { default: 3 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        {
          tag: "collapsible_panel",
          expanded: false,
          background_color: "grey-100",
          // Title deliberately does NOT include the entry count.
          // CardKit's streaming element updates only touch the
          // inner markdown — anything we put in the panel title
          // would stay frozen at the value from the initial
          // sendCard. The running count is rendered inside the
          // streamed body instead, so it actually updates.
          header: collapsiblePanelHeader(t(locale).toolActivityPanelHeader),
          elements: [
            {
              tag: "markdown",
              element_id: TOOL_ACTIVITY_ELEMENT_ID,
              content: bodyText,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Build just the markdown text that lives inside the tool activity
 * card's streamable element. Exported so the dispatcher can push
 * the same text to `cardElement.content` on subsequent tool events
 * without rebuilding the entire card JSON.
 *
 * The body leads with a `共 N 个工具` summary line so the count
 * stays live under streaming (the panel title is frozen at whatever
 * value the server holds from the initial sendCard — CardKit's
 * element-content endpoint only touches the addressed element).
 */
export function renderToolActivityBody(
  entries: readonly ToolActivityEntry[],
  inlineMaxBytes: number,
  locale: Locale = "zh",
): string {
  if (entries.length === 0) return "_(no tools yet)_";
  const summary = t(locale).toolCount(entries.length);
  const body = entries
    .map((e, i) => renderEntry(i + 1, e, inlineMaxBytes, locale))
    .join("\n\n");
  return `${summary}\n\n${body}`;
}

function renderEntry(
  index: number,
  entry: ToolActivityEntry,
  inlineMaxBytes: number,
  locale: Locale = "zh",
): string {
  // Use an h3 header instead of `**bold**`. Feishu's markdown parser
  // requires spaces around `**` markers and won't reliably render
  // bold at the start of a line — headings avoid that whole class of
  // of rendering pitfall. Paragraphs are separated by blank lines
  // (\n\n) so each line renders as its own block instead of being
  // collapsed into a single run of text.
  const paramSummary = formatToolParams(entry.name, entry.input);
  const header = `### ${index}. ${entry.name}`;
  const inputBlock = prepareInline(paramSummary, inlineMaxBytes);
  let resultBlock: string;
  if (!entry.result) {
    resultBlock = t(locale).toolRunning;
  } else {
    const marker = entry.result.isError ? "❌" : "✅";
    const body =
      entry.result.text.length === 0
        ? "_(no output)_"
        : prepareInline(entry.result.text, inlineMaxBytes);
    resultBlock = `${marker} ${body}`;
  }
  return `${header}\n\n${inputBlock}\n\n${resultBlock}`;
}

// ── Sessions card ──────────────────────────────────────────────────

export interface SessionEntry {
  chatId: string;
  projectAlias?: string;
  record: SessionRecord;
  active: boolean;
}

/**
 * Format an ISO timestamp as a human-readable relative time string.
 * Uses the given `now` for testability; falls back to `Date.now()`.
 */
export function formatRelativeTime(
  isoTimestamp: string,
  locale: Locale,
  now?: number,
): string {
  const ts = new Date(isoTimestamp).getTime();
  if (Number.isNaN(ts)) return isoTimestamp;
  const diffMs = (now ?? Date.now()) - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return locale === "zh" ? "刚刚" : "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return locale === "zh" ? `${diffMin} 分钟前` : `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return locale === "zh" ? `${diffHour} 小时前` : `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return locale === "zh" ? `${diffDay} 天前` : `${diffDay}d ago`;
}

/**
 * Build a Feishu Card v2 listing all known sessions. Each session is
 * rendered as a structured markdown block with project name, working
 * directory, model, last-active time, and status — far more readable
 * than the old single-line plain-text format.
 */
export function buildSessionsCard(
  entries: readonly SessionEntry[],
  locale: Locale = "zh",
  now?: number,
): FeishuCardV2 {
  const strings = t(locale);
  const elements: FeishuElement[] = [];

  elements.push({
    tag: "markdown",
    content: strings.sessionsCount(entries.length),
  });

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (i > 0) elements.push({ tag: "hr" });

    const projectLabel = entry.projectAlias
      ? strings.sessionsProject(entry.projectAlias)
      : strings.sessionsDefaultProject;
    const status = entry.active ? strings.sessionsActive : strings.sessionsStale;
    const timeAgo = formatRelativeTime(entry.record.lastActiveAt, locale, now);

    const lines = [
      `**${projectLabel}** ${status}`,
      strings.sessionsCwd(entry.record.cwd),
      strings.sessionsModel(entry.record.model ?? "-"),
      strings.sessionsLastActive(timeAgo),
    ];

    elements.push({ tag: "markdown", content: lines.join("\n") });
  }

  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: strings.sessionsHeader },
      template: "blue",
    },
    body: { elements },
  };
}

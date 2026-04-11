import type {
  FeishuCardV2,
  FeishuElement,
} from "../card-types.js";
import { truncateForInline } from "../truncate.js";

/** Upper bound for the code-block preview of a tool's input. */
const INPUT_PREVIEW_MAX_BYTES = 1_500;

interface BuildPendingArgs {
  requestId: string;
  toolName: string;
  input: unknown;
  ownerOpenId: string;
}

/**
 * Build the pending-state permission card with 4 buttons. The
 * buttons' `value` field carries `{kind: "permission", request_id,
 * choice}` so the gateway's `card.action.trigger` handler can route
 * clicks back to `broker.resolveByCard(requestId, choice)`.
 *
 * The card uses `config.update_multi: true` because the broker
 * patches it to a "resolved" / "cancelled" / "timed_out" variant on
 * button click or timeout. `streaming_mode` is off — permission cards
 * aren't streamed, only patched.
 */
export function buildPermissionCard(args: BuildPendingArgs): FeishuCardV2 {
  const preview = formatInputPreview(args.input);
  const elements: FeishuElement[] = [
    {
      tag: "markdown",
      content: `Claude 要调用工具 **${escapeMd(args.toolName)}**：`,
    },
    {
      tag: "markdown",
      content: "```json\n" + preview + "\n```",
    },
    buttonRow([
      makeButton("✅ 允许", "allow", args.requestId, "primary"),
      makeButton("❌ 拒绝", "deny", args.requestId, "danger"),
    ]),
    buttonRow([
      makeButton("✅ 本轮 acceptEdits", "allow_turn", args.requestId, "default"),
      makeButton("✅ 会话 acceptEdits", "allow_session", args.requestId, "default"),
    ]),
    {
      tag: "markdown",
      content:
        '<font color="grey">只有发起者可点击 · 5 分钟未响应自动拒绝</font>',
    },
  ];

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: `🔐 权限请求 · ${args.toolName}`,
      },
      template: "yellow",
    },
    body: { elements },
  };
}

interface BuildResolvedArgs {
  toolName: string;
  choice: "allow" | "deny" | "allow_turn" | "allow_session";
}

/**
 * Compact one-line variant shown after a click. Drops the header and
 * replaces the pending body with a single markdown line — mirrors how
 * the CLI collapses a resolved permission prompt to "tool: choice".
 */
export function buildPermissionCardResolved(
  args: BuildResolvedArgs,
): FeishuCardV2 {
  const label = RESOLVED_LABEL[args.choice];
  const icon = args.choice === "deny" ? "❌" : "✅";
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `${icon} ${label} · \`${escapeMd(args.toolName)}\``,
        },
      ],
    },
  };
}

const RESOLVED_LABEL: Record<BuildResolvedArgs["choice"], string> = {
  allow: "允许",
  deny: "拒绝",
  allow_turn: "本轮 acceptEdits",
  allow_session: "会话 acceptEdits",
};

export function buildPermissionCardCancelled(args: {
  toolName: string;
  reason: string;
}): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `🛑 已取消 \`${escapeMd(args.toolName)}\`（${escapeMd(args.reason)}）`,
        },
      ],
    },
  };
}

export function buildPermissionCardTimedOut(args: {
  toolName: string;
}): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `⏰ 已超时 \`${escapeMd(args.toolName)}\``,
        },
      ],
    },
  };
}

// --- helpers ---

function buttonRow(buttons: FeishuElement[]): FeishuElement {
  return {
    tag: "column_set",
    flex_mode: "bisect",
    horizontal_spacing: "8px",
    columns: buttons.map((b) => ({
      tag: "column" as const,
      width: "weighted",
      weight: 1,
      elements: [b],
    })),
  };
}

function makeButton(
  label: string,
  choice: "allow" | "deny" | "allow_turn" | "allow_session",
  requestId: string,
  type: "primary" | "danger" | "default",
): FeishuElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    width: "fill",
    value: { kind: "permission", request_id: requestId, choice },
  };
}

function formatInputPreview(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return truncateForInline(json, INPUT_PREVIEW_MAX_BYTES);
}

function escapeMd(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}

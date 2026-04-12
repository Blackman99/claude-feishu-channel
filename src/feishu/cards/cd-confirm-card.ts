import type {
  FeishuCardV2,
  FeishuElement,
} from "../card-types.js";

// --- public builders ---

export function buildCdConfirmCard(args: {
  requestId: string;
  targetPath: string;
}): FeishuCardV2 {
  const elements: FeishuElement[] = [
    {
      tag: "markdown",
      content: `切换工作目录至：\`${escapeMd(args.targetPath)}\``,
    },
    buttonRow([
      makeButton("✅ 确认", args.requestId, true, "primary"),
      makeButton("❌ 取消", args.requestId, false, "danger"),
    ]),
    {
      tag: "markdown",
      content: '<font color="grey">只有发起者可点击 · 5 分钟未响应自动取消</font>',
    },
  ];

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: "📁 切换工作目录",
      },
      template: "blue",
    },
    body: { elements },
  };
}

export function buildCdConfirmResolved(args: { targetPath: string }): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `📁 工作目录已切换为 \`${escapeMd(args.targetPath)}\``,
        },
      ],
    },
  };
}

export function buildCdConfirmCancelled(): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "🛑 已取消切换工作目录",
        },
      ],
    },
  };
}

export function buildCdConfirmTimedOut(): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "⏰ 切换工作目录已超时",
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
  requestId: string,
  accepted: boolean,
  type: "primary" | "danger",
): FeishuElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    width: "fill",
    value: { kind: "cd_confirm", request_id: requestId, accepted },
  };
}

function escapeMd(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}

import type {
  FeishuCardV2,
  FeishuElement,
} from "../card-types.js";
import { t, type Locale } from "../../util/i18n.js";

// --- public builders ---

export function buildCdConfirmCard(args: {
  requestId: string;
  targetPath: string;
  locale: Locale;
}): FeishuCardV2 {
  const s = t(args.locale);
  const elements: FeishuElement[] = [
    {
      tag: "markdown",
      content: s.cdCardPrompt(escapeMd(args.targetPath)),
    },
    buttonRow([
      makeButton(s.cdBtnConfirm, args.requestId, true, "primary"),
      makeButton(s.cdBtnCancel, args.requestId, false, "danger"),
    ]),
    {
      tag: "markdown",
      content: `<font color="grey">${s.cdFooter}</font>`,
    },
  ];

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: s.cdCardHeader,
      },
      template: "blue",
    },
    body: { elements },
  };
}

export function buildCdConfirmResolved(args: {
  targetPath: string;
  locale: Locale;
}): FeishuCardV2 {
  const s = t(args.locale);
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: s.cdResolved(escapeMd(args.targetPath)),
        },
      ],
    },
  };
}

export function buildCdConfirmCancelled(args: { locale: Locale }): FeishuCardV2 {
  const s = t(args.locale);
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: s.cdCancelled,
        },
      ],
    },
  };
}

export function buildCdConfirmTimedOut(args: { locale: Locale }): FeishuCardV2 {
  const s = t(args.locale);
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: s.cdTimedOut,
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

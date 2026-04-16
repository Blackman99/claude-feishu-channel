import type {
  FeishuCardV2,
  FeishuElement,
} from "../card-types.js";
import type { AskUserQuestionSpec } from "../../claude/question-broker.js";
import { t, type Locale } from "../../util/i18n.js";

/** Max characters for a button label before it wraps unpleasantly. */
const BUTTON_LABEL_MAX = 18;
const OPTION_PREFIXES = ["A.", "B.", "C.", "D."] as const;

interface BuildPendingArgs {
  requestId: string;
  questions: ReadonlyArray<AskUserQuestionSpec>;
  /**
   * Per-question answers collected so far. `null` at index i means
   * question i is still pending (render its buttons). A string means
   * the user picked that option label for question i (render it as a
   * one-line ✅ row).
   */
  answers: ReadonlyArray<string | null>;
  locale: Locale;
}

/**
 * Build the pending-state question card. Multi-question: each
 * question gets its own row. Partial clicks (some answered, some
 * not) re-render through this same builder — the broker patches the
 * card in place via `update_multi: true`.
 *
 * Button `value` is `{kind: "question", request_id, question_index,
 * option_index}` so the gateway's `card.action.trigger` handler can
 * route clicks back to `broker.resolveByCard`.
 */
export function buildQuestionCard(args: BuildPendingArgs): FeishuCardV2 {
  const s = t(args.locale);
  const elements: FeishuElement[] = [];

  args.questions.forEach((q, i) => {
    // Question prompt line.
    const headerPrefix = q.header
      ? `<font color="grey">[${escapeMd(q.header)}]</font> `
      : "";
    elements.push({
      tag: "markdown",
      content: `${headerPrefix}**Q${i + 1}.** ${escapeMd(q.question)}`,
    });

    const answered = args.answers[i];
    if (answered !== null && answered !== undefined) {
      elements.push({
        tag: "markdown",
        content: `✅ **${escapeMd(answered)}**`,
      });
    } else {
      // Render options as button rows. Feishu buttons inside a
      // `column_set` fit 2 per row comfortably; for 3–4 options we
      // use two rows of two (or one row of 3 flowing wide).
      const buttons = q.options.map((opt, j) =>
        makeButton(opt.label, args.requestId, i, j),
      );
      elements.push(...layoutButtons(buttons));
    }
  });

  elements.push({
    tag: "markdown",
    content: `<font color="grey">${s.questionFooter}</font>`,
  });

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: s.questionCardHeader(args.questions.length),
      },
      template: "yellow",
    },
    body: { elements },
  };
}

interface BuildResolvedArgs {
  questions: ReadonlyArray<AskUserQuestionSpec>;
  /** Final answers — one string per question, same order. */
  answers: ReadonlyArray<string>;
}

/**
 * Compact one-line-per-question variant shown once all questions
 * have been answered. Drops the header to match the resolved
 * permission card's visual weight.
 */
export function buildQuestionCardResolved(
  args: BuildResolvedArgs,
): FeishuCardV2 {
  const lines = args.questions.map((q, i) => {
    const label = q.header ? `\`${escapeMd(q.header)}\`` : `\`Q${i + 1}\``;
    return `❓ ${label} → **${escapeMd(args.answers[i] ?? "")}**`;
  });
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: lines.join("\n"),
        },
      ],
    },
  };
}

export function buildQuestionCardCancelled(args: {
  reason: string;
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
          content: s.questionCancelled(escapeMd(args.reason)),
        },
      ],
    },
  };
}

export function buildQuestionCardTimedOut(args: { locale: Locale }): FeishuCardV2 {
  const s = t(args.locale);
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: s.questionTimedOut,
        },
      ],
    },
  };
}

// --- helpers ---

function layoutButtons(buttons: FeishuElement[]): FeishuElement[] {
  if (buttons.length === 0) return [];
  // 2 options → one row of 2; 3 options → one row of 3; 4 options →
  // two rows of 2. Feishu `column_set` in `bisect` / `trisect` mode
  // distributes width evenly.
  if (buttons.length === 2) return [buttonRow(buttons, "bisect")];
  if (buttons.length === 3) return [buttonRow(buttons, "trisect")];
  // 4 (or more — AskUserQuestionInput caps at 4)
  return [
    buttonRow(buttons.slice(0, 2), "bisect"),
    buttonRow(buttons.slice(2, 4), "bisect"),
  ];
}

function buttonRow(
  buttons: FeishuElement[],
  flex: "bisect" | "trisect",
): FeishuElement {
  return {
    tag: "column_set",
    flex_mode: flex,
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
  questionIndex: number,
  optionIndex: number,
): FeishuElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: buttonDisplayLabel(optionIndex, label) },
    type: "default",
    width: "fill",
    value: {
      kind: "question",
      request_id: requestId,
      question_index: questionIndex,
      option_index: optionIndex,
    },
  };
}

function buttonDisplayLabel(optionIndex: number, label: string): string {
  return `${optionPrefix(optionIndex)} ${clipButtonLabel(label)}`;
}

function optionPrefix(optionIndex: number): string {
  return OPTION_PREFIXES[optionIndex] ?? `${optionIndex + 1}.`;
}

function clipButtonLabel(label: string): string {
  // Count code points, not bytes — Chinese button text is common
  // and we want the visual length, not the UTF-8 length.
  const clipped = label.trim();
  const chars = Array.from(clipped);
  if (chars.length <= BUTTON_LABEL_MAX) return clipped;
  return chars.slice(0, BUTTON_LABEL_MAX - 1).join("") + "…";
}

function escapeMd(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}

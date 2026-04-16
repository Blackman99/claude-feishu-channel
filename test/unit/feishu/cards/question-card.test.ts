import { describe, it, expect } from "vitest";
import {
  buildQuestionCard,
  buildQuestionCardResolved,
  buildQuestionCardCancelled,
  buildQuestionCardTimedOut,
} from "../../../../src/feishu/cards/question-card.js";
import type { AskUserQuestionSpec } from "../../../../src/claude/question-broker.js";

const Q1: AskUserQuestionSpec = {
  question: "Which editor do you prefer?",
  header: "Editor",
  options: [
    { label: "Vim", description: "Modal editing forever" },
    { label: "Emacs", description: "The kitchen sink" },
  ],
  multiSelect: false,
};

const Q2: AskUserQuestionSpec = {
  question: "Which shell?",
  options: [
    { label: "bash", description: "Bourne-again" },
    { label: "zsh", description: "Z shell" },
    { label: "fish", description: "Friendly" },
  ],
  multiSelect: false,
};

function collectButtons(card: unknown): Array<{
  label: string;
  value: Record<string, unknown>;
}> {
  const out: Array<{ label: string; value: Record<string, unknown> }> = [];
  function walk(el: unknown): void {
    if (!el || typeof el !== "object") return;
    const e = el as {
      tag?: string;
      text?: { content?: string };
      value?: Record<string, unknown>;
      elements?: unknown[];
      columns?: unknown[];
    };
    if (e.tag === "button" && e.value) {
      out.push({ label: e.text?.content ?? "", value: e.value });
    }
    if (Array.isArray(e.elements)) e.elements.forEach(walk);
    if (Array.isArray(e.columns)) e.columns.forEach(walk);
  }
  const c = card as { body?: { elements?: unknown[] } };
  c.body?.elements?.forEach(walk);
  return out;
}

describe("buildQuestionCard (pending)", () => {
  it("renders one question with one button per option, tagged with request_id + indices", () => {
    const card = buildQuestionCard({
      requestId: "req_1",
      questions: [Q1],
      answers: [null],
      locale: "zh",
    });
    expect(card.schema).toBe("2.0");
    expect(card.config?.update_multi).toBe(true);
    expect(card.header?.title.content).toContain("问题");

    const buttons = collectButtons(card);
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.value.kind).toBe("question");
      expect(b.value.request_id).toBe("req_1");
      expect(b.value.question_index).toBe(0);
    }
    expect(buttons.map((b) => b.value.option_index).sort()).toEqual([0, 1]);
    expect(buttons.map((b) => b.label)).toEqual(
      expect.arrayContaining(["A. Vim", "B. Emacs"]),
    );
  });

  it("renders the question text and the optional category header", () => {
    const card = buildQuestionCard({
      requestId: "r",
      questions: [Q1],
      answers: [null],
      locale: "zh",
    });
    const json = JSON.stringify(card);
    expect(json).toContain("Which editor do you prefer?");
    expect(json).toContain("Editor");
  });

  it("renders N button rows for N questions, each tagged with its question_index", () => {
    const card = buildQuestionCard({
      requestId: "r",
      questions: [Q1, Q2],
      answers: [null, null],
      locale: "zh",
    });
    const buttons = collectButtons(card);
    // 2 options for Q1 + 3 for Q2 = 5 total
    expect(buttons).toHaveLength(5);
    const q0Count = buttons.filter((b) => b.value.question_index === 0).length;
    const q1Count = buttons.filter((b) => b.value.question_index === 1).length;
    expect(q0Count).toBe(2);
    expect(q1Count).toBe(3);
    // Q2 title present in card
    expect(JSON.stringify(card)).toContain("Which shell?");
  });

  it("replaces the button row with a ✅ line for an already-answered question, keeps buttons for the unanswered one", () => {
    const card = buildQuestionCard({
      requestId: "r",
      questions: [Q1, Q2],
      answers: ["Vim", null],
      locale: "zh",
    });
    const buttons = collectButtons(card);
    // Q1 is answered → no buttons for question_index 0.
    expect(buttons.filter((b) => b.value.question_index === 0)).toHaveLength(0);
    // Q2 still has all 3.
    expect(buttons.filter((b) => b.value.question_index === 1)).toHaveLength(3);
    // Answer label appears in the card body.
    expect(JSON.stringify(card)).toContain("Vim");
  });

  it("includes an owner-only disclaimer", () => {
    const card = buildQuestionCard({
      requestId: "r",
      questions: [Q1],
      answers: [null],
      locale: "zh",
    });
    const json = JSON.stringify(card);
    expect(json).toMatch(/发起者|owner|only/i);
  });

  it("truncates overly long button labels to fit", () => {
    const long = "这是一个非常非常非常非常非常非常非常非常非常长的选项标签";
    const card = buildQuestionCard({
      requestId: "r",
      questions: [
        {
          question: "Pick one",
          options: [
            { label: long, description: "too long" },
            { label: "short", description: "ok" },
          ],
          multiSelect: false,
        },
      ],
      answers: [null],
      locale: "zh",
    });
    const buttons = collectButtons(card);
    const longBtn = buttons.find((b) => b.label !== "short");
    expect(longBtn).toBeDefined();
    // Ellipsis sentinel = truncation happened; the raw long string
    // is not present verbatim.
    expect(longBtn!.label).toContain("…");
    expect(longBtn!.label).not.toBe(long);
  });
});

describe("buildQuestionCardResolved", () => {
  it("renders a compact one-line-per-question variant with no buttons or header", () => {
    const card = buildQuestionCardResolved({
      questions: [Q1, Q2],
      answers: ["Vim", "zsh"],
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(card.header).toBeUndefined();
    expect(card.body?.elements).toHaveLength(1);
    expect(json).toContain("Vim");
    expect(json).toContain("zsh");
  });
});

describe("buildQuestionCardCancelled", () => {
  it("renders a cancelled notice with the reason, no buttons, no header", () => {
    const card = buildQuestionCardCancelled({ reason: "User issued /stop", locale: "zh" });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(card.header).toBeUndefined();
    expect(json).toMatch(/取消|cancel/i);
    expect(json).toContain("/stop");
  });
});

describe("buildQuestionCardTimedOut", () => {
  it("renders a timed-out notice with no buttons, no header", () => {
    const card = buildQuestionCardTimedOut({ locale: "zh" });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(card.header).toBeUndefined();
    expect(json).toMatch(/超时|timed out/i);
  });
});

import { describe, it, expect, vi } from "vitest";
import { FeishuQuestionBroker } from "../../../src/claude/feishu-question-broker.js";
import type { FeishuClient } from "../../../src/feishu/client.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import type { AskUserQuestionSpec } from "../../../src/claude/question-broker.js";

const SILENT = createLogger({ level: "error", pretty: false });

const Q1: AskUserQuestionSpec = {
  question: "Which editor?",
  options: [
    { label: "Vim", description: "" },
    { label: "Emacs", description: "" },
  ],
  multiSelect: false,
};

const Q2: AskUserQuestionSpec = {
  question: "Which shell?",
  options: [
    { label: "bash", description: "" },
    { label: "zsh", description: "" },
    { label: "fish", description: "" },
  ],
  multiSelect: false,
};

function makeFakeFeishu(): {
  client: FeishuClient;
  replyCard: ReturnType<typeof vi.fn>;
  patchCard: ReturnType<typeof vi.fn>;
  replyText: ReturnType<typeof vi.fn>;
} {
  const replyCard = vi.fn().mockResolvedValue({ messageId: "om_card_1" });
  const patchCard = vi.fn().mockResolvedValue(undefined);
  const replyText = vi.fn().mockResolvedValue({ messageId: "om_text_1" });
  const client = { replyCard, patchCard, replyText } as unknown as FeishuClient;
  return { client, replyCard, patchCard, replyText };
}

function makeBroker(feishu: FeishuClient, clock: FakeClock) {
  return new FeishuQuestionBroker({
    feishu,
    clock,
    logger: SILENT,
    config: { timeoutMs: 300_000, warnBeforeMs: 60_000 },
  });
}

function findRequestIdInCard(card: unknown): string {
  let found: string | undefined;
  function walk(el: unknown): void {
    if (!el || typeof el !== "object") return;
    const e = el as {
      tag?: string;
      value?: { request_id?: unknown };
      elements?: unknown[];
      columns?: unknown[];
      body?: unknown;
    };
    if (
      e.tag === "button" &&
      e.value &&
      typeof e.value.request_id === "string"
    ) {
      found = e.value.request_id;
    }
    if (Array.isArray(e.elements)) e.elements.forEach(walk);
    if (Array.isArray(e.columns)) e.columns.forEach(walk);
    if (e.body) walk(e.body);
  }
  walk(card);
  if (!found) throw new Error("no request_id found in card");
  return found;
}

describe("FeishuQuestionBroker.request — happy path", () => {
  it("sends a question card via replyCard with the parent message id", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    void broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_parent_1",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.replyCard).toHaveBeenCalledTimes(1);
    const [parentId, card] = f.replyCard.mock.calls[0]!;
    expect(parentId).toBe("om_parent_1");
    expect(JSON.stringify(card)).toContain("Which editor?");
  });

  it("renders long option labels as compact prefixed button text", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const longQuestion: AskUserQuestionSpec = {
      question: "Which rollout path should we take for the next deployment?",
      options: [
        {
          label: "Use existing workspace and continue from the latest branch state",
          description: "",
        },
        {
          label: "Create a fresh workspace and replay only the verified steps",
          description: "",
        },
      ],
      multiSelect: false,
    };

    void broker.request({
      questions: [longQuestion],
      chatId: "oc_x",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
      locale: "en",
    });
    await Promise.resolve();
    await Promise.resolve();

    const json = JSON.stringify(f.replyCard.mock.calls[0]![1]);
    expect(json).toContain("A. Use existing");
    expect(json).toContain("B. Create a fresh");
    expect(json).not.toContain(longQuestion.options[0]!.label);
  });

  it("returns a pending promise until a click lands", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
      locale: "zh",
    });
    const result = await Promise.race([
      p,
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(result).toBe("pending");
  });

  it("returns cancelled if replyCard throws", async () => {
    const f = makeFakeFeishu();
    f.replyCard.mockRejectedValueOnce(new Error("send failed"));
    const broker = makeBroker(f.client, new FakeClock());
    const res = await broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
      locale: "zh",
    });
    expect(res).toEqual({
      kind: "cancelled",
      reason: expect.stringMatching(/Failed/),
    });
  });
});

describe("FeishuQuestionBroker.resolveByCard — single question", () => {
  it("owner click with a valid option resolves and returns the compact card", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();

    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);
    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: { questionIndex: 0, optionIndex: 0 },
    });
    // Broker now returns the resolved card so the gateway can
    // replay it in the `card.action.trigger` callback response body.
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    expect(result.card).toBeDefined();
    const resolvedJson = JSON.stringify(result.card);
    // Compact variant has no buttons and surfaces the chosen answer.
    expect(resolvedJson).not.toContain('"tag":"button"');
    expect(resolvedJson).toContain("Vim");

    const resp = await p;
    expect(resp).toEqual({
      kind: "answered",
      answers: { "Which editor?": "Vim" },
    });
    // patchCard is NOT used on the click path — the callback-response
    // channel is the only reliable visual-update mechanism for
    // click-triggered updates.
    expect(f.patchCard).not.toHaveBeenCalled();
  });

  it("returns the original full option label after clicking a shortened button", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const longLabel =
      "Use existing workspace and continue from the latest branch state";

    const pending = broker.request({
      questions: [
        {
          question: "Which rollout path?",
          options: [
            { label: longLabel, description: "" },
            { label: "Create a fresh workspace", description: "" },
          ],
          multiSelect: false,
        },
      ],
      chatId: "oc_x",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
      locale: "en",
    });

    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_x",
      choice: { questionIndex: 0, optionIndex: 0 },
    });

    await expect(pending).resolves.toMatchObject({
      kind: "answered",
      answers: {
        "Which rollout path?": longLabel,
      },
    });
  });

  it("non-owner click returns forbidden and leaves the request pending", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();

    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);
    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_intruder",
      choice: { questionIndex: 0, optionIndex: 0 },
    });
    expect(result).toEqual({ kind: "forbidden", ownerOpenId: "ou_owner" });

    const settled = await Promise.race([
      p.then(() => "resolved"),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(settled).toBe("pending");
  });

  it("unknown requestId returns not_found", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const result = await broker.resolveByCard({
      requestId: "req_does_not_exist",
      senderOpenId: "ou_x",
      choice: { questionIndex: 0, optionIndex: 0 },
    });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("out-of-range option index returns not_found without resolving", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);
    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: { questionIndex: 0, optionIndex: 99 },
    });
    expect(result).toEqual({ kind: "not_found" });
    const settled = await Promise.race([
      p.then(() => "resolved"),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(settled).toBe("pending");
  });

});

describe("FeishuQuestionBroker.resolveByCard — multi question", () => {
  it("keeps the request pending after the first of two clicks and returns a partial card", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      questions: [Q1, Q2],
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    // Answer Q1 first.
    const r1 = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: { questionIndex: 0, optionIndex: 0 }, // Vim
    });
    expect(r1.kind).toBe("resolved");
    if (r1.kind !== "resolved") throw new Error("unreachable");

    // Partial card returned in the result — gateway replays it in the
    // callback response. patchCard is NOT used on the click path.
    expect(r1.card).toBeDefined();
    const partialJson = JSON.stringify(r1.card);
    expect(partialJson).toContain("Vim");
    expect(partialJson).toContain("Which shell?");
    expect(f.patchCard).not.toHaveBeenCalled();

    // Promise still pending.
    const midway = await Promise.race([
      p.then(() => "resolved"),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(midway).toBe("pending");

    // Answer Q2.
    const r2 = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: { questionIndex: 1, optionIndex: 2 }, // fish
    });
    expect(r2.kind).toBe("resolved");
    if (r2.kind !== "resolved") throw new Error("unreachable");
    expect(r2.card).toBeDefined();
    const finalJson = JSON.stringify(r2.card);
    // Final card is the compact resolved variant — no buttons, both
    // answers visible.
    expect(finalJson).not.toContain('"tag":"button"');
    expect(finalJson).toContain("Vim");
    expect(finalJson).toContain("fish");

    const resp = await p;
    expect(resp).toEqual({
      kind: "answered",
      answers: { "Which editor?": "Vim", "Which shell?": "fish" },
    });
    // patchCard still not called on the click path.
    expect(f.patchCard).not.toHaveBeenCalled();
  });

  it("ignores duplicate clicks on an already-answered question", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      questions: [Q1, Q2],
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: { questionIndex: 0, optionIndex: 0 }, // Vim
    });
    // A second click on Q1 — should be a no-op but return resolved.
    const r2 = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: { questionIndex: 0, optionIndex: 1 }, // Emacs
    });
    expect(r2).toEqual({ kind: "resolved" });

    // Finish Q2 → final answer should still be Vim, not Emacs.
    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: { questionIndex: 1, optionIndex: 0 }, // bash
    });
    expect(await p).toEqual({
      kind: "answered",
      answers: { "Which editor?": "Vim", "Which shell?": "bash" },
    });
  });
});

describe("FeishuQuestionBroker.cancelAll", () => {
  it("resolves all pending requests with cancelled and patches each card", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p1 = broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p1",
      locale: "zh",
    });
    f.replyCard.mockResolvedValueOnce({ messageId: "om_card_2" });
    const p2 = broker.request({
      questions: [Q2],
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p2",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();

    broker.cancelAll("User issued /stop");

    expect(await p1).toEqual({
      kind: "cancelled",
      reason: "User issued /stop",
    });
    expect(await p2).toEqual({
      kind: "cancelled",
      reason: "User issued /stop",
    });

    // Let void-catch patchCards settle.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(f.patchCard).toHaveBeenCalled();
    // The cancelled variant text should appear.
    const anyCancelled = f.patchCard.mock.calls.some((call) =>
      /取消|cancel/i.test(JSON.stringify(call[1])),
    );
    expect(anyCancelled).toBe(true);
  });

  it("swallows patchCard errors", async () => {
    const f = makeFakeFeishu();
    f.patchCard.mockRejectedValue(new Error("down"));
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => broker.cancelAll("cleanup")).not.toThrow();
    expect(await p).toEqual({ kind: "cancelled", reason: "cleanup" });
  });
});

describe("FeishuQuestionBroker timers", () => {
  it("auto-times-out after timeoutMs and patches the card to timed_out", async () => {
    const f = makeFakeFeishu();
    const clock = new FakeClock();
    const broker = makeBroker(f.client, clock);
    const p = broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();

    clock.advance(300_000);
    expect(await p).toEqual({ kind: "timed_out" });
    await new Promise<void>((r) => setTimeout(r, 10));
    const lastCard = f.patchCard.mock.calls.at(-1)![1];
    expect(JSON.stringify(lastCard)).toMatch(/超时|timed out/i);
  });

  it("sends the warn reminder (timeoutMs - warnBeforeMs) in", async () => {
    const f = makeFakeFeishu();
    const clock = new FakeClock();
    const broker = makeBroker(f.client, clock);
    void broker.request({
      questions: [Q1],
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
      locale: "zh",
    });
    await Promise.resolve();
    await Promise.resolve();

    clock.advance(240_000);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(f.replyText).toHaveBeenCalled();
    const replyArgs = f.replyText.mock.calls.at(-1)!;
    expect(replyArgs[0]).toBe("om_p");
    expect(String(replyArgs[1])).toMatch(/60|⏰/);
  });
});

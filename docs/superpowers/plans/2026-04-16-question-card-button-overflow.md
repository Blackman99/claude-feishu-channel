# Question Card Button Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep long `ask_user` question text intact while shortening question-card button labels so Feishu buttons stay readable and clickable.

**Architecture:** Implement a display-only label helper inside `src/feishu/cards/question-card.ts` that turns option labels into compact `A. <short text>` button text. Preserve the current card layout and click payloads so the broker still resolves the original full option labels.

**Tech Stack:** TypeScript, Vitest, Feishu card JSON rendering

---

### Task 1: Lock in rendering behavior with failing tests

**Files:**
- Modify: `test/unit/claude/feishu-question-broker.test.ts`
- Read: `src/feishu/cards/question-card.ts`

- [ ] **Step 1: Add a test for long option labels rendering compact prefixed button text**

Append a case near the existing question-card rendering assertions:

```ts
it("renders long option labels as compact prefixed button text", async () => {
  const longQuestion = {
    question: "Which rollout path should we take for the next deployment?",
    options: [
      { label: "Use existing workspace and continue from the latest branch state" },
      { label: "Create a fresh workspace and replay only the verified steps" },
    ],
  };

  const broker = new FeishuQuestionBroker({
    feishu: makeFeishuStub(),
    timeoutMs: 300_000,
    warnBeforeMs: 60_000,
    logger: SILENT_LOGGER,
  });

  await broker.request({
    questions: [longQuestion],
    ownerOpenId: "ou_x",
    parentMessageId: "om_p",
    chatId: "oc_x",
    locale: "en",
  });

  const json = JSON.stringify(lastReplyCardPayload());
  expect(json).toContain("A. Use existing");
  expect(json).toContain("B. Create a fresh");
  expect(json).not.toContain(longQuestion.options[0]!.label);
});
```

- [ ] **Step 2: Add a test that shortened button display still resolves the original label**

Append a case near the existing `resolveByCard` tests:

```ts
it("returns the original full option label after clicking a shortened button", async () => {
  const broker = makeBroker();
  const longLabel = "Use existing workspace and continue from the latest branch state";

  const pending = broker.request({
    questions: [{
      question: "Which rollout path?",
      options: [
        { label: longLabel },
        { label: "Create a fresh workspace" },
      ],
    }],
    ownerOpenId: "ou_x",
    parentMessageId: "om_p",
    chatId: "oc_x",
    locale: "en",
  });

  const requestId = extractQuestionRequestIdFromLastCard();
  await broker.resolveByCard({
    requestId,
    actorOpenId: "ou_x",
    choice: { questionIndex: 0, optionIndex: 0 },
  });

  await expect(pending).resolves.toMatchObject({
    answers: {
      "Which rollout path?": longLabel,
    },
  });
});
```

- [ ] **Step 3: Run the targeted test file and confirm failure**

Run:

```bash
pnpm test test/unit/claude/feishu-question-broker.test.ts
```

Expected:

- FAIL because button text still uses the full option label

---

### Task 2: Implement compact display-only button labels

**Files:**
- Modify: `src/feishu/cards/question-card.ts`
- Test: `test/unit/claude/feishu-question-broker.test.ts`

- [ ] **Step 1: Add a compact display-label helper**

In `src/feishu/cards/question-card.ts`, introduce helpers above `buttonEl(...)`:

```ts
const OPTION_PREFIXES = ["A.", "B.", "C.", "D."] as const;
const BUTTON_LABEL_MAX_CODEPOINTS = 18;

function optionPrefix(optionIndex: number): string {
  return OPTION_PREFIXES[optionIndex] ?? `${optionIndex + 1}.`;
}

function truncateForButton(text: string, maxCodepoints: number): string {
  const glyphs = Array.from(text.trim());
  if (glyphs.length <= maxCodepoints) return text.trim();
  return `${glyphs.slice(0, Math.max(0, maxCodepoints - 3)).join("")}...`;
}

function buttonDisplayLabel(optionIndex: number, originalLabel: string): string {
  const prefix = optionPrefix(optionIndex);
  const short = truncateForButton(originalLabel, BUTTON_LABEL_MAX_CODEPOINTS);
  return `${prefix} ${short}`.trim();
}
```
```

- [ ] **Step 2: Use the compact display label only for rendered button text**

Update the button construction path so `button.text.content` uses the helper while `value.option_index` stays unchanged:

```ts
function buttonEl(
  requestId: string,
  questionIndex: number,
  optionIndex: number,
  label: string,
): FeishuElement {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: buttonDisplayLabel(optionIndex, label),
    },
    type: "default",
    value: {
      kind: "question",
      request_id: requestId,
      question_index: questionIndex,
      option_index: optionIndex,
    },
  };
}
```

- [ ] **Step 3: Keep question body and layout logic unchanged**

Do not change:

- the question markdown body
- `layoutButtons(...)`
- callback payload structure
- resolved card formatting

This task is complete only if the rendering fix is isolated to button display text.

- [ ] **Step 4: Re-run the targeted question-broker tests**

Run:

```bash
pnpm test test/unit/claude/feishu-question-broker.test.ts
```

Expected:

- PASS

---

### Task 3: Regression verification and commit

**Files:**
- Verify: `test/unit/claude/feishu-question-broker.test.ts`
- Verify: `test/unit/commands/dispatcher.test.ts`
- Verify: `src/feishu/cards/question-card.ts`

- [ ] **Step 1: Run adjacent regressions**

Run:

```bash
pnpm test test/unit/claude/feishu-question-broker.test.ts test/unit/commands/dispatcher.test.ts
```

Expected:

- PASS

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected:

- PASS

- [ ] **Step 3: Commit**

```bash
git add src/feishu/cards/question-card.ts test/unit/claude/feishu-question-broker.test.ts docs/superpowers/specs/2026-04-16-question-card-button-overflow-design.md docs/superpowers/plans/2026-04-16-question-card-button-overflow.md
git commit -m "fix: shorten question card button labels"
```

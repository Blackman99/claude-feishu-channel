# Question Card Full Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the full text of long `ask_user` questions in a dedicated card body section while keeping question-card buttons compact and stable.

**Architecture:** Extend `src/feishu/cards/question-card.ts` with a long-question branch that renders a concise prompt line plus a separate full-text markdown block before the option buttons. Keep the recently added compact button labels and preserve broker click semantics and answer values.

**Tech Stack:** TypeScript, Vitest, Feishu card JSON rendering

---

### Task 1: Add failing tests for long-question full-text rendering

**Files:**
- Modify: `test/unit/claude/feishu-question-broker.test.ts`
- Read: `src/feishu/cards/question-card.ts`

- [ ] **Step 1: Add a test that long questions render a dedicated full-text block**

Append a rendering case in `test/unit/claude/feishu-question-broker.test.ts`:

```ts
it("renders a dedicated full-text block for long questions", async () => {
  const f = makeFakeFeishu();
  const broker = makeBroker(f.client, new FakeClock());
  const longQuestionText =
    "Please review the current rollout state, keep the unfinished migration constraints in mind, and choose the safest path to continue without losing validated work.";

  void broker.request({
    questions: [{
      question: longQuestionText,
      options: [
        { label: "Use existing workspace and continue from the latest branch state", description: "" },
        { label: "Create a fresh workspace and replay only the verified steps", description: "" },
      ],
      multiSelect: false,
    }],
    chatId: "oc_x",
    ownerOpenId: "ou_x",
    parentMessageId: "om_p",
    locale: "en",
  });
  await Promise.resolve();
  await Promise.resolve();

  const json = JSON.stringify(f.replyCard.mock.calls[0]![1]);
  expect(json).toContain("Full question below");
  expect(json).toContain(longQuestionText);
  expect(json).toContain("A. Use existing");
});
```

- [ ] **Step 2: Add a test that short questions keep the simpler layout**

Append a short-question regression case:

```ts
it("keeps short questions on the simple one-line layout", async () => {
  const f = makeFakeFeishu();
  const broker = makeBroker(f.client, new FakeClock());

  void broker.request({
    questions: [Q1],
    chatId: "oc_x",
    ownerOpenId: "ou_x",
    parentMessageId: "om_p",
    locale: "en",
  });
  await Promise.resolve();
  await Promise.resolve();

  const json = JSON.stringify(f.replyCard.mock.calls[0]![1]);
  expect(json).toContain("Which editor?");
  expect(json).not.toContain("Full question below");
});
```

- [ ] **Step 3: Run the targeted test file and confirm failure**

Run:

```bash
pnpm test test/unit/claude/feishu-question-broker.test.ts
```

Expected:

- FAIL because long-question cards do not yet render a separate full-text block

---

### Task 2: Implement long-question full-text rendering in the card builder

**Files:**
- Modify: `src/feishu/cards/question-card.ts`
- Test: `test/unit/claude/feishu-question-broker.test.ts`

- [ ] **Step 1: Add a long-question threshold and helpers**

In `src/feishu/cards/question-card.ts`, add helpers near the existing button-label constants:

```ts
const QUESTION_TEXT_MAX = 80;

function isLongQuestion(question: string): boolean {
  return Array.from(question.trim()).length > QUESTION_TEXT_MAX;
}

function questionPromptLine(
  questionIndex: number,
  question: string,
  headerPrefix: string,
): string {
  if (!isLongQuestion(question)) {
    return `${headerPrefix}**Q${questionIndex + 1}.** ${escapeMd(question)}`;
  }
  return `${headerPrefix}**Q${questionIndex + 1}.** Full question below`;
}
```
```

- [ ] **Step 2: Render the full-text block only for long questions**

Update `buildQuestionCard(...)` so each pending question renders like this:

```ts
elements.push({
  tag: "markdown",
  content: questionPromptLine(i, q.question, headerPrefix),
});

if (isLongQuestion(q.question)) {
  elements.push({
    tag: "markdown",
    content: escapeMd(q.question),
  });
}
```

Then leave the answered/pending button branch as-is below that.

- [ ] **Step 3: Keep button compacting and click payloads unchanged**

Do not change:

- compact button label helpers
- `request_id / question_index / option_index`
- broker answer resolution
- resolved/cancelled/timed-out card builders

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
git add src/feishu/cards/question-card.ts test/unit/claude/feishu-question-broker.test.ts docs/superpowers/specs/2026-04-16-question-card-full-text-design.md docs/superpowers/plans/2026-04-16-question-card-full-text.md
git commit -m "fix: show full text for long question cards"
```

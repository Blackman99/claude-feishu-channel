# Proactive Context Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maintain a retained continuation state ahead of context exhaustion so explicitly completed work is pruned before a summarized fresh session becomes necessary.

**Architecture:** Extend `src/claude/session.ts` with a retained-context structure that is updated at turn boundaries, using structured completion state first and explicit completion text second. Use that retained state both during warning-zone pruning and when rendering the summarized-reset continuation payload, while preserving the existing hard fallback path.

**Tech Stack:** TypeScript, Vitest, existing Claude session state machine

---

### Task 1: Lock in proactive pruning behavior with failing tests

**Files:**
- Modify: `test/unit/claude/context-mitigation.test.ts`
- Read: `src/claude/session.ts`

- [ ] **Step 1: Add a test that warning-zone pruning removes explicitly completed structured tasks**

Append a focused case to `test/unit/claude/context-mitigation.test.ts`:

```ts
it("removes explicitly completed structured tasks from retained continuation state", () => {
  const h = createHarness({
    totalInputTokens: 165_000,
    totalOutputTokens: 5_000,
  });

  h.session._testSetRetainedTaskState([
    { title: "Task 1", status: "completed" },
    { title: "Task 2", status: "in_progress" },
    { title: "Task 3", status: "pending" },
  ]);

  h.session._testRefreshRetainedContinuation("Task 2 in progress");

  const summary = h.session._testBuildRetainedContinuationSummary();
  expect(summary).not.toContain("Task 1");
  expect(summary).toContain("Task 2");
  expect(summary).toContain("Task 3");
});
```

- [ ] **Step 2: Add a test that explicit plain-text completion statements prune only when structured state is absent**

Append:

```ts
it("uses explicit completion text as a fallback pruning signal", () => {
  const h = createHarness();

  h.session._testRecordCompletionSignal("Task 4 已完成");
  h.session._testRefreshRetainedContinuation("Task 5 pending");

  const summary = h.session._testBuildRetainedContinuationSummary();
  expect(summary).not.toContain("Task 4");
});
```

- [ ] **Step 3: Add a test that ambiguous progress wording does not delete context**

Append:

```ts
it("does not delete context for ambiguous progress wording", () => {
  const h = createHarness();

  h.session._testRecordCompletionSignal("Task 6 almost done");
  h.session._testRefreshRetainedContinuation("Task 6 still active");

  const summary = h.session._testBuildRetainedContinuationSummary();
  expect(summary).toContain("Task 6");
});
```

- [ ] **Step 4: Run the targeted test file and confirm failure**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:

- FAIL because retained continuation state and proactive pruning helpers do not exist yet

---

### Task 2: Add retained continuation state and pruning rules

**Files:**
- Modify: `src/claude/session.ts`
- Test: `test/unit/claude/context-mitigation.test.ts`

- [ ] **Step 1: Add internal retained-context state**

In `src/claude/session.ts`, add small internal structures near the existing context helpers:

```ts
interface RetainedTaskState {
  title: string;
  status: "pending" | "in_progress" | "completed";
}

interface RetainedContinuationState {
  tasks: RetainedTaskState[];
  completionSignals: string[];
  latestObjective: string;
}
```

Add a private field initialized conservatively:

```ts
private retainedContinuation: RetainedContinuationState = {
  tasks: [],
  completionSignals: [],
  latestObjective: "",
};
```

- [ ] **Step 2: Add explicit pruning helpers**

Add helpers that remove only clearly completed items:

```ts
private pruneCompletedTasks(tasks: RetainedTaskState[]): RetainedTaskState[] {
  return tasks.filter((task) => task.status !== "completed");
}

private isExplicitCompletionSignal(text: string): boolean {
  return /\b(completed?|done)\b|已完成/.test(text);
}
```

Keep the matcher strict enough that `"almost done"` or vague wording does not count.

- [ ] **Step 3: Refresh retained continuation state at stable boundaries**

Add a helper such as:

```ts
private refreshRetainedContinuation(nextObjective: string): void {
  const prunedTasks = this.pruneCompletedTasks(this.retainedContinuation.tasks);
  const explicitSignals = this.retainedContinuation.completionSignals.filter(
    (signal) => this.isExplicitCompletionSignal(signal),
  );

  this.retainedContinuation = {
    tasks: prunedTasks,
    completionSignals: explicitSignals,
    latestObjective: nextObjective,
  };
}
```

Call it:

- after successful turn completion
- during warning-zone handling before hard fallback logic is needed

- [ ] **Step 4: Render continuation summaries from retained state**

Replace the fixed-only summary rendering path with retained-state rendering:

```ts
private buildContinuationSummary(next: QueuedInput): string {
  this.refreshRetainedContinuation(this.immediateRequestSummary(next));

  const activeTasks = this.retainedContinuation.tasks
    .map((task) => `- ${task.title} [${task.status}]`)
    .join("\n");

  return [
    "Continuation summary:",
    "",
    "Completed items removed from continuation context.",
    `Current objective: ${this.retainedContinuation.latestObjective}`,
    activeTasks,
  ]
    .filter(Boolean)
    .join("\n");
}
```

Keep provider/model/cwd/permission-mode lines if they already exist; the change is to source task context from retained state rather than raw template text alone.

- [ ] **Step 5: Add focused test seams**

Expose minimal seams for the new tests:

```ts
_testSetRetainedTaskState(tasks: RetainedTaskState[]): void { ... }
_testRecordCompletionSignal(text: string): void { ... }
_testRefreshRetainedContinuation(nextObjective: string): void { ... }
_testBuildRetainedContinuationSummary(): string { ... }
```

- [ ] **Step 6: Re-run the targeted context-mitigation tests**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:

- PASS

---

### Task 3: Preserve existing hard fallback behavior and verify regressions

**Files:**
- Modify: `src/claude/session.ts`
- Verify: `test/unit/claude/context-mitigation.test.ts`
- Verify: `test/unit/claude/session-state-machine.test.ts`

- [ ] **Step 1: Ensure hard fallback retry consumes retained continuation state**

Keep the existing hard-fallback retry branch, but make sure it uses the retained state rather than recreating summary content from raw prompt text.

Do not remove:

- warning path
- compact path
- hard `context_reset` fallback path

- [ ] **Step 2: Run adjacent regressions**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts test/unit/claude/session-state-machine.test.ts
```

Expected:

- PASS

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected:

- PASS

- [ ] **Step 4: Commit**

```bash
git add src/claude/session.ts test/unit/claude/context-mitigation.test.ts docs/superpowers/specs/2026-04-16-proactive-context-pruning-design.md docs/superpowers/plans/2026-04-16-proactive-context-pruning.md
git commit -m "feat: prune completed work from continuation context"
```

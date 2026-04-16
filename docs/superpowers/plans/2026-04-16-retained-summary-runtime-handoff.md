# Retained Summary Runtime Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce routine token consumption by switching compact, summarized-reset, and hard-fallback handoff paths from raw provider history to retained-summary-based continuation payloads.

**Architecture:** Keep normal/warn behavior mostly intact, but add explicit handoff builders in `src/claude/session.ts` that can compose retained summary, optional bounded recent context, and the current request. Compact will branch into low-risk and high-risk handoff modes, and hard fallback retry will reuse the same summary-based payload instead of retrying the raw prompt alone.

**Tech Stack:** TypeScript, Vitest, existing Claude session state machine and context-mitigation tests

---

### Task 1: Add failing tests for summary-based handoff

**Files:**
- Modify: `test/unit/claude/context-mitigation.test.ts`
- Read: `src/claude/session.ts`

- [ ] **Step 1: Add a test that warning still keeps `resumeId`**

Append a focused case:

```ts
it("keeps resumeId in warning zone while continuing to use the provider thread", async () => {
  const h = createHarness({
    providerSessionId: "ses_warn",
    totalInputTokens: 165_000,
    totalOutputTokens: 2_000,
  });

  const outcome = await h.session.submit(runInput("warn me"), h.emit);
  if (outcome.kind !== "started") throw new Error("unreachable");
  await flushMicrotasks();

  expect(h.queryCalls[0]!.options.resumeId).toBe("ses_warn");
});
```

- [ ] **Step 2: Add a test that compact low-risk handoff uses retained summary plus recent context**

Append:

```ts
it("uses retained summary plus bounded recent context for lower-risk compact handoff", async () => {
  const h = createHarness({
    providerSessionId: "ses_compact",
    totalInputTokens: 181_000,
    totalOutputTokens: 1_000,
  });

  h.session._testSetRetainedTaskState([
    { title: "Task 2", status: "in_progress" },
  ]);
  h.session._testRecordRecentContext("User: previous request");
  h.session._testRecordRecentContext("Assistant: previous answer");

  const outcome = await h.session.submit(runInput("continue work"), h.emit);
  if (outcome.kind !== "started") throw new Error("unreachable");
  await flushMicrotasks();

  expect(h.queryCalls[0]!.options.resumeId).toBeUndefined();
  expect(h.events).toContainEqual({ type: "context_compacting" });
  expect(typeof h.queryCalls[0]!.prompt).toBe("string");
  expect(h.queryCalls[0]!.prompt).toContain("Continuation summary for resumed work:");
  expect(h.queryCalls[0]!.prompt).toContain("Recent context:");
});
```

- [ ] **Step 3: Add a test that summarized reset and hard fallback reuse retained-summary handoff**

Append:

```ts
it("uses retained-summary handoff for hard fallback retry", async () => {
  const h = createHarness({
    providerSessionId: "ses_backend_limit",
    firstRunError: new Error("Request too large: max 20MB"),
  });

  h.session._testSetRetainedTaskState([
    { title: "Task 5", status: "in_progress" },
  ]);

  const outcome = await h.session.submit(runInput("retry me"), h.emit);
  if (outcome.kind !== "started") throw new Error("unreachable");
  await flushMicrotasks();

  h.fakes[0]!.finishWithSuccess({ durationMs: 1, inputTokens: 1, outputTokens: 1 });
  await outcome.done;

  expect(h.queryCalls).toHaveLength(2);
  expect(typeof h.queryCalls[1]!.prompt).toBe("string");
  expect(h.queryCalls[1]!.prompt).toContain("Continuation summary for resumed work:");
});
```

- [ ] **Step 4: Run the targeted test file and confirm failure**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:

- FAIL because summary-based compact/fallback handoff builders do not exist yet

---

### Task 2: Implement retained-summary handoff builders

**Files:**
- Modify: `src/claude/session.ts`
- Test: `test/unit/claude/context-mitigation.test.ts`

- [ ] **Step 1: Add recent-context storage and budget helpers**

In `src/claude/session.ts`, add bounded recent-context support:

```ts
private recentContext: string[] = [];

private recordRecentContext(entry: string): void {
  this.recentContext.push(entry);
  this.recentContext = this.recentContext.slice(-4);
}

private recentContextSlice(maxChars = 1000): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const entry of [...this.recentContext].reverse()) {
    if (used + entry.length > maxChars) break;
    kept.unshift(entry);
    used += entry.length;
  }
  return kept;
}
```

- [ ] **Step 2: Add summary-based handoff payload builders**

Add:

```ts
private buildRuntimeHandoffPrompt(args: {
  next: QueuedInput;
  includeRecentContext: boolean;
}): string {
  this.refreshRetainedContinuation(this.immediateRequestSummary(args.next));

  const sections = [
    "Continuation summary for resumed work:",
    this.buildRetainedContinuationSummary(),
  ];

  const recent = args.includeRecentContext ? this.recentContextSlice() : [];
  if (recent.length > 0) {
    sections.push("", "Recent context:", ...recent);
  }

  sections.push("", "User request:", this.immediateRequestSummary(args.next));
  return sections.join("\n");
}
```

- [ ] **Step 3: Use summary-based handoff in compact and summarized-reset branches**

In `processLoop()`:

- keep warning path unchanged
- on compact, clear `resumeId` and replace `effectivePrompt` with a summary-based prompt
- lower-risk compact includes recent context
- summarized reset uses summary-based prompt without recent raw context

Suggested shape:

```ts
if (assessment.level === "compact" && this.claudeSessionId !== undefined) {
  this.claudeSessionId = undefined;
  await next.emit({ type: "context_compacting" });
  effectivePrompt = this.buildRuntimeHandoffPrompt({
    next,
    includeRecentContext: true,
  });
}

if (assessment.level === "summarize_reset") {
  this.claudeSessionId = undefined;
  await next.emit({ type: "context_summarized_reset" });
  effectivePrompt = this.buildRuntimeHandoffPrompt({
    next,
    includeRecentContext: false,
  });
}
```

- [ ] **Step 4: Use summary-based handoff in hard fallback retry**

Replace the retry prompt from raw `prompt` to:

```ts
const retryPrompt = this.buildRuntimeHandoffPrompt({
  next,
  includeRecentContext: false,
});
```

Then pass `retryPrompt` into the retry `queryFn(...)`.

- [ ] **Step 5: Record recent context at stable turn boundaries**

At turn completion, append a compact recent-context entry such as:

```ts
this.recordRecentContext(`User: ${this.immediateRequestSummary(input)}`);
```

Optionally append a short assistant result marker if needed, but keep it bounded and avoid replaying full assistant text.

- [ ] **Step 6: Add focused test seams**

Expose:

```ts
_testRecordRecentContext(entry: string): void { ... }
```

- [ ] **Step 7: Re-run the targeted context-mitigation tests**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:

- PASS

---

### Task 3: Verify regressions and finalize

**Files:**
- Verify: `test/unit/claude/context-mitigation.test.ts`
- Verify: `test/unit/claude/session-state-machine.test.ts`
- Modify: `src/claude/session.ts` only if regression fixes are required

- [ ] **Step 1: Run adjacent regressions**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts test/unit/claude/session-state-machine.test.ts
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
git add src/claude/session.ts test/unit/claude/context-mitigation.test.ts docs/superpowers/specs/2026-04-16-retained-summary-runtime-handoff-design.md docs/superpowers/plans/2026-04-16-retained-summary-runtime-handoff.md
git commit -m "feat: use retained summaries for context handoff"
```

# Context Growth Mitigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proactive context-growth warnings and staged 20MB mitigation so oversized sessions warn early, compact first, and only reset into a fresh summarized session when necessary.

**Architecture:** Keep the control loop inside `src/claude/session.ts`, because that is where queueing, retries, provider resume IDs, and render events already live. Add a pre-turn context assessment that combines token trend and byte estimation, then layer three mitigations in order: warn, compact, summarize-and-new-session, while preserving the existing backend-error reset as the last fallback.

**Tech Stack:** TypeScript, Node.js, Vitest, existing Claude/Codex provider adapters, Feishu render events

---

## File Structure

**Create:**
- `test/unit/claude/context-mitigation.test.ts` - focused coverage for pre-turn warning, compact, summarize-reset, and hard 20MB fallback behavior

**Modify:**
- `src/claude/session.ts` - add context assessment, mitigation state, continuation summary generation, and staged retry flow
- `src/claude/query-handle.ts` - widen provider run options only if the mitigation implementation needs explicit compact/summarize hints
- `src/commands/dispatcher.ts` - update `/context` output to explain staged mitigation behavior
- `src/util/i18n.ts` - add warning / compact / summarized-reset / updated context copy in zh and en
- `test/unit/claude/session-state-machine.test.ts` - retain compatibility coverage around existing reset-and-retry behavior
- `test/unit/commands/dispatcher.test.ts` - verify `/context` user-facing copy reflects staged mitigation

---

### Task 1: Add Context Assessment Helpers

**Files:**
- Modify: `src/claude/session.ts`
- Create: `test/unit/claude/context-mitigation.test.ts`

- [ ] **Step 1: Write the failing assessment tests**

Add `describe("ClaudeSession context assessment", ...)` in `test/unit/claude/context-mitigation.test.ts` with cases for:

```ts
it("classifies normal usage below warning thresholds", async () => {
  const h = createHarness({
    totalInputTokens: 20_000,
    totalOutputTokens: 2_000,
  });
  expect(
    h.session._testAssessContextRisk("small prompt"),
  ).toMatchObject({
    level: "normal",
  });
});

it("classifies warning when token usage is high but reset is not required", async () => {
  const h = createHarness({
    model: "claude-opus-4-6",
    totalInputTokens: 160_000,
    totalOutputTokens: 4_000,
  });
  expect(
    h.session._testAssessContextRisk("follow-up prompt"),
  ).toMatchObject({
    level: "warn",
  });
});

it("classifies summarize_reset when estimated bytes are above the hard threshold", async () => {
  const huge = "x".repeat(19_000_000);
  const h = createHarness();
  expect(
    h.session._testAssessContextRisk(huge),
  ).toMatchObject({
    level: "summarize_reset",
  });
});
```

- [ ] **Step 2: Run the new test file to confirm missing helpers fail**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:
- FAIL with missing `_testAssessContextRisk` and mitigation helpers

- [ ] **Step 3: Implement minimal assessment types and helper logic**

In `src/claude/session.ts`, add explicit internal shapes near the existing status types:

```ts
type ContextRiskLevel = "normal" | "warn" | "compact" | "summarize_reset";

interface ContextAssessment {
  level: ContextRiskLevel;
  tokenUsage: number;
  tokenWindow: number;
  estimatedBytes: number;
}
```

Add minimal helpers:

```ts
private estimatePromptBytes(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}

private contextWindowFor(model: string): number {
  if (/opus|gpt-5-codex/i.test(model)) return 200_000;
  if (/sonnet/i.test(model)) return 200_000;
  return 128_000;
}

private assessContextRisk(prompt: string): ContextAssessment {
  const tokenUsage = this.totalInputTokens + this.totalOutputTokens;
  const tokenWindow = this.contextWindowFor(
    this.modelOverride ?? this.config.defaultModel,
  );
  const estimatedBytes = this.estimatePromptBytes(prompt);

  if (estimatedBytes >= 18_000_000) {
    return { level: "summarize_reset", tokenUsage, tokenWindow, estimatedBytes };
  }
  if (tokenUsage / tokenWindow >= 0.9) {
    return { level: "compact", tokenUsage, tokenWindow, estimatedBytes };
  }
  if (tokenUsage / tokenWindow >= 0.8 || estimatedBytes >= 12_000_000) {
    return { level: "warn", tokenUsage, tokenWindow, estimatedBytes };
  }
  return { level: "normal", tokenUsage, tokenWindow, estimatedBytes };
}
```

Expose a narrow test seam:

```ts
_testAssessContextRisk(prompt: string): ContextAssessment {
  return this.assessContextRisk(prompt);
}
```

- [ ] **Step 4: Re-run the targeted assessment tests**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:
- PASS for the new assessment cases

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts test/unit/claude/context-mitigation.test.ts
git commit -m "feat: add context risk assessment helpers"
```

---

### Task 2: Add Warning and Compact Paths Before Provider Execution

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `src/util/i18n.ts`
- Create: `test/unit/claude/context-mitigation.test.ts`

- [ ] **Step 1: Write failing tests for warn and compact event emission**

Extend `test/unit/claude/context-mitigation.test.ts` with:

```ts
it("emits a context warning before running a high-usage turn", async () => {
  const h = createHarness({
    totalInputTokens: 165_000,
    totalOutputTokens: 2_000,
  });

  const outcome = await h.session.submit(runInput("warn me"), h.emit);
  if (outcome.kind === "rejected") throw new Error(outcome.reason);
  await outcome.done;

  expect(h.events).toContainEqual({
    type: "context_warning",
    level: "warn",
  });
});

it("drops providerSessionId and retries on the same turn when compact is required", async () => {
  const h = createHarness({
    totalInputTokens: 190_000,
    totalOutputTokens: 2_000,
    providerSessionId: "ses_old",
  });

  const outcome = await h.session.submit(runInput("compact me"), h.emit);
  if (outcome.kind === "rejected") throw new Error(outcome.reason);
  await outcome.done;

  expect(h.queryCalls).toHaveLength(2);
  expect(h.events).toContainEqual({ type: "context_compacting" });
  expect(h.queryCalls[0]?.options.resumeId).toBe("ses_old");
  expect(h.queryCalls[1]?.options.resumeId).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused tests to verify missing events/flow**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:
- FAIL because `context_warning` / `context_compacting` and the pre-turn compact retry path do not exist yet

- [ ] **Step 3: Implement warn and compact handling in `processLoop()`**

In `src/claude/session.ts`, immediately before the initial `queryFn(...)` call in `processLoop()`, add:

```ts
const promptText = typeof prompt === "string" ? prompt : await this.promptPreview(prompt);
const assessment = this.assessContextRisk(promptText);

if (assessment.level === "warn") {
  await next.emit({ type: "context_warning", level: "warn" });
}

if (assessment.level === "compact" && this.claudeSessionId !== undefined) {
  this.logger.warn(
    { seq: next.seq, old_session_id: this.claudeSessionId, assessment },
    "Context approaching limit — compacting before provider call",
  );
  this.claudeSessionId = undefined;
  await next.emit({ type: "context_compacting" });
}
```

Add a helper to obtain preview text without changing existing prompt construction:

```ts
private async promptPreview(prompt: string | AsyncIterable<SDKUserMessage>): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const blocks: string[] = [];
  for await (const msg of prompt) {
    for (const block of msg.message.content) {
      if (block.type === "text") blocks.push(block.text);
      if (block.type === "image") blocks.push("[image]");
    }
  }
  return blocks.join("\n");
}
```

Add localization keys for:

```ts
contextWarningRuntime: "⚠️ 当前会话上下文已接近上限，系统会优先尝试压缩后继续。"
contextCompacting: "🗜️ 当前会话上下文过大，系统正在先尝试压缩并继续本轮请求。"
```

- [ ] **Step 4: Re-run the focused mitigation tests**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:
- PASS for warn and compact behavior

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts src/util/i18n.ts test/unit/claude/context-mitigation.test.ts
git commit -m "feat: add staged warning and compact mitigation"
```

---

### Task 3: Add Summarize-and-New-Session Retry

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `src/util/i18n.ts`
- Create: `test/unit/claude/context-mitigation.test.ts`

- [ ] **Step 1: Write failing tests for summarized fresh-session retry**

Add:

```ts
it("starts a fresh summarized session when context risk requires summarize_reset", async () => {
  const huge = "x".repeat(19_000_000);
  const h = createHarness({
    providerSessionId: "ses_old",
    model: "claude-opus-4-6",
    totalInputTokens: 195_000,
    totalOutputTokens: 3_000,
  });

  const outcome = await h.session.submit(runInput(huge), h.emit);
  if (outcome.kind === "rejected") throw new Error(outcome.reason);
  await outcome.done;

  expect(h.events).toContainEqual({ type: "context_summarized_reset" });
  expect(h.queryCalls).toHaveLength(1);
  expect(h.queryCalls[0]?.options.resumeId).toBeUndefined();
  expect(h.queryCalls[0]?.prompt).toMatchObject(expect.anything());
  expect(h.session.getStatus().providerSessionId).toBeUndefined();
});

it("preserves provider/model/cwd/permission mode across summarized reset", async () => {
  const h = createHarness({
    provider: "codex",
    providerSessionId: "thread_old",
    model: "gpt-5-codex",
    cwd: "/tmp/project",
    permissionMode: "plan",
  });
  const summary = h.session._testBuildContinuationSummary("next task");
  expect(summary).toContain("Current objective");
  expect(summary).toContain("gpt-5-codex");
  expect(summary).toContain("/tmp/project");
});
```

- [ ] **Step 2: Run the new tests to confirm missing summary/reset behavior**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:
- FAIL because summarize-reset flow and continuation summary helpers do not exist

- [ ] **Step 3: Implement continuation summary and summarized retry**

In `src/claude/session.ts`, add a helper:

```ts
private buildContinuationSummary(nextInput: string): string {
  const status = this.getStatus();
  return [
    "Continuation summary for a fresh session:",
    `- Provider: ${status.provider}`,
    `- Model: ${status.model}`,
    `- Working directory: ${status.cwd}`,
    `- Permission mode: ${status.permissionMode}`,
    `- Prior token totals: in=${status.totalInputTokens}, out=${status.totalOutputTokens}`,
    "- Keep unfinished work and explicit user constraints from the prior session.",
    `- Immediate next request: ${nextInput.slice(0, 4_000)}`,
  ].join("\n");
}
```

Add a test seam:

```ts
_testBuildContinuationSummary(nextInput: string): string {
  return this.buildContinuationSummary(nextInput);
}
```

In `processLoop()`, add a branch before the first provider call:

```ts
let effectivePrompt = prompt;
if (assessment.level === "summarize_reset") {
  this.logger.warn({ seq: next.seq, assessment }, "Context requires summarized fresh session");
  this.claudeSessionId = undefined;
  await next.emit({ type: "context_summarized_reset" });
  effectivePrompt = `${this.buildContinuationSummary(promptText)}\n\nUser request:\n${promptText}`;
}
```

Use `effectivePrompt` for the subsequent `queryFn(...)` invocation.

Add localization keys:

```ts
contextSummarizedReset:
  "⚠️ 当前会话上下文已过大，系统已提炼未完成内容并切到新会话后继续本轮请求。"
```

- [ ] **Step 4: Re-run the summarized reset tests**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts
```

Expected:
- PASS for summarized reset and continuation summary

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts src/util/i18n.ts test/unit/claude/context-mitigation.test.ts
git commit -m "feat: add summarized fresh-session retry for large context"
```

---

### Task 4: Preserve and Clarify the Existing Hard 20MB Fallback

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `test/unit/claude/session-state-machine.test.ts`
- Modify: `test/unit/claude/context-mitigation.test.ts`

- [ ] **Step 1: Write failing tests that keep the old backend-failure fallback alive**

Add a focused case in `test/unit/claude/context-mitigation.test.ts`:

```ts
it("still performs the existing reset-and-retry when backend size detection misses", async () => {
  const h = createHarness({
    providerSessionId: "ses_backend_limit",
    firstRunError: new Error("Request too large: max 20MB"),
  });

  const outcome = await h.session.submit(runInput("retry me"), h.emit);
  if (outcome.kind === "rejected") throw new Error(outcome.reason);
  await outcome.done;

  expect(h.events).toContainEqual({ type: "context_reset" });
  expect(h.queryCalls).toHaveLength(2);
  expect(h.queryCalls[0]?.options.resumeId).toBe("ses_backend_limit");
  expect(h.queryCalls[1]?.options.resumeId).toBeUndefined();
});
```

- [ ] **Step 2: Run the targeted tests and verify current behavior still holds**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts test/unit/claude/session-state-machine.test.ts
```

Expected:
- Either PASS already, or FAIL if the new staged flow accidentally broke the old fallback

- [ ] **Step 3: Keep the old fallback explicit after the staged logic**

In `src/claude/session.ts`, keep this shape intact:

```ts
if (this.isRequestTooLargeError(err) && previousResumeId !== undefined) {
  this.claudeSessionId = undefined;
  await next.emit({ type: "context_reset" });
  // retry once without resume
}
```

The staged logic must not remove or rename this hard fallback path. If the earlier mitigation already cleared the session id, the old fallback should naturally no-op rather than double-reset.

- [ ] **Step 4: Re-run the fallback regression tests**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts test/unit/claude/session-state-machine.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add src/claude/session.ts test/unit/claude/context-mitigation.test.ts test/unit/claude/session-state-machine.test.ts
git commit -m "test: preserve hard 20mb fallback after staged mitigation"
```

---

### Task 5: Update `/context` Messaging and Run Regression Verification

**Files:**
- Modify: `src/commands/dispatcher.ts`
- Modify: `src/util/i18n.ts`
- Modify: `test/unit/commands/dispatcher.test.ts`
- Create: `test/unit/claude/context-mitigation.test.ts`

- [ ] **Step 1: Write failing `/context` copy tests**

Update `test/unit/commands/dispatcher.test.ts`:

```ts
it("explains staged mitigation in /context output", async () => {
  await dispatcher.dispatch({ name: "context" }, CTX);
  const text = replies.at(-1)?.text ?? "";
  expect(text).toContain("warn");
  expect(text).toContain("compact");
  expect(text).toContain("new session");
});
```

For zh locale, assert the equivalent localized copy.

- [ ] **Step 2: Run the command test to confirm the old copy fails**

Run:

```bash
pnpm test test/unit/commands/dispatcher.test.ts
```

Expected:
- FAIL because `/context` still only suggests `/new`

- [ ] **Step 3: Update `/context` output and final strings**

In `src/commands/dispatcher.ts`, update the `/context` branch:

```ts
if (used / windowSize > 0.8) {
  lines.push(
    "",
    s.contextWarning,
    s.contextStages,
  );
}
```

Add i18n strings:

```ts
contextStages:
  "Mitigation order: warn -> compact -> summarized new session -> hard reset fallback"
```

Chinese equivalent:

```ts
contextStages:
  "系统处理顺序：预警 -> 压缩 -> 提炼后新会话 -> 最后兜底重置"
```

- [ ] **Step 4: Run the final regression suite**

Run:

```bash
pnpm test test/unit/claude/context-mitigation.test.ts test/unit/claude/session-state-machine.test.ts test/unit/commands/dispatcher.test.ts test/unit/claude/session-manager.test.ts
pnpm typecheck
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/dispatcher.ts src/util/i18n.ts test/unit/commands/dispatcher.test.ts test/unit/claude/context-mitigation.test.ts
git commit -m "docs: explain staged context mitigation behavior"
```

---

## Final Verification Checklist

- [ ] High token usage can produce a warning before provider execution
- [ ] Near-limit sessions can clear `providerSessionId` and retry as a compact-first mitigation
- [ ] Very large turns start a fresh session with a continuation summary instead of a blank reset
- [ ] Continuation summaries preserve provider/model/cwd/permission mode
- [ ] Existing backend `Request too large` / `max 20MB` fallback still works
- [ ] `/context` output explains the staged mitigation flow
- [ ] `pnpm test test/unit/claude/context-mitigation.test.ts test/unit/claude/session-state-machine.test.ts test/unit/commands/dispatcher.test.ts test/unit/claude/session-manager.test.ts`
- [ ] `pnpm typecheck`

---

## Self-Review

**Spec coverage**
- Covered risk assessment, warn/compact/summarize-reset stages, continuation summary contents, hard fallback preservation, and `/context` messaging updates.
- No spec requirement was left without a corresponding task.

**Placeholder scan**
- No `TBD`, `TODO`, or “implement later” placeholders remain.
- Each task has explicit file paths, code snippets, and verification commands.

**Type consistency**
- The plan consistently uses `providerSessionId`, `ContextAssessment`, `ContextRiskLevel`, and existing `SessionStatus` names.
- The staged mitigation continues to sit inside `ClaudeSession` rather than introducing a conflicting runtime entry point.

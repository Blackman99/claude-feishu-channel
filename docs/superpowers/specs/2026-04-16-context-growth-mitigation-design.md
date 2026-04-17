# Context Growth Mitigation Design

- **Date**: 2026-04-16
- **Status**: Draft
- **Author**: zhaodongsheng x Codex
- **Upstream context**: current Claude/Codex provider runtime in `src/claude/session.ts`, `/context` command in `src/commands/dispatcher.ts`, existing 50MB fallback reset path
- **Downstream output**: implementation plan for proactive context warnings and staged mitigation before hard 50MB failures

---

## 1. Goal

Add proactive context-growth mitigation so the bot warns early, attempts a lighter-weight mitigation first, and only starts a fresh session after preserving the minimum necessary context.

This work is driven by a real failure mode in the current runtime:

- the same provider session is resumed repeatedly
- context accumulates until the backend rejects the request with a `Request too large` / `max 50MB` error
- only then does the runtime clear the provider session and retry once

That fallback remains necessary, but it should become the last line of defense instead of the primary control path.

**Success criteria**

1. The bot can warn before a turn is likely to hit the hard 50MB request-size error.
2. The bot uses both token-based trend detection and byte-based preflight estimation.
3. High-risk turns first attempt compaction before abandoning the current provider thread.
4. If a fresh session is required, the new session starts with a compact continuation summary rather than a blank reset.
5. The continuation summary keeps unfinished work and relevant constraints while dropping confirmed-complete history.
6. Existing hard-failure fallback remains in place if prediction misses.

**Non-goals**

1. Perfectly predicting the backend’s real serialized request size.
2. Building a general-purpose long-term memory system.
3. Replacing provider-native auto-compact behavior.
4. Making Claude and Codex byte accounting identical.

---

## 2. Product Decisions

### 2.1 Trigger model

The mitigation pipeline uses two signals:

- **token usage trend** from the existing session counters and `/context` model-window estimate
- **request byte estimate** computed immediately before sending a turn

Token usage is used for earlier warning and trend tracking. Byte estimation is used for the final pre-send risk check because the actual user-reported failure is tied to the 50MB request limit rather than model context size alone.

### 2.2 Mitigation order

The mitigation order is fixed:

1. warn
2. auto-compact
3. summarize-and-new-session
4. existing backend-error fallback

This preserves as much live thread state as possible before escalating.

### 2.3 Fresh-session behavior

A fresh session must not discard everything. When the system decides the current provider thread is too large to continue safely, it should derive a short continuation payload from the current conversation state and prepend that payload to the retried turn.

The payload should preserve:

- current unfinished task or objective
- explicit user constraints and preferences
- key implementation state already achieved
- open risks, blockers, and pending validations
- any immediate next-step instruction needed for the current turn

The payload should remove:

- completed work that no longer influences the next step
- duplicated status updates
- stale reasoning superseded by a later conclusion
- low-signal process chatter

### 2.4 User-visible behavior

The user should be able to distinguish these situations:

- **warning**: the current session is growing large
- **compact**: the system attempted to keep the current thread alive
- **continuation reset**: the system started a fresh thread with a condensed continuation summary
- **hard fallback reset**: the backend still rejected the request and the old emergency path was used

The goal is transparency without turning the chat into a diagnostics stream.

---

## 3. Architecture

### 3.1 Current behavior

Current behavior lives almost entirely inside `src/claude/session.ts`:

- each turn reuses `providerSessionId` when present
- `autoCompactThreshold` is passed through to provider runtimes
- if the provider throws a `Request too large` / `max 50MB` error, the session drops `providerSessionId`, emits `context_reset`, and retries the same input once

This means mitigation only happens after failure, and the fresh retry has no preserved continuation state.

### 3.2 Proposed control points

This feature should add two new control points:

1. **pre-turn risk assessment**
   performed before opening a provider run handle
2. **continuation summary generation**
   performed only when the turn is too risky to continue even after compaction

The control flow remains inside the session state machine so that queueing, retries, and persistence stay centralized.

### 3.3 New internal concepts

Recommended internal concepts:

- `ContextRiskLevel`
  - `normal`
  - `warn`
- `ContextAssessment`
  - token usage
  - token percentage
  - estimated request bytes
  - chosen mitigation level
- `ContinuationSummary`
  - compact string payload used to seed a hard fallback retry

These do not need to become public APIs, but they should be explicit in code and tests rather than buried in inline conditionals.

---

## 4. Risk Assessment Design

### 4.1 Token-based assessment

Reuse the existing `/context` model-window estimate as an early trend signal.

Behavior:

- keep `/context` as a user-facing diagnostic
- introduce an internal warning threshold below the hard reset threshold
- use model-specific token windows exactly as today for trend reporting

This is intentionally approximate; it is not the sole source of truth.

### 4.2 Byte-based assessment

Immediately before sending a turn, estimate the UTF-8 byte size of the request payload that is about to be handed to the provider runtime.

The estimate should include at least:

- current user input text
- image placeholder text if the adapter cannot forward binary content directly
- continuation summary text if present
- any provider-visible system/user prefixing introduced by the session

The byte estimate does not need to match the provider’s internal serialization exactly. It only needs to be directionally useful and conservative enough to prevent obvious misses.

### 4.3 Thresholding

Thresholds are staged rather than binary:

- **warn threshold**
  token-based and/or byte-based early warning
- **compact threshold**
  attempt to stay on the same provider thread
- **summarize-reset threshold**
  stop trying to reuse the current thread and start a fresh one with condensed continuation state

The exact numbers are implementation details, but the thresholds must be ordered and testable.

---

## 5. Continuation Summary Design

### 5.1 Summary contents

The continuation summary is a synthesized text block injected into the first turn of the new provider thread.

Recommended sections:

- current objective
- confirmed constraints
- completed state that still matters
- unfinished work
- pending validation
- immediate next request

This structure keeps the summary stable and makes test assertions easier.

### 5.2 Data sources

The first implementation should build the continuation summary from local session-visible state, not from a second model call.

Acceptable sources for phase one:

- current queued input
- session status
- already-rendered assistant text fragments from the active turn if available
- explicit internal retry metadata

This is intentionally a heuristic summary, not a semantic distillation service.

### 5.3 Persistence interaction

Switching to a fresh provider session should preserve the same chat-local settings:

- provider
- model
- cwd
- permission mode

Only the provider-native session/thread identifier should reset.

---

## 6. Command and Messaging Impact

### 6.1 `/context`

`/context` should remain a quick diagnostic command, but its messaging should align with the new staged behavior.

Instead of only saying “use `/new`”, it should mention that the bot may:

- warn
- compact automatically
- start a summarized fresh session if needed

### 6.2 New render events

The session layer likely needs new render events or clearer reuse of existing ones for:

- context warning
- auto compact attempt
- summarized session reset

The existing `context_reset` event should remain for the hard backend-failure fallback unless implementation proves a cleaner naming split is worth the churn.

### 6.3 Localization

New user-visible strings must be added in both Chinese and English.

Messages should be short and operational:

- what happened
- whether the current thread was preserved or replaced
- whether the current message is still being retried

---

## 7. Testing Strategy

This feature should be driven primarily through session-state tests.

Required coverage:

1. warning-only path
2. compact path before provider call
3. summarize-reset path before provider call
4. hard backend 50MB failure still triggers old reset-and-retry fallback
5. summarized fresh session preserves provider/model/cwd/permission mode
6. `/context` text reflects the new staged behavior

Important edge cases:

- no `providerSessionId` yet, but the first turn is already large
- a compact attempt still leads to summarize-reset
- summarize-reset retry also fails
- Codex and Claude share the staged logic even if provider internals differ

---

## 8. Risks and Limits

### 8.1 Heuristic summary quality

Without a second summarization model pass, the continuation summary will be heuristic and imperfect. That is acceptable for phase one as long as it reliably preserves unfinished work and constraints.

### 8.2 Provider differences

Claude and Codex may serialize prompts differently. The byte estimate is therefore a shared approximation, not a provider-exact guarantee.

### 8.3 Existing provider auto-compact

The runtime already passes `autoCompactThreshold` into providers. This design layers local control on top of that behavior. Implementation should avoid creating loops where both the provider and the session keep trying to mitigate repeatedly without escalation.

---

## 9. Recommended Scope for the First Implementation

The first implementation should do exactly this:

1. add pre-turn context assessment
2. add staged thresholds
3. add continuation summary generation without a second model call
4. add user-facing status messages for warn/compact/summarize-reset
5. preserve existing `Request too large` fallback

It should not attempt:

1. provider-specific byte accounting
2. semantic summarization via another AI call
3. broad command-surface expansion
4. long-term memory features

This keeps the feature focused on preventing 50MB failures while preserving useful conversational continuity.

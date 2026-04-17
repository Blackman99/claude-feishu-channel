# Retained Summary Runtime Handoff Design

- **Date**: 2026-04-16
- **Author**: zhaodongsheng x Codex
- **Upstream context**: existing staged context mitigation in `src/claude/session.ts`, retained continuation pruning, and hard 50MB fallback retry
- **Downstream output**: implementation plan for reducing routine token consumption by switching runtime handoff from raw provider history to retained summaries once risk increases

## 1. Goal

Make proactive context pruning reduce **actual routine token consumption**, not just the size of the eventual fallback-retry payload.

The target behavior is:

1. normal turns may keep using the provider's historical thread
2. warning turns build and strengthen retained summary state
3. compact and higher-risk paths stop relying on raw historical thread alone
4. compact and hard fallback retries all reuse retained summary plus the current request, instead of replaying a bloated raw context

## 2. Scope

In scope:

- runtime handoff rules between `resumeId` and retained-summary-based continuation
- graded compact behavior
- reuse of retained summary in hard fallback retry
- bounded carry-forward of recent raw context during lower-risk compact

Out of scope:

- changing permission broker behavior
- replacing provider-native thread resume entirely in the normal case
- second-pass model summarization
- non-session external memory systems

## 3. Current Problem

The current implementation now maintains a retained continuation summary and can prune explicitly completed work. However, the normal request path still does this for most turns:

- send current prompt
- include `resumeId`
- let the provider carry the full prior thread

That means:

1. completed work may be removed from local retained state but still remain in the provider-side historical thread
2. routine turns still pay token cost for historical context until the system leaves raw provider-thread resume
3. the hard backend fallback retry still rebuilds a fresh request from the raw prompt rather than from retained summary state

So current pruning improves the eventual summary, but does not yet significantly reduce day-to-day token use.

## 4. Desired Runtime Strategy

### 4.1 Normal zone

Behavior:

- continue using provider `resumeId`
- continue updating retained summary lightly

Reason:

- lowest churn
- preserves maximum continuity when context is still healthy

### 4.2 Warning zone

Behavior:

- still continue the provider thread
- strengthen retained summary aggressively
- prune explicitly completed work earlier

Reason:

- prepare for future handoff before the context becomes dangerously large

### 4.3 Compact zone

Behavior changes here:

- do not just clear `resumeId` and send the raw current request
- build a compact continuation payload from:
  - retained summary
  - optionally a bounded slice of recent raw context
  - current request

This is where retained summary starts affecting real token usage.

### 4.4 Hard fallback reset zone

Behavior:

- start a fresh provider session
- always use retained summary plus current request
- do not reconstruct from large raw conversation state at the last second

### 4.5 Hard fallback retry

Behavior:

- if backend still throws `Request too large` / `max 50MB`
- the retry should also use retained summary plus current request
- do not retry with the raw prompt alone

This makes the emergency retry path consistent with the staged mitigation strategy.

## 5. Compact Handoff Policy

The user selected a graded compact strategy.

### 5.1 Lower-risk compact

Continuation payload:

- retained summary
- a bounded slice of recent raw context
- current request

Purpose:

- preserve some short-range continuity
- still lower total context volume versus continuing the full provider thread

### 5.2 Higher-risk compact

Continuation payload:

- retained summary
- current request

Purpose:

- minimize payload size
- avoid carrying extra raw history when already close to dangerous limits

## 6. Recent Raw Context Budgeting

The user selected a combined budget rule.

Recent raw context should be bounded by:

1. a max number of recent turns
2. a total character/token-style budget

Interpretation:

- first cap to at most the last `N` recent user/assistant turns
- then trim that slice down to a fixed size budget

This ensures the "recent context" section cannot silently grow unbounded.

The precise budget values can be constants in implementation and tuned later.

## 7. Payload Composition

When not using the raw provider thread, the continuation payload should be structured in clear sections:

1. retained summary
2. recent context slice, if allowed for this risk level
3. current request

Example conceptual shape:

```text
Continuation summary for resumed work:
...

Recent context:
...

User request:
...
```

This should work for both string prompts and non-string prompts such as image inputs, preserving the current image-handling behavior.

## 8. Source of Truth

### 8.1 Retained summary

Retained summary remains the primary source of long-lived context.

It should contain:

- unfinished work
- active constraints
- current objective
- unresolved issues
- provider/model/cwd/permission mode

### 8.2 Recent raw context

Recent raw context is supplemental and short-lived.

It must not become a second copy of the full conversation.

### 8.3 Provider thread history

Provider thread history is still allowed in the normal and warning zones, but should stop being the dominant continuation mechanism once compact-level mitigation is triggered.

## 9. Hard Fallback Consistency

The hard backend fallback should remain in place, but its retry input should change:

Current undesired shape:

- raw prompt only

Desired shape:

- retained summary + optional recent context + current request

This ensures the fallback retry benefits from the same pruning/handoff work already done earlier.

## 10. Risks

### 10.1 Over-pruning continuity

If compact-level handoff drops too much recent context, model continuity may degrade.

Mitigation:

- keep a lower-risk compact tier with bounded recent raw context
- reserve summary-only handoff for higher-risk compact and hard fallback retry

### 10.2 Duplicate context

If retained summary and recent raw context repeat the same material, payload size may still be wasteful.

Mitigation:

- recent raw context is bounded
- retained summary should remain concise and focused on active items

### 10.3 Image/input preservation

If handoff is implemented only for string prompts, image turns may regress.

Mitigation:

- preserve the current prepend strategy for non-string prompts
- attach retained summary as a separate leading text message before the original structured input

## 11. Testing

Add tests covering:

1. warning zone still uses `resumeId` but refreshes retained summary
2. lower-risk compact switches away from `resumeId` and includes retained summary plus bounded recent context
3. higher-risk compact switches away from `resumeId` and includes retained summary without recent raw context
4. hard fallback retry uses retained summary-based handoff
5. image prompts still preserve non-text input while adding retained summary text

## 12. Acceptance Criteria

The change is complete when:

1. retained summary affects routine runtime handoff before a hard fallback is needed
2. compact-level mitigation no longer depends on raw provider history alone
3. lower-risk and higher-risk compact tiers differ in how much recent raw context they include
4. warning zone still avoids unnecessary early reset
5. relevant tests pass

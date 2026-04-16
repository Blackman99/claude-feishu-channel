# Proactive Context Pruning Design

- **Date**: 2026-04-16
- **Author**: zhaodongsheng x Codex
- **Upstream context**: existing staged context mitigation in `src/claude/session.ts`, continuation summary generation, session status tracking, and the superpowers-style task execution model used in this workflow
- **Downstream output**: implementation plan for proactively pruning completed work from continuation context before a forced summarized reset is needed

## 1. Goal

Improve context mitigation so the system starts pruning completed work **before** the conversation reaches the point where a summarized fresh session is required.

The target behavior is:

1. maintain a lightweight continuation summary continuously
2. remove only **explicitly completed** work items from retained context
3. preserve in-progress work, pending work, active constraints, and the user's latest request
4. when a fresh session is eventually needed, reuse the already-pruned summary instead of constructing it from a bloated context at the last minute

## 2. Scope

In scope:

- proactive continuation-summary maintenance
- explicit rules for deleting completed task context
- combining structured task state and explicit completion statements
- escalation behavior between normal, warning, and summarized-reset stages

Out of scope:

- model-generated second-pass summaries
- deleting content based on inferred completion
- changing the hard backend `Request too large / max 20MB` fallback path
- non-session memory systems or external task backends

## 3. Current Problem

The current staged mitigation has a summarized-reset branch, but the continuation summary is still constructed only when that branch is triggered.

That has two problems:

1. pruning happens too late, when the context is already large
2. the current summary template states that completed work should be dropped, but it does not actually track and delete completed task context over time

This means a conversation can continue carrying already-finished work longer than necessary, wasting context budget and making later summarized resets less efficient.

## 4. Proposed Behavior

### 4.1 Proactive continuation state

The session should maintain a **retained continuation state** continuously rather than only building a fresh summary at summarized-reset time.

This retained state is a compact representation of what the next session must know.

It should be updated:

- lightly after each completed turn
- more aggressively once the session enters the warning zone

### 4.2 Deletion rule

Only remove content tied to **explicitly completed** work.

Accepted completion signals:

1. structured task state marked `completed`
2. explicit completion statements in conversation status reporting such as:
   - `Task 2 已完成`
   - `Task 3 complete`
   - `spec complete`

Priority rule:

- structured state wins when structured state and plain-text status disagree

Rejected completion signals:

- inferred completion
- “probably done”
- vague progress wording
- assistant guesses based on surrounding context

If completion is not explicit, the item stays in retained context and may only be compressed, not deleted.

## 5. Retained Context Model

The retained continuation state should preserve:

- current in-progress task
- pending tasks
- unresolved risks
- still-active constraints and preferences
- key environment facts
- current provider / model / cwd / permission mode
- most recent user request that is still actionable

The retained continuation state should delete:

- tasks explicitly marked completed
- process chatter tied only to completed tasks
- intermediate reasoning that has been superseded by the completed result
- repeated progress updates for already-finished work

The retained continuation state should compress but keep:

- ambiguous or partially completed work
- contextual discussion that still affects an unfinished task

## 6. Two-Stage Maintenance Strategy

### 6.1 Normal zone

When context risk is normal:

- update the retained continuation state lightly
- append new active constraints and task status
- remove only clearly safe completed items

This stage should be low-cost and conservative.

### 6.2 Warning zone

When context risk enters warning territory:

- switch to aggressive pruning of explicitly completed work
- collapse repeated status chatter more eagerly
- reduce retained context to unfinished work, active constraints, and current objective

This stage prepares for a possible future summarized reset, but does not itself require a new session.

### 6.3 Summarized reset zone

When summarized reset becomes necessary:

- do not reconstruct summary state from raw bloated context
- use the already-maintained retained continuation state
- prepend that retained state to the fresh session prompt

This is the main benefit of proactive pruning: the system reaches reset time with a clean continuation payload already available.

## 7. Information Sources

### 7.1 Structured state

Preferred source:

- explicit plan/task state tracked as `pending`, `in_progress`, `completed`

This source is authoritative whenever available.

### 7.2 Plain-text completion statements

Secondary source:

- explicit assistant or system status updates that clearly mark a task or artifact complete

Examples:

- `Task 1 已完成`
- `Task 2 complete`
- `spec 已写好`

These can contribute to pruning only when they are explicit and unambiguous.

### 7.3 Conflict handling

If structured state says `in_progress` but a plain-text message says “done”:

- keep the item
- structured state wins

If no structured state exists but the plain-text completion statement is explicit:

- the item may be treated as completed for pruning purposes

## 8. Implementation Shape

The session should gain an internal retained-context structure alongside the current runtime state.

Possible shape:

- active objective
- active constraints
- retained unfinished tasks
- explicit completed-task index
- unresolved risks
- latest actionable user request

This should be updated during normal turn completion rather than only inside summarized-reset handling.

The final summary string should then be rendered from this retained structure instead of being assembled from a fixed template alone.

## 9. Summary Rendering

When rendered into a fresh-session continuation summary, the output should emphasize:

- unfinished tasks
- active constraints
- current objective
- unresolved issues

It should not enumerate completed tasks except where completion itself matters as a boundary, and even then it should be minimal.

Example direction:

- `Completed items removed from continuation context.`
- list only unfinished / active items

Not:

- a long changelog of everything that was already done

## 10. Risks

### 10.1 Over-deletion

The main risk is deleting information that still matters.

Mitigation:

- delete only explicitly completed items
- prefer structured completion state
- keep ambiguous items compressed rather than removed

### 10.2 Drift between raw context and retained state

If retained state is updated incorrectly, the fresh-session summary could diverge from reality.

Mitigation:

- update retained state only at stable turn boundaries
- test both normal-zone and warning-zone pruning
- test that unfinished tasks survive while completed tasks disappear

## 11. Testing

Add tests covering:

1. normal-zone updates keep unfinished work and constraints
2. warning-zone updates aggressively remove explicitly completed items
3. structured `completed` state removes task context even if older chatter remains
4. explicit text completion statements can prune when no structured state exists
5. ambiguous progress wording does not delete context
6. summarized reset uses the retained continuation state rather than rebuilding from raw turn text

## 12. Acceptance Criteria

The change is complete when:

1. continuation state is maintained before summarized reset is triggered
2. explicitly completed work is removed proactively
3. unfinished work, active constraints, and current objective are preserved
4. structured task state takes precedence over plain-text completion statements
5. summarized reset reuses the proactively maintained retained state
6. relevant unit tests pass

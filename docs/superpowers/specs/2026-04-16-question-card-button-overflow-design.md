# Question Card Button Overflow Design

- **Date**: 2026-04-16
- **Author**: zhaodongsheng x Codex
- **Upstream context**: `src/feishu/cards/question-card.ts`, `src/claude/feishu-question-broker.ts`, existing question-card tests
- **Downstream output**: implementation plan for stabilizing long-question / long-option button rendering

## 1. Goal

Fix the Feishu `ask_user` question card so long questions do not cause option buttons to become unreadable or overflow awkwardly.

The user priority for this change is:

1. keep the question text as complete as possible
2. shorten button display text when needed
3. preserve button behavior and broker semantics

## 2. Scope

This change applies only to the pending-state question card rendered by `buildQuestionPendingCard()`.

In scope:

- display-only shortening for question option buttons
- stable, readable prefixes for each option
- targeted tests for long-label rendering and behavior preservation

Out of scope:

- permission cards
- `/cd` confirm cards
- changing the underlying `ask_user` payload shape
- changing resolved/completed question card formatting unless required by implementation safety

## 3. Current Problem

`question-card.ts` currently renders each button label from the full `option.label`.

When a question is long and options are also long, the card layout becomes unstable:

- buttons wrap unpleasantly
- labels become hard to scan
- the visible button text may no longer fit cleanly inside Feishu's column layout

The implementation already contains a comment acknowledging this risk, but the current mitigation is not sufficient for long option labels.

## 4. Proposed Behavior

### 4.1 Question text

Keep the question body unchanged in this phase. The question text should remain as complete as it is today.

This directly follows the user's preference: preserve the question, shorten the buttons first.

### 4.2 Button display labels

Each option button should render a display-only label derived from the original option:

- `A. <short text>`
- `B. <short text>`
- `C. <short text>`
- `D. <short text>`

Rules:

1. assign prefixes by option index in display order
2. keep short labels unchanged apart from the added prefix
3. truncate long labels to a fixed display budget and append `...`
4. truncation affects only what the user sees on the button, not the stored answer

Examples:

- `Vim` → `A. Vim`
- `Use existing workspace and continue from the latest branch state` → `A. Use existing wor...`

### 4.3 Click behavior

Button click routing must remain unchanged.

The card action payload should still carry:

- `request_id`
- `question_index`
- `option_index`

The selected answer returned by the question broker must remain the original full `option.label`, not the shortened display label.

This keeps model-visible semantics stable and avoids introducing ambiguous answer values.

## 5. Layout Strategy

Do not change the current row layout in this phase.

Keep the existing `bisect` / `trisect` / `2+2` button row behavior and solve the overflow problem by shortening the visible button text.

Reasoning:

- this is the smallest targeted fix
- it preserves existing visual structure
- it reduces regression risk in Feishu card rendering

If overflow still remains after label shortening, layout changes can be a later follow-up.

## 6. Implementation Shape

Inside `src/feishu/cards/question-card.ts`:

- add a helper that converts `optionIndex + original label` into a short display label
- keep `button.value` unchanged
- use the shortened label only for `button.text.content`

Suggested internal structure:

- `optionPrefix(optionIndex): "A." | "B." | ...`
- `shortOptionLabel(optionIndex, originalLabel): string`
- optional small helper for code-point-safe truncation if current file does not already have one

The display-length budget should be fixed and intentionally conservative so Chinese and English labels both remain stable.

## 7. Testing

Add focused tests around question card rendering and broker behavior:

1. long option labels render shortened display labels with `A./B./C./D.` prefixes
2. short option labels remain readable and are not unnecessarily mangled
3. clicking a shortened button still resolves to the original full option label
4. multi-question cards preserve stable option ordering and index mapping

Prefer updating existing question-broker / question-card tests rather than creating a new test area.

## 8. Risks

### 8.1 Truncation ambiguity

Two long labels could share the same prefix and truncated visible text.

Mitigation:

- always include the ordinal prefix (`A.` / `B.` / ...)
- keep original answer values internally

### 8.2 International text length

Byte length and visual width are not the same, especially for Chinese text.

Mitigation:

- use a conservative fixed display budget
- prefer code-point-based truncation over byte-based truncation for button labels

## 9. Acceptance Criteria

The change is complete when:

1. long question cards no longer rely on full option text fitting inside the button
2. visible button labels use ordinal prefixes plus shortened text
3. the selected answer returned to the broker remains the original option label
4. relevant unit tests pass
5. no other card type changes behavior in this phase

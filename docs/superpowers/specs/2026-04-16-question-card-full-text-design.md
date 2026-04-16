# Question Card Full Text Design

- **Date**: 2026-04-16
- **Author**: zhaodongsheng x Codex
- **Upstream context**: `src/feishu/cards/question-card.ts`, `test/unit/claude/feishu-question-broker.test.ts`
- **Downstream output**: implementation plan for showing full question text without overloading button layout

## 1. Goal

When an `ask_user` question is very long, the card should still expose the full question text in a readable way while keeping the option buttons compact and stable.

## 2. Scope

This change applies only to the pending-state question card rendered by `buildQuestionCard()`.

In scope:

- long-question detection
- a dedicated full-text block for long questions
- preserving compact option buttons
- focused rendering and broker-behavior tests

Out of scope:

- permission cards
- `/cd` confirm cards
- changing the broker payload or answer values
- changing resolved/cancelled/timed-out card shapes unless strictly necessary

## 3. Current Problem

The current card places the full question text directly in the main prompt line:

- `**Q1.** <full question>`

This works for normal questions, but for very long questions the prompt body becomes hard to scan and visually competes with the buttons. We already shortened button labels, but the full question can still dominate the card and make the action area feel cramped.

## 4. Proposed Behavior

### 4.1 Short questions

For normal-length questions, keep the current rendering:

- one prompt line
- compact option buttons below it

No additional block is rendered.

### 4.2 Long questions

For long questions, render two text regions:

1. a short prompt line near the top, such as:
   - `**Q1.** Question`
   - or `**Q1.** Full question below`
2. a dedicated markdown block containing the full original question text

Then render the compact option buttons below that full-text block.

This keeps the buttons visually separate from the question body while still preserving the full question text on the card itself.

### 4.3 Buttons

Keep the recent button-shortening behavior:

- `A. <short text>`
- `B. <short text>`
- `C. <short text>`
- `D. <short text>`

Button click payloads and broker resolution remain unchanged.

## 5. Rendering Rules

### 5.1 Long-question threshold

Use a conservative code-point-based threshold for deciding whether a question is “long”.

The exact constant can live in `question-card.ts`, for example:

- `QUESTION_BODY_MAX = <fixed codepoint budget>`

It should be independent from the button-label budget.

### 5.2 Full-text block

The full-text block should:

- preserve the original question content
- be rendered as markdown text, not as a button label
- appear before the option buttons
- be visually distinct from the footer

The block should not change the internal question string used by the broker.

### 5.3 Prompt line for long questions

The short prompt line should remain concise and stable. It should not repeat the entire question in full.

The purpose of this line is only to preserve the per-question structure and numbering, not to carry all content.

## 6. Implementation Shape

In `src/feishu/cards/question-card.ts`:

- add a helper to detect long question text
- add a helper to build the compact prompt line for long questions
- add a helper or inline branch to render the full-text block only when needed

Suggested structure:

- `QUESTION_TEXT_MAX`
- `isLongQuestion(question: string): boolean`
- `questionPromptLine(questionIndex, question, header): string`
- optional `fullQuestionBlock(question: string): FeishuElement`

The existing button helpers remain in place.

## 7. Testing

Add focused tests to `test/unit/claude/feishu-question-broker.test.ts`:

1. short questions do not render the extra full-text block
2. long questions render a separate full-text block and still show compact buttons
3. clicking buttons on a long-question card still returns the original full option label
4. multi-question cards preserve numbering and stable option routing

## 8. Risks

### 8.1 Card verbosity

Adding another markdown block increases card height.

Mitigation:

- only render the extra block for long questions
- keep the prompt line short

### 8.2 Markdown escaping

Long questions may contain markdown-special characters.

Mitigation:

- keep using markdown escaping for rendered text

## 9. Acceptance Criteria

The change is complete when:

1. long questions expose their full text in a dedicated card body region
2. compact buttons remain readable and stable below the question body
3. short questions keep the simpler layout
4. answer resolution behavior is unchanged
5. relevant unit tests pass

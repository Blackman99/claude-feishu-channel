import type { FeishuCardV2 } from "../feishu/card-types.js";

/**
 * Spec for a single question inside an `ask_user` tool call. Mirrors
 * the built-in `AskUserQuestion` input shape so Claude can treat the
 * two interchangeably.
 */
export interface AskUserQuestionSpec {
  /** The full question text shown to the user. */
  question: string;
  /** Short (≤12 char) category label. Optional. */
  header?: string;
  /** 2–4 answer options. */
  options: ReadonlyArray<{
    label: string;
    description: string;
  }>;
  /**
   * If true, the user may select multiple options. v1 of the Feishu
   * card treats this as single-select and logs a warning — true
   * multi-select is future work.
   */
  multiSelect: boolean;
}

/**
 * A pending question request — the MCP `ask_user` handler constructs
 * one of these and hands it to `broker.request`.
 */
export interface QuestionRequest {
  /** 1..N questions, in order. */
  questions: ReadonlyArray<AskUserQuestionSpec>;
  /** Feishu chat that owns this request (for card routing). */
  chatId: string;
  /**
   * Open id of the user who sent the message that kicked off this
   * turn. Only this user may click the question buttons — everyone
   * else in the group gets a `forbidden` response.
   */
  ownerOpenId: string;
  /**
   * Feishu `message_id` of the user message that kicked off this
   * turn. The broker posts the question card as a reply to it so the
   * card threads under the exact request that caused it.
   */
  parentMessageId: string;
  /** Display language for all user-visible card strings. */
  locale: import("../util/i18n.js").Locale;
}

/**
 * Broker-internal response. The MCP handler translates each variant
 * to a `CallToolResult` before returning it to Claude via the SDK.
 * The returned promise MUST NOT reject under normal operation —
 * timeouts resolve `timed_out`, cancellations resolve `cancelled`.
 */
export type QuestionResponse =
  | {
      kind: "answered";
      /**
       * Map of `question text → selected option label`. Key order
       * matches the input `questions[]`.
       */
      answers: Record<string, string>;
    }
  | { kind: "cancelled"; reason: string }
  | { kind: "timed_out" };

/** Choice value encoded on each question card button. */
export interface QuestionCardChoice {
  questionIndex: number;
  optionIndex: number;
}

/**
 * Result of routing a `card.action.trigger` event to the broker.
 *
 * When `kind: "resolved"`, the broker MAY attach an updated `card`
 * that the gateway will return in the `card.action.trigger` callback
 * response body as `{ card: { type: "raw", data: card } }`. Feishu
 * uses that response to update the displayed card in place — this
 * is the supported click-to-update mechanism. `im.v1.message.patch`
 * is only reliable for out-of-band updates (timeouts, cancellations)
 * and silently no-ops for click-triggered updates in practice.
 */
export type QuestionCardActionResult =
  | { kind: "resolved"; card?: FeishuCardV2 }
  | { kind: "not_found" }
  | { kind: "forbidden"; ownerOpenId: string };

/**
 * Bridges between the in-process `mcp__feishu__ask_user` tool and the
 * Feishu question card UX. Phase 5 ships `FeishuQuestionBroker` as
 * the real implementation; tests use `FakeQuestionBroker`.
 */
export interface QuestionBroker {
  /**
   * Request one or more questions from the user. Resolves with the
   * user's answers, or a cancelled/timed_out variant. The returned
   * promise MUST NOT reject — only programming bugs should reject.
   */
  request(req: QuestionRequest): Promise<QuestionResponse>;

  /**
   * Handle a card button click. Called by the gateway after
   * access-control passes on the `card.action.trigger` event.
   * A partial-answer click (not all questions answered yet) still
   * returns `{kind: "resolved"}` because the broker handled it.
   */
  resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: QuestionCardChoice;
  }): Promise<QuestionCardActionResult>;

  /**
   * Bulk-cancel all pending requests with the given reason. Called
   * by `session.stop()` / `!` prefix so interrupting the turn also
   * unblocks any outstanding `ask_user` tool calls.
   */
  cancelAll(reason: string): void;
}

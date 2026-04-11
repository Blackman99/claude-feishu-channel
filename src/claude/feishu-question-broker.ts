import crypto from "node:crypto";
import type { Logger } from "pino";
import { createDeferred, type Deferred } from "../util/deferred.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { FeishuClient } from "../feishu/client.js";
import {
  buildQuestionCard,
  buildQuestionCardCancelled,
  buildQuestionCardResolved,
  buildQuestionCardTimedOut,
} from "../feishu/cards/question-card.js";
import type {
  AskUserQuestionSpec,
  QuestionBroker,
  QuestionCardActionResult,
  QuestionCardChoice,
  QuestionRequest,
  QuestionResponse,
} from "./question-broker.js";

interface PendingRequest {
  readonly requestId: string;
  readonly deferred: Deferred<QuestionResponse>;
  readonly cardMessageId: string;
  readonly parentMessageId: string;
  readonly ownerOpenId: string;
  readonly questions: ReadonlyArray<AskUserQuestionSpec>;
  /** One slot per question; null = still awaiting an answer. */
  readonly answers: Array<string | null>;
  readonly createdAt: number;
  timeoutTimer: TimeoutHandle;
  warnTimer: TimeoutHandle;
}

export interface FeishuQuestionBrokerOptions {
  feishu: FeishuClient;
  clock: Clock;
  logger: Logger;
  config: {
    timeoutMs: number;
    warnBeforeMs: number;
  };
}

/**
 * Production `QuestionBroker` backed by Feishu cards. Posts a
 * question card on every `ask_user` invocation, starts two timers
 * (one for the warning reminder, one for the auto-timeout), and
 * resolves the pending Deferred when the user has answered all
 * questions (via `resolveByCard`) or when `cancelAll` is called.
 */
export class FeishuQuestionBroker implements QuestionBroker {
  private readonly feishu: FeishuClient;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly warnBeforeMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(opts: FeishuQuestionBrokerOptions) {
    this.feishu = opts.feishu;
    this.clock = opts.clock;
    this.logger = opts.logger.child({ component: "feishu-question-broker" });
    this.timeoutMs = opts.config.timeoutMs;
    this.warnBeforeMs = opts.config.warnBeforeMs;
  }

  async request(req: QuestionRequest): Promise<QuestionResponse> {
    const requestId = crypto.randomUUID();
    const deferred = createDeferred<QuestionResponse>();
    const answers: Array<string | null> = req.questions.map(() => null);

    // 1. Send the question card as a reply to the triggering message.
    let cardMessageId: string;
    try {
      const res = await this.feishu.replyCard(
        req.parentMessageId,
        buildQuestionCard({
          requestId,
          questions: req.questions,
          answers,
        }),
      );
      cardMessageId = res.messageId;
    } catch (err) {
      this.logger.error(
        {
          err,
          question_count: req.questions.length,
          parent_message_id: req.parentMessageId,
        },
        "question card replyCard failed — auto-cancelling",
      );
      return {
        kind: "cancelled",
        reason: "Failed to send question card.",
      };
    }

    // 2. Start the timers (auto-timeout + warning reminder).
    const timeoutTimer = this.clock.setTimeout(
      () => this.autoTimeout(requestId),
      this.timeoutMs,
    );
    const warnTimer = this.clock.setTimeout(
      () => this.sendWarnReminder(requestId),
      Math.max(0, this.timeoutMs - this.warnBeforeMs),
    );

    // 3. Register the pending request.
    this.pending.set(requestId, {
      requestId,
      deferred,
      cardMessageId,
      parentMessageId: req.parentMessageId,
      ownerOpenId: req.ownerOpenId,
      questions: req.questions,
      answers,
      createdAt: this.clock.now(),
      timeoutTimer,
      warnTimer,
    });

    return deferred.promise;
  }

  async resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: QuestionCardChoice;
  }): Promise<QuestionCardActionResult> {
    this.logger.info(
      {
        request_id: args.requestId,
        sender: args.senderOpenId,
        choice: args.choice,
        pending_keys: Array.from(this.pending.keys()),
      },
      "question resolveByCard called",
    );
    const p = this.pending.get(args.requestId);
    if (!p) return { kind: "not_found" };
    if (args.senderOpenId !== p.ownerOpenId) {
      return { kind: "forbidden", ownerOpenId: p.ownerOpenId };
    }

    const { questionIndex, optionIndex } = args.choice;
    const question = p.questions[questionIndex];
    if (!question) {
      this.logger.warn(
        { request_id: args.requestId, question_index: questionIndex },
        "question index out of range",
      );
      return { kind: "not_found" };
    }
    const option = question.options[optionIndex];
    if (!option) {
      this.logger.warn(
        {
          request_id: args.requestId,
          question_index: questionIndex,
          option_index: optionIndex,
        },
        "option index out of range",
      );
      return { kind: "not_found" };
    }

    // Ignore a second click on an already-answered question. The
    // first click wins — the card should have hidden the buttons,
    // but a racing click can still land.
    if (p.answers[questionIndex] !== null) {
      return { kind: "resolved" };
    }
    p.answers[questionIndex] = option.label;

    const allAnswered = p.answers.every((a) => a !== null);

    if (!allAnswered) {
      // Partial state — return an updated pending card so the gateway
      // can replay it in the `card.action.trigger` callback response
      // body. Feishu updates the displayed card in place when the
      // response contains `{ card: { type: "raw", data: ... } }`. Using
      // `im.v1.message.patch` here silently no-ops in practice even
      // though it returns code=0 — the callback-response channel is
      // the only supported click-to-update mechanism.
      const updated = buildQuestionCard({
        requestId: p.requestId,
        questions: p.questions,
        answers: p.answers,
      });
      return { kind: "resolved", card: updated };
    }

    // All questions answered — finalize.
    this.clearTimers(p);
    this.pending.delete(args.requestId);

    const finalAnswers = p.answers as string[];
    this.logger.info(
      {
        card_message_id: p.cardMessageId,
        request_id: args.requestId,
        answers: finalAnswers,
      },
      "question all answered — returning resolved card in callback response",
    );

    const answerMap: Record<string, string> = {};
    for (let i = 0; i < p.questions.length; i++) {
      answerMap[p.questions[i]!.question] = finalAnswers[i]!;
    }
    p.deferred.resolve({ kind: "answered", answers: answerMap });

    const resolvedCard = buildQuestionCardResolved({
      questions: p.questions,
      answers: finalAnswers,
    });
    return { kind: "resolved", card: resolvedCard };
  }

  cancelAll(reason: string): void {
    const snapshot = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of snapshot) {
      this.clearTimers(p);
      p.deferred.resolve({ kind: "cancelled", reason });
      // Best-effort patch to the cancelled variant. Don't await —
      // /stop and ! paths call cancelAll synchronously and we don't
      // want to block them on a card patch round-trip.
      void this.feishu
        .patchCard(p.cardMessageId, buildQuestionCardCancelled({ reason }))
        .catch((err) => {
          this.logger.warn(
            { err, request_id: p.requestId },
            "cancelAll patch failed — ignoring",
          );
        });
    }
  }

  private autoTimeout(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.clearTimers(p);
    this.pending.delete(requestId);
    p.deferred.resolve({ kind: "timed_out" });
    void this.feishu
      .patchCard(p.cardMessageId, buildQuestionCardTimedOut())
      .catch((err) => {
        this.logger.warn(
          { err, request_id: requestId },
          "autoTimeout patch failed",
        );
      });
  }

  private sendWarnReminder(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    const secondsLeft = Math.round(this.warnBeforeMs / 1000);
    void this.feishu
      .replyText(
        p.parentMessageId,
        `⏰ 问题将在 ${secondsLeft}s 后自动取消`,
      )
      .catch((err) => {
        this.logger.warn(
          { err, request_id: requestId },
          "warn reminder failed",
        );
      });
  }

  private clearTimers(p: PendingRequest): void {
    this.clock.clearTimeout(p.timeoutTimer);
    this.clock.clearTimeout(p.warnTimer);
  }
}

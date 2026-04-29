import crypto from "node:crypto";
import type { Logger } from "pino";
import { createDeferred, type Deferred } from "../util/deferred.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { FeishuClient } from "../feishu/client.js";
import {
  buildPermissionCard,
  buildPermissionCardCancelled,
  buildPermissionCardResolved,
  buildPermissionCardTimedOut,
} from "../feishu/cards/permission-card.js";
import type {
  CardActionResult,
  CardChoice,
  PermissionBroker,
  PermissionRequest,
  PermissionResponse,
} from "./permission-broker.js";
import { t, type Locale } from "../util/i18n.js";

interface PendingRequest {
  readonly requestId: string;
  readonly deferred: Deferred<PermissionResponse>;
  readonly cardMessageId: string;
  readonly parentMessageId: string;
  readonly ownerOpenId: string;
  readonly toolName: string;
  readonly createdAt: number;
  readonly locale: Locale;
  timeoutTimer: TimeoutHandle;
  warnTimer: TimeoutHandle;
}

export interface FeishuPermissionBrokerOptions {
  feishu: FeishuClient;
  clock: Clock;
  logger: Logger;
  config: {
    timeoutMs: number;
    warnBeforeMs: number;
  };
}

/**
 * Production `PermissionBroker` backed by Feishu cards. Posts a
 * permission card on every `canUseTool` invocation, starts two
 * timers (one for the 60s warning reminder, one for the auto-deny),
 * and resolves the pending Deferred when the user clicks a button
 * (via `resolveByCard`) or when `cancelAll` is called.
 */
export class FeishuPermissionBroker implements PermissionBroker {
  private readonly feishu: FeishuClient;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private timeoutMs: number;
  private warnBeforeMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(opts: FeishuPermissionBrokerOptions) {
    this.feishu = opts.feishu;
    this.clock = opts.clock;
    this.logger = opts.logger.child({ component: "feishu-permission-broker" });
    this.timeoutMs = opts.config.timeoutMs;
    this.warnBeforeMs = opts.config.warnBeforeMs;
  }

  updateTiming(config: { timeoutMs: number; warnBeforeMs: number }): void {
    this.timeoutMs = config.timeoutMs;
    this.warnBeforeMs = config.warnBeforeMs;
  }

  async request(req: PermissionRequest): Promise<PermissionResponse> {
    const requestId = crypto.randomUUID();
    const deferred = createDeferred<PermissionResponse>();

    // 1. Send the permission card as a reply to the triggering message.
    let cardMessageId: string;
    try {
      const res = await this.feishu.replyCard(
        req.parentMessageId,
        buildPermissionCard({
          requestId,
          toolName: req.toolName,
          input: req.input,
          ownerOpenId: req.ownerOpenId,
          locale: req.locale,
        }),
      );
      cardMessageId = res.messageId;
    } catch (err) {
      this.logger.error(
        {
          err,
          tool_name: req.toolName,
          parent_message_id: req.parentMessageId,
        },
        "permission card replyCard failed — auto-denying",
      );
      return {
        behavior: "deny",
        message: "Failed to send permission card; auto-denied.",
      };
    }

    // 2. Start the timers (auto-deny + warning reminder).
    const timeoutTimer = this.clock.setTimeout(
      () => this.autoDeny(requestId),
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
      toolName: req.toolName,
      createdAt: this.clock.now(),
      locale: req.locale,
      timeoutTimer,
      warnTimer,
    });

    return deferred.promise;
  }

  async resolveByCard(args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult> {
    const p = this.pending.get(args.requestId);
    if (!p) return { kind: "not_found" };
    if (args.senderOpenId !== p.ownerOpenId) {
      return { kind: "forbidden", ownerOpenId: p.ownerOpenId };
    }
    this.clearTimers(p);
    this.pending.delete(args.requestId);

    // Build the resolved card to return in the callback response.
    // Returning the card directly in the card.action.trigger callback
    // is the only reliable way to update the card on click — the same
    // mechanism used by the question broker. patchCard is NOT called
    // here because Feishu silently ignores out-of-band patches that
    // race with a click event on the same card.
    const resolvedCard = buildPermissionCardResolved({
      toolName: p.toolName,
      choice: args.choice,
      locale: p.locale,
    });

    switch (args.choice) {
      case "allow":
        p.deferred.resolve({ behavior: "allow" });
        break;
      case "deny":
        p.deferred.resolve({
          behavior: "deny",
          message: "User denied the tool call.",
        });
        break;
      case "allow_turn":
        p.deferred.resolve({ behavior: "allow_turn" });
        break;
      case "allow_session":
        p.deferred.resolve({ behavior: "allow_session" });
        break;
    }
    return { kind: "resolved", card: resolvedCard };
  }

  cancelAll(reason: string): void {
    const snapshot = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of snapshot) {
      this.clearTimers(p);
      p.deferred.resolve({ behavior: "deny", message: reason });
      // Best-effort patch to the cancelled variant. Don't await —
      // /stop and ! paths call cancelAll synchronously and we don't
      // want to block them on a card patch round-trip.
      void this.feishu
        .patchCard(
          p.cardMessageId,
          buildPermissionCardCancelled({ toolName: p.toolName, reason, locale: p.locale }),
        )
        .catch((err) => {
          this.logger.warn(
            { err, request_id: p.requestId },
            "cancelAll patch failed — ignoring",
          );
        });
    }
  }

  private autoDeny(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.clearTimers(p);
    this.pending.delete(requestId);
    const seconds = Math.round(this.timeoutMs / 1000);
    p.deferred.resolve({
      behavior: "deny",
      message: `Permission request timed out after ${seconds}s.`,
    });
    void this.feishu
      .patchCard(
        p.cardMessageId,
        buildPermissionCardTimedOut({ toolName: p.toolName, locale: p.locale }),
      )
      .catch((err) => {
        this.logger.warn(
          { err, request_id: requestId },
          "autoDeny patch failed",
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
        t(p.locale).permWarnReminder(p.toolName, secondsLeft),
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

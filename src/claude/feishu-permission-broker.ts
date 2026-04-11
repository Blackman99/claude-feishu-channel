import crypto from "node:crypto";
import type { Logger } from "pino";
import { createDeferred, type Deferred } from "../util/deferred.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { FeishuClient } from "../feishu/client.js";
import {
  buildPermissionCard,
  buildPermissionCardResolved,
} from "../feishu/cards/permission-card.js";
import type {
  CardActionResult,
  CardChoice,
  PermissionBroker,
  PermissionRequest,
  PermissionResponse,
} from "./permission-broker.js";

interface PendingRequest {
  readonly requestId: string;
  readonly deferred: Deferred<PermissionResponse>;
  readonly cardMessageId: string;
  readonly parentMessageId: string;
  readonly ownerOpenId: string;
  readonly toolName: string;
  readonly createdAt: number;
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
  private readonly timeoutMs: number;
  private readonly warnBeforeMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(opts: FeishuPermissionBrokerOptions) {
    this.feishu = opts.feishu;
    this.clock = opts.clock;
    this.logger = opts.logger.child({ component: "feishu-permission-broker" });
    this.timeoutMs = opts.config.timeoutMs;
    this.warnBeforeMs = opts.config.warnBeforeMs;
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

    // Patch the card to its "resolved" variant. Failure warns but
    // doesn't block the resolution — the Deferred must still fire so
    // the SDK's canUseTool callback unblocks.
    try {
      await this.feishu.patchCard(
        p.cardMessageId,
        buildPermissionCardResolved({
          toolName: p.toolName,
          choice: args.choice,
          resolverOpenId: args.senderOpenId,
        }),
      );
    } catch (err) {
      this.logger.warn(
        {
          err,
          card_message_id: p.cardMessageId,
          request_id: args.requestId,
        },
        "permission card patch failed on resolve — continuing",
      );
    }

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
    return { kind: "resolved" };
  }

  cancelAll(_reason: string): void {
    // Implemented in Task 10.
  }

  private autoDeny(_requestId: string): void {
    // Implemented in Task 10.
  }

  private sendWarnReminder(_requestId: string): void {
    // Implemented in Task 10.
  }

  private clearTimers(p: PendingRequest): void {
    this.clock.clearTimeout(p.timeoutTimer);
    this.clock.clearTimeout(p.warnTimer);
  }

}

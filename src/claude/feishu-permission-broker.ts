import crypto from "node:crypto";
import type { Logger } from "pino";
import { createDeferred, type Deferred } from "../util/deferred.js";
import type { Clock, TimeoutHandle } from "../util/clock.js";
import type { FeishuClient } from "../feishu/client.js";
import {
  buildPermissionCard,
  buildPermissionCardResolved,
  buildPermissionCardCancelled,
  buildPermissionCardTimedOut,
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

  async resolveByCard(_args: {
    requestId: string;
    senderOpenId: string;
    choice: CardChoice;
  }): Promise<CardActionResult> {
    // Implemented in Task 9.
    throw new Error("not implemented");
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

  // Touch helpers to silence "unused" warnings during staged implementation.
  private _touch(): void {
    void this.clearTimers;
    void buildPermissionCardResolved;
    void buildPermissionCardCancelled;
    void buildPermissionCardTimedOut;
  }
}

import {
  Client as LarkClient,
  WSClient,
  EventDispatcher,
} from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import type { IncomingMessage } from "../types.js";
import type { AccessControl } from "../access.js";
import type { FeishuCardV2 } from "./card-types.js";
import { LruDedup } from "../util/dedup.js";

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface CardActionEvent {
  operator: {
    open_id: string;
  };
  action: {
    value: Record<string, unknown>;
  };
  // The event carries more fields (token, tenant_key, form_value...)
  // but Phase 5 only reads operator.open_id + action.value.
}

/**
 * Result of handling a card action. If a `card` is returned, the
 * gateway sends it back in the `card.action.trigger` callback response
 * body as `{ card: { type: "raw", data: card } }`, which is the
 * documented mechanism Feishu uses to update the displayed card after
 * a button click. Returning `void` (or undefined) leaves the card
 * unchanged.
 */
export type CardActionResult = { card?: FeishuCardV2 } | void;

export type CardActionHandler = (action: {
  senderOpenId: string;
  value: Record<string, unknown>;
}) => Promise<CardActionResult>;

export interface FeishuGatewayOptions {
  appId: string;
  appSecret: string;
  logger: Logger;
  lark: LarkClient;
  access: AccessControl;
  onMessage: MessageHandler;
  onCardAction: CardActionHandler;
}

interface ReceiveV1Event {
  sender: {
    sender_id: {
      open_id: string;
    };
  };
  message: {
    message_id: string;
    chat_id: string;
    message_type: string;
    content: string; // JSON-encoded
    create_time: string;
  };
}

export class FeishuGateway {
  private readonly lark: LarkClient;
  private readonly wsClient: WSClient;
  private readonly dedup = new LruDedup(1000);
  private readonly logger: Logger;
  private readonly access: AccessControl;
  private readonly onMessage: MessageHandler;
  private readonly onCardAction: CardActionHandler;

  constructor(opts: FeishuGatewayOptions) {
    this.lark = opts.lark;
    this.logger = opts.logger.child({ component: "feishu-gateway" });
    this.access = opts.access;
    this.onMessage = opts.onMessage;
    this.onCardAction = opts.onCardAction;

    this.wsClient = new WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      loggerLevel: 2, // lark sdk's "warn"
    });
  }

  async start(): Promise<void> {
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const event = data as ReceiveV1Event;
        await this.handleReceiveV1(event);
      },
      "card.action.trigger": async (data: unknown) => {
        const result = await this.handleCardAction(data as CardActionEvent);
        // Feishu's card callback response schema supports
        // `{ card: { type: "raw", data: <FeishuCardV2> } }` to update
        // the displayed card in place. The Lark WSClient base64-encodes
        // whatever we return here into the response payload (see
        // WSClient.handleEventData in the node-sdk), so this is the
        // supported click-to-update mechanism.
        if (result && result.card) {
          return { card: { type: "raw", data: result.card } };
        }
        return {};
      },
    });

    this.logger.info("Starting Feishu WebSocket client");
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  private async handleReceiveV1(event: ReceiveV1Event): Promise<void> {
    const log = this.logger.child({
      message_id: event.message.message_id,
      chat_id: event.message.chat_id,
    });

    if (this.dedup.check(event.message.message_id)) {
      log.debug("Duplicate message, skipping");
      return;
    }

    const decision = this.access.check(event.sender.sender_id.open_id);
    if (!decision.allowed) {
      log.warn(
        { open_id: event.sender.sender_id.open_id, action: decision.action },
        "Unauthorized sender",
      );
      return; // Phase 1 only implements "ignore" — "reject" behavior is identical here
    }

    // Phase 1: only handle text messages. Other types are dropped with a log.
    if (event.message.message_type !== "text") {
      log.info(
        { message_type: event.message.message_type },
        "Non-text message, dropping in Phase 1",
      );
      return;
    }

    let text = "";
    try {
      const parsed = JSON.parse(event.message.content) as { text?: string };
      text = parsed.text ?? "";
    } catch (err) {
      log.error({ err }, "Failed to parse message content");
      return;
    }

    const incoming: IncomingMessage = {
      messageId: event.message.message_id,
      chatId: event.message.chat_id,
      senderOpenId: event.sender.sender_id.open_id,
      text,
      // Feishu create_time is a stringified Unix milliseconds timestamp
      // (confirmed via open.feishu.cn docs: "消息发送时间（毫秒）"). No
      // conversion needed — IncomingMessage.receivedAt is also in ms.
      receivedAt: Number(event.message.create_time),
    };

    try {
      await this.onMessage(incoming);
    } catch (err) {
      log.error({ err }, "Message handler threw");
    }
  }

  private async handleCardAction(
    event: CardActionEvent,
  ): Promise<CardActionResult> {
    const log = this.logger.child({ open_id: event.operator.open_id });
    log.info(
      { value: event.action.value },
      "card.action.trigger received",
    );
    const decision = this.access.check(event.operator.open_id);
    if (!decision.allowed) {
      log.warn(
        { action: decision.action },
        "Unauthorized card action, ignoring",
      );
      return;
    }
    try {
      return await this.onCardAction({
        senderOpenId: event.operator.open_id,
        value: event.action.value,
      });
    } catch (err) {
      log.error({ err }, "Card action handler threw");
      return;
    }
  }
}

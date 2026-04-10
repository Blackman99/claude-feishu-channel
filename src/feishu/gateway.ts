import {
  Client as LarkClient,
  WSClient,
  EventDispatcher,
} from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import type { IncomingMessage } from "../types.js";
import type { AccessControl } from "../access.js";
import { LruDedup } from "../util/dedup.js";

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface FeishuGatewayOptions {
  appId: string;
  appSecret: string;
  logger: Logger;
  lark: LarkClient;
  access: AccessControl;
  onMessage: MessageHandler;
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

  constructor(opts: FeishuGatewayOptions) {
    this.lark = opts.lark;
    this.logger = opts.logger.child({ component: "feishu-gateway" });
    this.access = opts.access;
    this.onMessage = opts.onMessage;

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
}

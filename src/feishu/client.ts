import type { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import type { FeishuCardV2 } from "./card-types.js";

export interface SendTextResult {
  messageId: string;
}

export class FeishuClient {
  constructor(private readonly lark: LarkClient) {}

  async sendText(chatId: string, text: string): Promise<SendTextResult> {
    const response = await this.lark.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });

    if (response.code !== 0) {
      throw new Error(
        `Feishu send failed: code=${response.code} msg=${response.msg ?? ""}`,
      );
    }

    const messageId = response.data?.message_id;
    if (!messageId) {
      throw new Error(
        `Feishu send returned code=0 but no message_id (chatId=${chatId})`,
      );
    }

    return { messageId };
  }

  async sendCard(
    chatId: string,
    card: FeishuCardV2,
  ): Promise<SendTextResult> {
    const response = await this.lark.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    if (response.code !== 0) {
      throw new Error(
        `Feishu sendCard failed: code=${response.code} msg=${response.msg ?? ""}`,
      );
    }

    const messageId = response.data?.message_id;
    if (!messageId) {
      throw new Error(
        `Feishu sendCard returned code=0 but no message_id (chatId=${chatId})`,
      );
    }

    return { messageId };
  }
}

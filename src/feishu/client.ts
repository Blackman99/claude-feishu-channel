import type { Client as LarkClient } from "@larksuiteoapi/node-sdk";

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

    return { messageId: (response.data as { message_id?: string } | undefined)?.message_id ?? "" };
  }
}

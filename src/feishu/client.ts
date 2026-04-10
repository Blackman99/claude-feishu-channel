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

  /**
   * Update a previously-sent interactive card in place via
   * `im.v1.message.patch`. The original card MUST have been sent with
   * `config.update_multi: true` — Feishu rejects patches on cards that
   * did not declare this at send time. The new card also needs
   * `update_multi: true` (both before and after). In JSON 2.0
   * `update_multi` only accepts `true`, so this is always safe.
   *
   * Per-message patch rate limit is 5 QPS. Phase 3's event cadence
   * (a few events per second at most during a busy turn) stays well
   * under that ceiling for a single message.
   */
  async patchCard(messageId: string, card: FeishuCardV2): Promise<void> {
    const response = await this.lark.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });

    if (response.code !== 0) {
      throw new Error(
        `Feishu patchCard failed: code=${response.code} msg=${response.msg ?? ""} (message_id=${messageId})`,
      );
    }
  }

  /**
   * Convert a card message's `message_id` to the CardKit `card_id`
   * handle needed by `cardkit.v1.card.*` / `cardkit.v1.cardElement.*`
   * endpoints. Feishu keeps these id spaces separate: `message_id`
   * addresses a chat message, `card_id` addresses the underlying
   * card entity that the message renders.
   *
   * The message must have been sent as an `interactive` card with
   * `config.streaming_mode: true` for the subsequent streaming
   * element updates to produce a typewriter effect.
   */
  async convertMessageIdToCardId(messageId: string): Promise<string> {
    const response = await this.lark.cardkit.v1.card.idConvert({
      data: { message_id: messageId },
    });
    if (response.code !== 0) {
      throw new Error(
        `Feishu cardkit idConvert failed: code=${response.code} msg=${response.msg ?? ""} (message_id=${messageId})`,
      );
    }
    const cardId = response.data?.card_id;
    if (!cardId) {
      throw new Error(
        `Feishu cardkit idConvert returned code=0 but no card_id (message_id=${messageId})`,
      );
    }
    return cardId;
  }

  /**
   * Push the full current text for a single streamable element
   * (`markdown` or `plain_text` with a stable `element_id`). The
   * CardKit client computes the diff against the previous content
   * and renders the delta with a typing cursor animation.
   *
   * `sequence` is a monotonic integer the CALLER manages per card.
   * CardKit uses it to guard against reordered concurrent updates —
   * any call with a sequence lower than what the server has already
   * seen is dropped. Start at 1 for each new card and increment on
   * every subsequent update to the same card.
   *
   * Per-card rate limit is 10 QPS (vs. 5 QPS on `message.patch`),
   * and requires the `cardkit:card:write` scope on the app.
   */
  async streamElementContent(args: {
    cardId: string;
    elementId: string;
    content: string;
    sequence: number;
  }): Promise<void> {
    const { cardId, elementId, content, sequence } = args;
    const response = await this.lark.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, sequence },
    });
    if (response.code !== 0) {
      throw new Error(
        `Feishu cardkit streamElementContent failed: code=${response.code} msg=${response.msg ?? ""} (card_id=${cardId}, element_id=${elementId}, sequence=${sequence})`,
      );
    }
  }
}

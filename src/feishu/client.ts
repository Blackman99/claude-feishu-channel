import { Readable } from "node:stream";
import type { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import type { FeishuCardV2 } from "./card-types.js";

const FEISHU_API_TIMEOUT_MS = 15_000;

export interface SendTextResult {
  messageId: string;
}

export class FeishuClient {
  constructor(private readonly lark: LarkClient) {}

  async sendText(chatId: string, text: string): Promise<SendTextResult> {
    const response = await withTimeout(this.lark.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    }), "Feishu sendText");

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
    const response = await withTimeout(this.lark.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    }), "Feishu sendCard");

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
   * Send a plain-text message as a *reply* to a specific user message,
   * via `im.v1.message.reply`. The reply is rendered with a visible
   * quote of the parent message in Feishu, which lets the bot's
   * responses thread under the exact user message that triggered them
   * — useful in busy group chats where multiple people are talking to
   * the bot at once.
   *
   * The chat is implied by the parent `messageId`, so unlike `sendText`
   * there's no `chatId` parameter. `reply_in_thread` is omitted (default
   * `false`) — we want a quoted reply in the main timeline, not a
   * Slack-style sub-thread.
   */
  async replyText(
    parentMessageId: string,
    text: string,
  ): Promise<SendTextResult> {
    const response = await withTimeout(this.lark.im.v1.message.reply({
      path: { message_id: parentMessageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    }), "Feishu replyText");

    if (response.code !== 0) {
      throw new Error(
        `Feishu replyText failed: code=${response.code} msg=${response.msg ?? ""} (parent_message_id=${parentMessageId})`,
      );
    }

    const messageId = response.data?.message_id;
    if (!messageId) {
      throw new Error(
        `Feishu replyText returned code=0 but no message_id (parent_message_id=${parentMessageId})`,
      );
    }

    return { messageId };
  }

  /**
   * Send an interactive card as a *reply* to a specific user message.
   * Same threading semantics as `replyText` — see that method's doc
   * comment for the rationale.
   */
  async replyCard(
    parentMessageId: string,
    card: FeishuCardV2,
  ): Promise<SendTextResult> {
    const response = await withTimeout(this.lark.im.v1.message.reply({
      path: { message_id: parentMessageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    }), "Feishu replyCard");

    if (response.code !== 0) {
      throw new Error(
        `Feishu replyCard failed: code=${response.code} msg=${response.msg ?? ""} (parent_message_id=${parentMessageId})`,
      );
    }

    const messageId = response.data?.message_id;
    if (!messageId) {
      throw new Error(
        `Feishu replyCard returned code=0 but no message_id (parent_message_id=${parentMessageId})`,
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
    const response = await withTimeout(this.lark.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }), "Feishu patchCard");

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
    const response = await withTimeout(this.lark.cardkit.v1.card.idConvert({
      data: { message_id: messageId },
    }), "Feishu cardkit idConvert");
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
    const response = await withTimeout(this.lark.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, sequence },
    }), "Feishu cardkit streamElementContent");
    if (response.code !== 0) {
      throw new Error(
        `Feishu cardkit streamElementContent failed: code=${response.code} msg=${response.msg ?? ""} (card_id=${cardId}, element_id=${elementId}, sequence=${sequence})`,
      );
    }
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    const response = await withTimeout(this.lark.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    }), "Feishu downloadImage");
    const data = (
      typeof response === "object" &&
      response !== null &&
      "data" in response
        ? (response as { data: unknown }).data
        : response
    ) as unknown;
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (data instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (
      typeof data === "object" &&
      data !== null &&
      "getReadableStream" in data &&
      typeof (data as { getReadableStream: () => Readable }).getReadableStream === "function"
    ) {
      const stream = (data as { getReadableStream: () => Readable }).getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    throw new Error(
      `downloadImage: unexpected response type ${(data as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof data}`,
    );
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${FEISHU_API_TIMEOUT_MS}ms`));
    }, FEISHU_API_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

import type { Logger } from "pino";
import type { ReceiveV1Event } from "./types.js";
import type { IncomingMessage } from "../types.js";
import { detectImageMime } from "./image-mime.js";

export interface FeishuImageClient {
  downloadImage(messageId: string, imageKey: string): Promise<Buffer>;
}

/**
 * Translate a raw Feishu `im.message.receive_v1` event into an internal
 * `IncomingMessage`. Returns `null` if the event should be dropped
 * (unparseable content, download failure, unsupported type, empty
 * post). All drop decisions are logged here so the caller only needs
 * to check for null.
 */
export async function translateReceiveEvent(
  event: ReceiveV1Event,
  client: FeishuImageClient,
  log: Logger,
): Promise<IncomingMessage | null> {
  const msgType = event.message.message_type;
  let text = "";
  let imageDataUris: string[] | undefined;

  if (msgType === "text") {
    try {
      const parsed = JSON.parse(event.message.content) as { text?: string };
      text = parsed.text ?? "";
    } catch (err) {
      log.error({ err }, "Failed to parse text message content");
      return null;
    }
  } else if (msgType === "image") {
    try {
      const parsed = JSON.parse(event.message.content) as { image_key?: string };
      const imageKey = parsed.image_key;
      if (!imageKey) {
        log.warn({ content: event.message.content }, "Image message has no image_key");
        return null;
      }
      const bytes = await client.downloadImage(event.message.message_id, imageKey);
      imageDataUris = [`data:${detectImageMime(bytes)};base64,${bytes.toString("base64")}`];
      text = "[Image]";
    } catch (err) {
      log.warn({ err }, "Failed to download image — dropping message");
      return null;
    }
  } else {
    log.info({ message_type: msgType }, "Unsupported message type, dropping");
    return null;
  }

  return {
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    senderOpenId: event.sender.sender_id.open_id,
    text,
    ...(imageDataUris ? { imageDataUris } : {}),
    receivedAt: Number(event.message.create_time),
  };
}

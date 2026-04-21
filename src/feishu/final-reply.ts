import type { Logger } from "pino";
import { buildAnswerCard, prepareInline } from "./cards.js";
import type { FeishuClient } from "./client.js";

const FINAL_REPLY_TEXT_FALLBACK_MAX_BYTES = 20_000;

export async function replyFinalAnswerWithFallback(args: {
  feishu: FeishuClient;
  parentMessageId: string;
  text: string;
  logger: Logger;
  chatId: string;
}): Promise<void> {
  try {
    await args.feishu.replyCard(args.parentMessageId, buildAnswerCard(args.text));
    return;
  } catch (err) {
    args.logger.warn(
      { err, chat_id: args.chatId },
      "final answer replyCard failed; falling back to replyText",
    );
  }

  await args.feishu.replyText(
    args.parentMessageId,
    prepareInline(args.text, FINAL_REPLY_TEXT_FALLBACK_MAX_BYTES),
  );
}

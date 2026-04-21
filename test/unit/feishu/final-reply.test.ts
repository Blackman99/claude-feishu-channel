import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../src/util/logger.js";
import { replyFinalAnswerWithFallback } from "../../../src/feishu/final-reply.js";
import type { FeishuClient } from "../../../src/feishu/client.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

function makeFeishu(): {
  client: FeishuClient;
  replyCard: ReturnType<typeof vi.fn>;
  replyText: ReturnType<typeof vi.fn>;
} {
  const replyCard = vi.fn().mockResolvedValue({ messageId: "om_card" });
  const replyText = vi.fn().mockResolvedValue({ messageId: "om_text" });
  return {
    client: { replyCard, replyText } as unknown as FeishuClient,
    replyCard,
    replyText,
  };
}

describe("replyFinalAnswerWithFallback", () => {
  it("uses replyCard when the card send succeeds", async () => {
    const f = makeFeishu();

    await replyFinalAnswerWithFallback({
      feishu: f.client,
      parentMessageId: "om_parent",
      text: "final answer",
      logger: SILENT_LOGGER,
      chatId: "oc_1",
    });

    expect(f.replyCard).toHaveBeenCalledOnce();
    expect(f.replyText).not.toHaveBeenCalled();
  });

  it("falls back to replyText when the answer card send fails", async () => {
    const f = makeFeishu();
    f.replyCard.mockRejectedValueOnce(new Error("replyCard failed"));

    await replyFinalAnswerWithFallback({
      feishu: f.client,
      parentMessageId: "om_parent",
      text: "final answer",
      logger: SILENT_LOGGER,
      chatId: "oc_1",
    });

    expect(f.replyCard).toHaveBeenCalledOnce();
    expect(f.replyText).toHaveBeenCalledOnce();
    expect(f.replyText.mock.calls[0]![0]).toBe("om_parent");
    expect(f.replyText.mock.calls[0]![1]).toContain("final answer");
  });
});

import { describe, it, expect, vi } from "vitest";
import { FeishuPermissionBroker } from "../../../src/claude/feishu-permission-broker.js";
import type { FeishuClient } from "../../../src/feishu/client.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT = createLogger({ level: "error", pretty: false });

function makeFakeFeishu(): {
  client: FeishuClient;
  replyCard: ReturnType<typeof vi.fn>;
  patchCard: ReturnType<typeof vi.fn>;
  replyText: ReturnType<typeof vi.fn>;
} {
  const replyCard = vi.fn().mockResolvedValue({ messageId: "om_card_1" });
  const patchCard = vi.fn().mockResolvedValue(undefined);
  const replyText = vi.fn().mockResolvedValue({ messageId: "om_text_1" });
  const client = { replyCard, patchCard, replyText } as unknown as FeishuClient;
  return { client, replyCard, patchCard, replyText };
}

function makeBroker(feishu: FeishuClient, clock: FakeClock) {
  return new FeishuPermissionBroker({
    feishu,
    clock,
    logger: SILENT,
    config: { timeoutMs: 300_000, warnBeforeMs: 60_000 },
  });
}

describe("FeishuPermissionBroker.request — happy path", () => {
  it("sends a permission card via replyCard with the parent message id", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    // Fire the request but don't await — nobody will resolve it yet.
    void broker.request({
      toolName: "Bash",
      input: { command: "ls" },
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_parent_1",
    });
    // Let the async send settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(f.replyCard).toHaveBeenCalledTimes(1);
    const [parentId, card] = f.replyCard.mock.calls[0]!;
    expect(parentId).toBe("om_parent_1");
    // The card's serialization should include the tool name.
    expect(JSON.stringify(card)).toContain("Bash");
  });

  it("returns a pending promise (doesn't resolve until something happens)", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    const result = await Promise.race([
      p,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(result).toBe("pending");
  });

  it("returns deny if replyCard throws", async () => {
    const f = makeFakeFeishu();
    f.replyCard.mockRejectedValueOnce(new Error("send failed"));
    const broker = makeBroker(f.client, new FakeClock());
    const res = await broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    expect(res).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/card|auto-denied/i),
    });
  });
});

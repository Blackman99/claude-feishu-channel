import { describe, expect, it, vi } from "vitest";
import { AccessControl } from "../../../src/access.js";
import { FeishuGateway, type MessageHandler } from "../../../src/feishu/gateway.js";
import type { FeishuClient } from "../../../src/feishu/client.js";
import type { ReceiveV1Event } from "../../../src/feishu/types.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT = createLogger({ level: "error", pretty: false });

function makeTextEvent(openId: string): ReceiveV1Event {
  return {
    sender: { sender_id: { open_id: openId } },
    message: {
      message_id: "om_test",
      chat_id: "oc_test",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1700000000000",
    },
  };
}

function makeGateway(args: {
  access: AccessControl;
  feishuClient: Pick<FeishuClient, "replyText">;
  onMessage?: MessageHandler;
}): FeishuGateway {
  return new FeishuGateway({
    appId: "cli_test",
    appSecret: "secret",
    logger: SILENT,
    lark: {} as never,
    feishuClient: args.feishuClient as FeishuClient,
    access: args.access,
    onMessage: args.onMessage ?? (async () => {}),
    onCardAction: vi.fn(),
  });
}

async function handleReceiveV1(
  gateway: FeishuGateway,
  event: ReceiveV1Event,
): Promise<void> {
  await (gateway as unknown as {
    handleReceiveV1(event: ReceiveV1Event): Promise<void>;
  }).handleReceiveV1(event);
}

describe("FeishuGateway access-control replies", () => {
  it("replies with the sender open_id when unauthorized_behavior is reject", async () => {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: new AccessControl({
        allowedOpenIds: [],
        unauthorizedBehavior: "reject",
      }),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
    });

    await handleReceiveV1(gateway, makeTextEvent("ou_intruder"));

    expect(onMessage).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledTimes(1);
    expect(replyText.mock.calls[0]?.[0]).toBe("om_test");
    expect(replyText.mock.calls[0]?.[1]).toContain("ou_intruder");
    expect(replyText.mock.calls[0]?.[1]).toContain("allowed_open_ids");
  });

  it("stays silent when unauthorized_behavior is ignore", async () => {
    const replyText = vi.fn().mockResolvedValue({ messageId: "om_reply" });
    const onMessage = vi.fn(async () => {});
    const gateway = makeGateway({
      access: new AccessControl({
        allowedOpenIds: [],
        unauthorizedBehavior: "ignore",
      }),
      feishuClient: { replyText },
      onMessage: onMessage as unknown as MessageHandler,
    });

    await handleReceiveV1(gateway, makeTextEvent("ou_intruder"));

    expect(onMessage).not.toHaveBeenCalled();
    expect(replyText).not.toHaveBeenCalled();
  });
});

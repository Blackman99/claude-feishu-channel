import { describe, it, expect, vi } from "vitest";
import { FeishuClient } from "../../../src/feishu/client.js";

type MockLarkClient = {
  im: {
    v1: {
      message: {
        create: ReturnType<typeof vi.fn>;
      };
    };
  };
};

function makeMockLarkClient(): MockLarkClient {
  return {
    im: {
      v1: {
        message: {
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { message_id: "om_1" },
          }),
        },
      },
    },
  };
}

describe("FeishuClient.sendText", () => {
  it("calls im.v1.message.create with receive_id_type=chat_id and msg_type=text", async () => {
    const mock = makeMockLarkClient();
    const client = new FeishuClient(mock as never);
    const result = await client.sendText("oc_chat_1", "hello");
    expect(mock.im.v1.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat_1",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    });
    expect(result.messageId).toBe("om_1");
  });

  it("throws when lark API returns non-zero code", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.create = vi.fn().mockResolvedValue({
      code: 99991663,
      msg: "app ticket invalid",
    });
    const client = new FeishuClient(mock as never);
    await expect(client.sendText("oc_1", "hi")).rejects.toThrow(
      /99991663.*app ticket invalid/,
    );
  });

  it("throws when code is zero but message_id is missing", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.create = vi.fn().mockResolvedValue({
      code: 0,
      data: {},
    });
    const client = new FeishuClient(mock as never);
    await expect(client.sendText("oc_1", "hi")).rejects.toThrow(
      /message_id/i,
    );
  });

  it("escapes newlines and quotes in text content", async () => {
    const mock = makeMockLarkClient();
    const client = new FeishuClient(mock as never);
    await client.sendText("oc_1", 'line1\nline2 with "quotes"');
    const call = mock.im.v1.message.create.mock.calls[0]![0];
    // JSON.stringify handles escaping for us; assert the payload is valid JSON
    // and round-trips to the original text.
    const parsed = JSON.parse(call.data.content);
    expect(parsed.text).toBe('line1\nline2 with "quotes"');
  });
});

describe("FeishuClient.sendCard", () => {
  it("posts msg_type=interactive with JSON-stringified card content", async () => {
    const mock = makeMockLarkClient();
    const fc = new FeishuClient(mock as never);
    const card = {
      schema: "2.0" as const,
      body: {
        elements: [{ tag: "markdown" as const, content: "hi" }],
      },
    };
    const res = await fc.sendCard("oc_x", card);
    expect(res.messageId).toBe("om_1");
    expect(mock.im.v1.message.create).toHaveBeenCalledOnce();
    const arg = mock.im.v1.message.create.mock.calls[0]![0] as {
      params: { receive_id_type: string };
      data: { receive_id: string; msg_type: string; content: string };
    };
    expect(arg.params.receive_id_type).toBe("chat_id");
    expect(arg.data.receive_id).toBe("oc_x");
    expect(arg.data.msg_type).toBe("interactive");
    const parsed = JSON.parse(arg.data.content) as typeof card;
    expect(parsed).toEqual(card);
  });

  it("throws on non-zero response code", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.create = vi.fn().mockResolvedValue({
      code: 99991663,
      msg: "too busy",
    });
    const fc = new FeishuClient(mock as never);
    await expect(
      fc.sendCard("oc_x", { schema: "2.0", body: { elements: [] } }),
    ).rejects.toThrow(/99991663.*too busy/);
  });

  it("throws on code=0 but missing message_id", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.create = vi.fn().mockResolvedValue({
      code: 0,
      data: {},
    });
    const fc = new FeishuClient(mock as never);
    await expect(
      fc.sendCard("oc_x", { schema: "2.0", body: { elements: [] } }),
    ).rejects.toThrow(/no message_id/);
  });
});

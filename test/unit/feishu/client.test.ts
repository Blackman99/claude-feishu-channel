import { describe, it, expect, vi } from "vitest";
import { FeishuClient } from "../../../src/feishu/client.js";

type MockLarkClient = {
  im: {
    v1: {
      message: {
        create: ReturnType<typeof vi.fn>;
        patch: ReturnType<typeof vi.fn>;
        reply: ReturnType<typeof vi.fn>;
      };
      messageResource: {
        get: ReturnType<typeof vi.fn>;
      };
    };
  };
  cardkit: {
    v1: {
      card: {
        idConvert: ReturnType<typeof vi.fn>;
      };
      cardElement: {
        content: ReturnType<typeof vi.fn>;
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
          patch: vi.fn().mockResolvedValue({ code: 0, data: {} }),
          reply: vi.fn().mockResolvedValue({
            code: 0,
            data: { message_id: "om_reply_1" },
          }),
        },
        messageResource: {
          get: vi.fn().mockResolvedValue({
            code: 0,
            data: Buffer.from("image-bytes"),
          }),
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          idConvert: vi.fn().mockResolvedValue({
            code: 0,
            data: { card_id: "ck_1" },
          }),
        },
        cardElement: {
          content: vi.fn().mockResolvedValue({ code: 0, data: {} }),
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

describe("FeishuClient.replyText", () => {
  it("calls im.v1.message.reply with the parent message_id in path and msg_type=text", async () => {
    const mock = makeMockLarkClient();
    const fc = new FeishuClient(mock as never);
    const result = await fc.replyText("om_parent_123", "hello");
    expect(mock.im.v1.message.reply).toHaveBeenCalledWith({
      path: { message_id: "om_parent_123" },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    });
    expect(result.messageId).toBe("om_reply_1");
  });

  it("escapes newlines and quotes in text content", async () => {
    const mock = makeMockLarkClient();
    const fc = new FeishuClient(mock as never);
    await fc.replyText("om_parent_1", 'line1\nline2 with "quotes"');
    const call = mock.im.v1.message.reply.mock.calls[0]![0];
    const parsed = JSON.parse(call.data.content);
    expect(parsed.text).toBe('line1\nline2 with "quotes"');
  });

  it("throws when lark API returns non-zero code, including the parent message_id in the message", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.reply = vi.fn().mockResolvedValue({
      code: 230002,
      msg: "message not found",
    });
    const fc = new FeishuClient(mock as never);
    await expect(fc.replyText("om_missing", "hi")).rejects.toThrow(
      /230002.*message not found.*om_missing/,
    );
  });

  it("throws when code is zero but message_id is missing", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.reply = vi.fn().mockResolvedValue({
      code: 0,
      data: {},
    });
    const fc = new FeishuClient(mock as never);
    await expect(fc.replyText("om_parent", "hi")).rejects.toThrow(
      /no message_id/i,
    );
  });
});

describe("FeishuClient.replyCard", () => {
  it("calls im.v1.message.reply with msg_type=interactive and JSON-stringified card", async () => {
    const mock = makeMockLarkClient();
    const fc = new FeishuClient(mock as never);
    const card = {
      schema: "2.0" as const,
      body: { elements: [{ tag: "markdown" as const, content: "hi" }] },
    };
    const res = await fc.replyCard("om_parent_xyz", card);
    expect(res.messageId).toBe("om_reply_1");
    const arg = mock.im.v1.message.reply.mock.calls[0]![0] as {
      path: { message_id: string };
      data: { msg_type: string; content: string };
    };
    expect(arg.path.message_id).toBe("om_parent_xyz");
    expect(arg.data.msg_type).toBe("interactive");
    expect(JSON.parse(arg.data.content)).toEqual(card);
  });

  it("throws on non-zero response code", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.reply = vi.fn().mockResolvedValue({
      code: 99991663,
      msg: "too busy",
    });
    const fc = new FeishuClient(mock as never);
    await expect(
      fc.replyCard("om_parent", { schema: "2.0", body: { elements: [] } }),
    ).rejects.toThrow(/99991663.*too busy/);
  });

  it("throws on code=0 but missing message_id", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.reply = vi.fn().mockResolvedValue({
      code: 0,
      data: {},
    });
    const fc = new FeishuClient(mock as never);
    await expect(
      fc.replyCard("om_parent", { schema: "2.0", body: { elements: [] } }),
    ).rejects.toThrow(/no message_id/);
  });
});

describe("FeishuClient.patchCard", () => {
  it("calls im.v1.message.patch with the stringified card and the target message_id", async () => {
    const mock = makeMockLarkClient();
    const fc = new FeishuClient(mock as never);
    const card = {
      schema: "2.0" as const,
      config: { update_multi: true as const },
      body: {
        elements: [{ tag: "markdown" as const, content: "updated" }],
      },
    };
    await fc.patchCard("om_target", card);
    expect(mock.im.v1.message.patch).toHaveBeenCalledWith({
      path: { message_id: "om_target" },
      data: { content: JSON.stringify(card) },
    });
  });

  it("throws when lark API returns non-zero code", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.patch = vi.fn().mockResolvedValue({
      code: 230099,
      msg: "Failed to create card content",
    });
    const fc = new FeishuClient(mock as never);
    await expect(
      fc.patchCard("om_1", { schema: "2.0", body: { elements: [] } }),
    ).rejects.toThrow(/230099.*Failed to create card content/);
  });

  it("includes the target message_id in the error message for debuggability", async () => {
    const mock = makeMockLarkClient();
    mock.im.v1.message.patch = vi.fn().mockResolvedValue({
      code: 99991663,
      msg: "app ticket invalid",
    });
    const fc = new FeishuClient(mock as never);
    await expect(
      fc.patchCard("om_oops", { schema: "2.0", body: { elements: [] } }),
    ).rejects.toThrow(/om_oops/);
  });
});

describe("FeishuClient.downloadImage", () => {
  it("downloads image bytes from messageResource.get", async () => {
    const mock = makeMockLarkClient();
    const fc = new FeishuClient(mock as never);
    const result = await fc.downloadImage("om_parent", "img_v2_x");
    expect(mock.im.v1.messageResource.get).toHaveBeenCalledWith({
      path: { message_id: "om_parent", file_key: "img_v2_x" },
      params: { type: "image" },
    });
    expect(result.equals(Buffer.from("image-bytes"))).toBe(true);
  });
});

describe("FeishuClient.convertMessageIdToCardId", () => {
  it("calls cardkit.v1.card.idConvert with the message_id and returns the card_id", async () => {
    const mock = makeMockLarkClient();
    const fc = new FeishuClient(mock as never);
    const cardId = await fc.convertMessageIdToCardId("om_1");
    expect(cardId).toBe("ck_1");
    expect(mock.cardkit.v1.card.idConvert).toHaveBeenCalledWith({
      data: { message_id: "om_1" },
    });
  });

  it("throws on non-zero response code", async () => {
    const mock = makeMockLarkClient();
    mock.cardkit.v1.card.idConvert = vi.fn().mockResolvedValue({
      code: 230099,
      msg: "card not found",
    });
    const fc = new FeishuClient(mock as never);
    await expect(fc.convertMessageIdToCardId("om_missing")).rejects.toThrow(
      /230099.*card not found.*om_missing/,
    );
  });

  it("throws when code is zero but card_id is missing", async () => {
    const mock = makeMockLarkClient();
    mock.cardkit.v1.card.idConvert = vi.fn().mockResolvedValue({
      code: 0,
      data: {},
    });
    const fc = new FeishuClient(mock as never);
    await expect(fc.convertMessageIdToCardId("om_x")).rejects.toThrow(
      /no card_id/,
    );
  });
});

describe("FeishuClient.streamElementContent", () => {
  it("calls cardkit.v1.cardElement.content with the card/element ids and sequence", async () => {
    const mock = makeMockLarkClient();
    const fc = new FeishuClient(mock as never);
    await fc.streamElementContent({
      cardId: "ck_1",
      elementId: "thinking_md",
      content: "accumulated thought text",
      sequence: 3,
    });
    expect(mock.cardkit.v1.cardElement.content).toHaveBeenCalledWith({
      path: { card_id: "ck_1", element_id: "thinking_md" },
      data: { content: "accumulated thought text", sequence: 3 },
    });
  });

  it("throws on non-zero response code and includes debug context", async () => {
    const mock = makeMockLarkClient();
    mock.cardkit.v1.cardElement.content = vi.fn().mockResolvedValue({
      code: 230102,
      msg: "sequence too small",
    });
    const fc = new FeishuClient(mock as never);
    await expect(
      fc.streamElementContent({
        cardId: "ck_1",
        elementId: "thinking_md",
        content: "x",
        sequence: 1,
      }),
    ).rejects.toThrow(
      /230102.*sequence too small.*card_id=ck_1.*element_id=thinking_md.*sequence=1/,
    );
  });
});

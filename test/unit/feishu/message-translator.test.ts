import { describe, it, expect } from "vitest";
import { translateReceiveEvent, type FeishuImageClient } from "../../../src/feishu/message-translator.js";
import { createLogger } from "../../../src/util/logger.js";
import type { ReceiveV1Event } from "../../../src/feishu/types.js";

const SILENT = createLogger({ level: "error", pretty: false });

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function makeEvent(msgType: string, content: unknown): ReceiveV1Event {
  return {
    sender: { sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om_test",
      chat_id: "oc_test",
      message_type: msgType,
      content: typeof content === "string" ? content : JSON.stringify(content),
      create_time: "1700000000000",
    },
  } as ReceiveV1Event;
}

function fakeClient(map: Record<string, Buffer>): FeishuImageClient {
  return {
    async downloadImage(_msgId: string, key: string): Promise<Buffer> {
      const bytes = map[key];
      if (!bytes) throw new Error(`no fixture for ${key}`);
      return bytes;
    },
  };
}

describe("translateReceiveEvent — post messages", () => {
  it("accepts a post with text + 2 images, sniffing each MIME", async () => {
    const event = makeEvent("post", {
      content: [[
        { tag: "text", text: "screenshots: " },
        { tag: "img", image_key: "img_a" },
        { tag: "img", image_key: "img_b" },
      ]],
    });
    const client = fakeClient({ img_a: PNG_BYTES, img_b: JPEG_BYTES });
    const result = await translateReceiveEvent(event, client, SILENT);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("screenshots:");
    expect(result!.imageDataUris).toHaveLength(2);
    expect(result!.imageDataUris![0]).toMatch(/^data:image\/png;base64,/);
    expect(result!.imageDataUris![1]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("accepts a post with only text (no imageDataUris field)", async () => {
    const event = makeEvent("post", {
      content: [[{ tag: "text", text: "hello" }]],
    });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("hello");
    expect(result!.imageDataUris).toBeUndefined();
  });

  it("drops the message when ANY post image fails to download", async () => {
    const event = makeEvent("post", {
      content: [[
        { tag: "img", image_key: "img_ok" },
        { tag: "img", image_key: "img_boom" },
      ]],
    });
    const client = fakeClient({ img_ok: PNG_BYTES }); // img_boom missing
    const result = await translateReceiveEvent(event, client, SILENT);
    expect(result).toBeNull();
  });

  it("drops the message when post content is not valid JSON", async () => {
    const event = makeEvent("post", "{not json");
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });

  it("drops the message when post content array is missing", async () => {
    const event = makeEvent("post", { title: "x" });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });

  it("drops an empty post (no text, no images)", async () => {
    const event = makeEvent("post", { content: [[]] });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });
});

describe("translateReceiveEvent — regression for existing branches", () => {
  it("forwards text messages unchanged", async () => {
    const event = makeEvent("text", { text: "ping" });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toEqual(expect.objectContaining({
      text: "ping",
      messageId: "om_test",
      chatId: "oc_test",
      senderOpenId: "ou_sender",
    }));
    expect(result!.imageDataUris).toBeUndefined();
  });

  it("sniffs MIME for the standalone image branch too (PNG, not hardcoded JPEG)", async () => {
    const event = makeEvent("image", { image_key: "img_one" });
    const client = fakeClient({ img_one: PNG_BYTES });
    const result = await translateReceiveEvent(event, client, SILENT);
    expect(result!.imageDataUris).toHaveLength(1);
    expect(result!.imageDataUris![0]).toMatch(/^data:image\/png;base64,/);
    expect(result!.text).toBe("[Image]");
  });

  it("drops unsupported message types (file, audio, etc.) with an info log", async () => {
    const event = makeEvent("file", { file_key: "f_1" });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });

  it("drops image message with missing image_key", async () => {
    const event = makeEvent("image", {});
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });
});

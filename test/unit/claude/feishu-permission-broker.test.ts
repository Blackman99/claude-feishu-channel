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

describe("FeishuPermissionBroker.resolveByCard", () => {
  // Tests use `findRequestIdInCard(card)` (defined at the bottom of
  // this file) to extract the crypto.randomUUID the broker generated
  // internally, by walking the button value of the card that was
  // handed to the mocked replyCard.

  it("owner click with choice=allow resolves with {allow} and patches card to resolved variant", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: { command: "ls" },
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();

    // Extract request_id from the button value of the sent card.
    const card = f.replyCard.mock.calls[0]![1];
    const requestId = findRequestIdInCard(card);
    expect(requestId).toBeTruthy();

    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "allow",
    });
    expect(result).toEqual({ kind: "resolved" });
    const resp = await p;
    expect(resp).toEqual({ behavior: "allow" });
    expect(f.patchCard).toHaveBeenCalledWith(
      "om_card_1",
      expect.any(Object),
    );
  });

  it("owner click with choice=deny resolves with {deny, message}", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "deny",
    });
    const resp = await p;
    expect(resp).toMatchObject({ behavior: "deny", message: expect.any(String) });
  });

  it("owner click with choice=allow_turn resolves with {allow_turn}", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Edit",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);
    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "allow_turn",
    });
    expect(await p).toEqual({ behavior: "allow_turn" });
  });

  it("owner click with choice=allow_session resolves with {allow_session}", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Edit",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);
    await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "allow_session",
    });
    expect(await p).toEqual({ behavior: "allow_session" });
  });

  it("non-owner click returns forbidden and leaves the request pending", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_intruder",
      choice: "allow",
    });
    expect(result).toEqual({ kind: "forbidden", ownerOpenId: "ou_owner" });

    // Promise must still be pending.
    const settled = await Promise.race([
      p.then(() => "resolved"),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(settled).toBe("pending");
  });

  it("unknown requestId returns not_found", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const result = await broker.resolveByCard({
      requestId: "req_does_not_exist",
      senderOpenId: "ou_x",
      choice: "allow",
    });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("patchCard failure during resolve does not block the resolution", async () => {
    const f = makeFakeFeishu();
    f.patchCard.mockRejectedValueOnce(new Error("patch failed"));
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    const requestId = findRequestIdInCard(f.replyCard.mock.calls[0]![1]);

    const result = await broker.resolveByCard({
      requestId,
      senderOpenId: "ou_owner",
      choice: "allow",
    });
    expect(result).toEqual({ kind: "resolved" });
    expect(await p).toEqual({ behavior: "allow" });
  });
});

describe("FeishuPermissionBroker.cancelAll", () => {
  it("denies all pending with the given reason and clears the map", async () => {
    const f = makeFakeFeishu();
    const clock = new FakeClock();
    const broker = makeBroker(f.client, clock);
    const p1 = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p1",
    });
    // Second request uses a different parent message id.
    f.replyCard.mockResolvedValueOnce({ messageId: "om_card_2" });
    const p2 = broker.request({
      toolName: "Edit",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p2",
    });
    await Promise.resolve();
    await Promise.resolve();

    broker.cancelAll("User issued /stop");

    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toEqual({
      behavior: "deny",
      message: "User issued /stop",
    });
    expect(r2).toEqual({
      behavior: "deny",
      message: "User issued /stop",
    });
  });

  it("patches each cancelled card to the cancelled variant (best effort)", async () => {
    const f = makeFakeFeishu();
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();

    broker.cancelAll("Bang prefix cancellation");
    await p;
    // Allow the void-catch patchCard to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(f.patchCard).toHaveBeenCalled();
    const patchCall = f.patchCard.mock.calls[0]!;
    expect(JSON.stringify(patchCall[1])).toMatch(/Bang prefix|取消/);
  });

  it("cancelAll swallows patchCard errors", async () => {
    const f = makeFakeFeishu();
    f.patchCard.mockRejectedValue(new Error("down"));
    const broker = makeBroker(f.client, new FakeClock());
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => broker.cancelAll("cleanup")).not.toThrow();
    expect(await p).toEqual({
      behavior: "deny",
      message: "cleanup",
    });
  });
});

describe("FeishuPermissionBroker timers", () => {
  it("auto-denies after timeoutMs and patches the card to timed_out", async () => {
    const f = makeFakeFeishu();
    const clock = new FakeClock();
    const broker = makeBroker(f.client, clock);
    const p = broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();

    clock.advance(300_000);
    const res = await p;
    expect(res).toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/timed out|300/i),
    });
    // Need one more tick to let the patchCard void promise settle.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(f.patchCard).toHaveBeenCalled();
    const lastCard = f.patchCard.mock.calls.at(-1)![1];
    expect(JSON.stringify(lastCard)).toMatch(/超时|timed out/i);
  });

  it("sends the warn reminder (timeoutMs - warnBeforeMs) in", async () => {
    const f = makeFakeFeishu();
    const clock = new FakeClock();
    const broker = makeBroker(f.client, clock);
    void broker.request({
      toolName: "Bash",
      input: {},
      chatId: "oc_1",
      ownerOpenId: "ou_x",
      parentMessageId: "om_p",
    });
    await Promise.resolve();
    await Promise.resolve();

    clock.advance(240_000);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(f.replyText).toHaveBeenCalled();
    const replyArgs = f.replyText.mock.calls.at(-1)!;
    expect(replyArgs[0]).toBe("om_p");
    expect(String(replyArgs[1])).toMatch(/60|⏰/);
  });
});

function findRequestIdInCard(card: unknown): string {
  let found: string | undefined;
  function walk(el: unknown): void {
    if (!el || typeof el !== "object") return;
    const e = el as { tag?: string; value?: { request_id?: unknown }; elements?: unknown[]; columns?: unknown[]; body?: unknown };
    if (e.tag === "button" && e.value && typeof e.value.request_id === "string") {
      found = e.value.request_id;
    }
    if (Array.isArray(e.elements)) e.elements.forEach(walk);
    if (Array.isArray(e.columns)) e.columns.forEach(walk);
    if (e.body) walk(e.body);
  }
  walk(card);
  if (!found) throw new Error("no request_id found in card");
  return found;
}

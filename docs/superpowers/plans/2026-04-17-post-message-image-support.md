# Feishu `post` Message + Multi-Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept Feishu `post` (rich text) messages, flatten their content to text, forward every inline image to Claude in a single turn, and tag each image with the correct MIME type sniffed from its bytes.

**Architecture:** A new pure module (`src/feishu/post-parser.ts`) flattens post JSON into `{text, imageKeys[]}`; another pure module (`src/feishu/image-mime.ts`) sniffs image magic bytes. The gateway's `handleReceiveV1` body is lifted into a testable async helper `translateReceiveEvent` that dispatches on `message_type`. The `IncomingMessage.imageDataUri` field is renamed to `imageDataUris: readonly string[]` and propagated through `SubmitInput`, `QueuedInput`, `ClaudeSession.buildPrompt`, and the `index.ts` submit call (fixing a pre-existing thread-through bug in the process).

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, pino. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-17-post-message-image-support-design.md`

---

## File Structure

**Created:**
- `src/feishu/image-mime.ts` — pure magic-byte MIME sniffer (~30 LOC)
- `src/feishu/post-parser.ts` — pure post flattener (~80 LOC)
- `src/feishu/message-translator.ts` — async event→IncomingMessage dispatcher lifted out of gateway.ts (~80 LOC)
- `test/unit/feishu/image-mime.test.ts`
- `test/unit/feishu/post-parser.test.ts`
- `test/unit/feishu/message-translator.test.ts`

**Modified:**
- `src/types.ts` — rename `IncomingMessage.imageDataUri?: string` → `imageDataUris?: readonly string[]`
- `src/feishu/gateway.ts` — replace body of `handleReceiveV1` with a call to `translateReceiveEvent`
- `src/claude/session.ts` — rename field on `QueuedInput` + `SubmitInput`; rewrite `buildPrompt`, `promptPreview`, `immediateRequestSummary`
- `src/index.ts` — pass `imageDataUris` through to `session.submit`
- `test/unit/feishu/messages.test.ts` — update `IncomingMessage` image-support case
- `test/unit/claude/context-mitigation.test.ts` — update `runImageInput` helper and both call sites

---

## Task 1: `image-mime.ts` — magic-byte sniffer

**Files:**
- Create: `src/feishu/image-mime.ts`
- Create: `test/unit/feishu/image-mime.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/feishu/image-mime.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectImageMime } from "../../../src/feishu/image-mime.js";

describe("detectImageMime", () => {
  it("detects PNG from magic bytes 89 50 4E 47", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectImageMime(buf)).toBe("image/png");
  });

  it("detects JPEG from magic bytes FF D8 FF", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMime(buf)).toBe("image/jpeg");
  });

  it("detects GIF from magic bytes 47 49 46", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageMime(buf)).toBe("image/gif");
  });

  it("detects WebP from RIFF … WEBP", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectImageMime(buf)).toBe("image/webp");
  });

  it("falls back to image/jpeg for unknown bytes", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(detectImageMime(buf)).toBe("image/jpeg");
  });

  it("falls back to image/jpeg when buffer is shorter than signature length", () => {
    expect(detectImageMime(Buffer.from([]))).toBe("image/jpeg");
    expect(detectImageMime(Buffer.from([0x89, 0x50]))).toBe("image/jpeg");
  });

  it("rejects RIFF without WEBP marker", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, // "WAVE"
    ]);
    expect(detectImageMime(buf)).toBe("image/jpeg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/feishu/image-mime.test.ts`
Expected: FAIL with `Cannot find module '.../src/feishu/image-mime.js'`

- [ ] **Step 3: Write the implementation**

Create `src/feishu/image-mime.ts`:

```typescript
export type SupportedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/**
 * Identify an image MIME type from the first ~12 bytes of the buffer.
 * Covers the four formats the Claude API accepts. Falls back to
 * image/jpeg when the signature is unrecognized.
 */
export function detectImageMime(buf: Buffer): SupportedImageMime {
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 &&
      buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 3 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return "image/gif";
  }
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return "image/webp";
  }
  return "image/jpeg";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/feishu/image-mime.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/image-mime.ts test/unit/feishu/image-mime.test.ts
git commit -m "feat: add image MIME sniffer for Feishu downloads"
```

---

## Task 2: `post-parser.ts` — flatten Feishu rich text

**Files:**
- Create: `src/feishu/post-parser.ts`
- Create: `test/unit/feishu/post-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/feishu/post-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parsePost } from "../../../src/feishu/post-parser.js";

function encode(post: unknown): string {
  return JSON.stringify(post);
}

describe("parsePost", () => {
  it("flattens a single-paragraph text-only post", () => {
    const raw = encode({
      content: [[{ tag: "text", text: "hello world" }]],
    });
    expect(parsePost(raw)).toEqual({ text: "hello world", imageKeys: [] });
  });

  it("renders an `a` tag as `text (href)`", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "see " },
        { tag: "a", text: "this link", href: "https://example.com" },
      ]],
    });
    expect(parsePost(raw).text).toBe("see this link (https://example.com)");
  });

  it("renders an `at` tag as `@user_name` (fallback to user_id)", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "hi " },
        { tag: "at", user_id: "ou_1", user_name: "Alice" },
        { tag: "text", text: " and " },
        { tag: "at", user_id: "ou_2" },
      ]],
    });
    expect(parsePost(raw).text).toBe("hi @Alice and @ou_2");
  });

  it("renders an `emotion` tag as `:EMOJI_TYPE:`", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "ok " },
        { tag: "emotion", emoji_type: "SMILE" },
      ]],
    });
    expect(parsePost(raw).text).toBe("ok :SMILE:");
  });

  it("collects `img` tags in document order and omits image text", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "before " },
        { tag: "img", image_key: "img_1" },
        { tag: "text", text: " middle " },
        { tag: "img", image_key: "img_2" },
        { tag: "text", text: " after" },
      ]],
    });
    expect(parsePost(raw)).toEqual({
      text: "before  middle  after",
      imageKeys: ["img_1", "img_2"],
    });
  });

  it("treats `media` tags the same as `img` tags", () => {
    const raw = encode({
      content: [[{ tag: "media", image_key: "img_m" }]],
    });
    expect(parsePost(raw)).toEqual({ text: "", imageKeys: ["img_m"] });
  });

  it("joins multiple paragraphs with a blank line", () => {
    const raw = encode({
      content: [
        [{ tag: "text", text: "line one" }],
        [{ tag: "text", text: "line two" }],
      ],
    });
    expect(parsePost(raw).text).toBe("line one\n\nline two");
  });

  it("drops empty paragraphs so image-only paragraphs do not create blank lines", () => {
    const raw = encode({
      content: [
        [{ tag: "text", text: "look" }],
        [{ tag: "img", image_key: "img_1" }],
        [{ tag: "text", text: "what do you think?" }],
      ],
    });
    expect(parsePost(raw)).toEqual({
      text: "look\n\nwhat do you think?",
      imageKeys: ["img_1"],
    });
  });

  it("prepends a non-empty title as the first paragraph", () => {
    const raw = encode({
      title: "Meeting notes",
      content: [[{ tag: "text", text: "body" }]],
    });
    expect(parsePost(raw).text).toBe("Meeting notes\n\nbody");
  });

  it("omits an empty or whitespace-only title", () => {
    const raw = encode({
      title: "   ",
      content: [[{ tag: "text", text: "body" }]],
    });
    expect(parsePost(raw).text).toBe("body");
  });

  it("decodes common HTML entities when un_escape is true", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "&lt;tag&gt; &amp; &quot;x&quot; &#39;y&#39;", un_escape: true },
      ]],
    });
    expect(parsePost(raw).text).toBe(`<tag> & "x" 'y'`);
  });

  it("leaves entities alone when un_escape is absent or false", () => {
    const raw = encode({
      content: [[{ tag: "text", text: "&lt;keep&gt;" }]],
    });
    expect(parsePost(raw).text).toBe("&lt;keep&gt;");
  });

  it("skips unknown inline tags without throwing", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "x" },
        { tag: "widget_frobnicator", foo: 1 },
        { tag: "text", text: "y" },
      ]],
    });
    expect(parsePost(raw).text).toBe("xy");
  });

  it("returns empty text for an image-only post", () => {
    const raw = encode({
      content: [[{ tag: "img", image_key: "img_1" }]],
    });
    expect(parsePost(raw)).toEqual({ text: "", imageKeys: ["img_1"] });
  });

  it("trims leading and trailing whitespace from the flattened text", () => {
    const raw = encode({
      content: [[{ tag: "text", text: "  hello  " }]],
    });
    expect(parsePost(raw).text).toBe("hello");
  });

  it("throws when the content is not valid JSON", () => {
    expect(() => parsePost("{not json")).toThrow();
  });

  it("throws when the root `content` is not an array", () => {
    expect(() => parsePost(encode({ content: "nope" }))).toThrow();
  });

  it("throws when a paragraph is not an array", () => {
    expect(() => parsePost(encode({ content: ["nope"] }))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/feishu/post-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/feishu/post-parser.ts`:

```typescript
export interface ParsedPost {
  /** Paragraphs joined by "\n\n", trimmed. May be empty. */
  text: string;
  /** Inline image_key values in document order. May be empty. */
  imageKeys: string[];
}

interface PostElement {
  tag?: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  emoji_type?: string;
  image_key?: string;
  un_escape?: boolean;
}

interface PostEnvelope {
  title?: string;
  content?: unknown;
}

const ENTITY_MAP: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
};

function unescapeEntities(s: string): string {
  return s.replace(/&(?:lt|gt|amp|quot|#39);/g, (m) => ENTITY_MAP[m] ?? m);
}

function renderElement(el: PostElement, imageKeys: string[]): string {
  switch (el.tag) {
    case "text": {
      const text = el.text ?? "";
      return el.un_escape === true ? unescapeEntities(text) : text;
    }
    case "a":
      return `${el.text ?? ""} (${el.href ?? ""})`;
    case "at":
      return `@${el.user_name ?? el.user_id ?? "user"}`;
    case "emotion":
      return `:${el.emoji_type ?? ""}:`;
    case "img":
    case "media": {
      if (typeof el.image_key === "string" && el.image_key.length > 0) {
        imageKeys.push(el.image_key);
      }
      return "";
    }
    default:
      return "";
  }
}

/**
 * Flatten a Feishu `post` message content string into plain text plus
 * an ordered list of inline image_keys. Throws on malformed JSON or
 * when the envelope lacks a content array.
 */
export function parsePost(rawContent: string): ParsedPost {
  const envelope = JSON.parse(rawContent) as PostEnvelope;
  if (!Array.isArray(envelope.content)) {
    throw new Error("parsePost: `content` is not an array");
  }

  const imageKeys: string[] = [];
  const paragraphs: string[] = [];

  const title = envelope.title?.trim();
  if (title && title.length > 0) {
    paragraphs.push(title);
  }

  for (const paragraph of envelope.content) {
    if (!Array.isArray(paragraph)) {
      throw new Error("parsePost: paragraph is not an array");
    }
    const rendered = (paragraph as PostElement[])
      .map((el) => renderElement(el, imageKeys))
      .join("");
    if (rendered.length > 0) {
      paragraphs.push(rendered);
    }
  }

  return {
    text: paragraphs.join("\n\n").trim(),
    imageKeys,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/feishu/post-parser.test.ts`
Expected: PASS — all 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/post-parser.ts test/unit/feishu/post-parser.test.ts
git commit -m "feat: add Feishu post content flattener"
```

---

## Task 3: Rename `IncomingMessage.imageDataUri` → `imageDataUris`

**Files:**
- Modify: `src/types.ts:92`
- Modify: `test/unit/feishu/messages.test.ts:89-100`

- [ ] **Step 1: Update the type**

Edit `src/types.ts` line 91-92:

```typescript
  /** Attached images as data URIs. Undefined for text-only messages;
   *  non-empty array when the source message carried one or more images. */
  imageDataUris?: readonly string[];
```

- [ ] **Step 2: Update the only current consumer test**

Edit `test/unit/feishu/messages.test.ts` lines 89-101 to:

```typescript
describe("IncomingMessage image support", () => {
  it("supports imageDataUris on image-bearing messages", () => {
    const msg: IncomingMessage = {
      messageId: "om_x",
      chatId: "oc_x",
      senderOpenId: "ou_x",
      text: "",
      imageDataUris: ["data:image/png;base64,iVBOR..."],
      receivedAt: Date.now(),
    };
    expect(msg.imageDataUris?.[0]).toMatch(/^data:image\//);
  });
});
```

- [ ] **Step 3: Run the typechecker — expect failures in session.ts and gateway.ts**

Run: `pnpm typecheck`
Expected: FAIL with errors referring to `imageDataUri` in `src/claude/session.ts` and `src/feishu/gateway.ts`. Those are fixed in Tasks 4 and 5. Do not commit yet — leave the tree broken intentionally so Task 4/5 land together.

- [ ] **Step 4: Stage but don't commit**

```bash
git add src/types.ts test/unit/feishu/messages.test.ts
```

Proceed to Task 4 before committing.

---

## Task 4: Update `ClaudeSession` for an array of images

**Files:**
- Modify: `src/claude/session.ts:147,164,284,687-710,1090-1137`
- Modify: `test/unit/claude/context-mitigation.test.ts:107-112,269-272,382-385`

- [ ] **Step 1: Update `QueuedInput` (session.ts line 147)**

Replace line 147:

```typescript
  readonly imageDataUris?: readonly string[];
```

- [ ] **Step 2: Update `SubmitInput` (session.ts line 164)**

Replace line 164:

```typescript
  imageDataUris?: readonly string[];
```

- [ ] **Step 3: Update the spread in `submit()` (session.ts line 284)**

Replace line 284:

```typescript
      ...(input.imageDataUris ? { imageDataUris: input.imageDataUris } : {}),
```

- [ ] **Step 4: Rewrite `promptPreview` (session.ts lines 689-697)**

Replace the method body:

```typescript
  private promptPreview(input: QueuedInput): string {
    if (!input.imageDataUris || input.imageDataUris.length === 0) return input.text;

    const text =
      input.text === "[Image]" || input.text.trim().length === 0
        ? input.imageDataUris.length > 1
          ? "What is in these images?"
          : "What is in this image?"
        : input.text;
    return [text, ...input.imageDataUris].join("\n");
  }
```

- [ ] **Step 5: Rewrite `immediateRequestSummary` (session.ts lines 699-709)**

Replace the method body:

```typescript
  private immediateRequestSummary(input: QueuedInput): string {
    if (!input.imageDataUris || input.imageDataUris.length === 0) {
      return input.text.slice(0, 4_000);
    }

    const text =
      input.text === "[Image]" || input.text.trim().length === 0
        ? input.imageDataUris.length > 1
          ? "What is in these images?"
          : "What is in this image?"
        : input.text;
    const count = input.imageDataUris.length;
    const note = count === 1
      ? "[image attachment preserved for the next turn]"
      : `[${count} image attachments preserved for the next turn]`;
    return `${text}\n${note}`;
  }
```

- [ ] **Step 6: Rewrite `buildPrompt` (session.ts lines 1090-1137)**

Replace the whole method with:

```typescript
  private buildPrompt(
    input: QueuedInput,
  ): string | AsyncIterable<SDKUserMessage> {
    if (!input.imageDataUris || input.imageDataUris.length === 0) {
      return input.text;
    }

    const imageBlocks = input.imageDataUris.map((uri) => {
      const match = uri.match(/^data:(image\/[^;]+);base64,(.+)$/);
      const mediaType = (() => {
        switch (match?.[1]) {
          case "image/png":
          case "image/gif":
          case "image/webp":
            return match[1];
          default:
            return "image/jpeg";
        }
      })();
      const data = match?.[2] ?? uri;
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mediaType,
          data,
        },
      };
    });

    const text =
      input.text === "[Image]" || input.text.trim().length === 0
        ? input.imageDataUris.length > 1
          ? "What is in these images?"
          : "What is in this image?"
        : input.text;

    const message: SDKUserMessage["message"] = {
      role: "user",
      content: [...imageBlocks, { type: "text", text }],
    };

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          message,
          parent_tool_use_id: null,
        };
      },
    };
  }
```

- [ ] **Step 7: Update the test harness in `context-mitigation.test.ts`**

Replace lines 107-112 with:

```typescript
function runImageInput(text: string, imageDataUris: readonly string[]) {
  return {
    ...runInput(text),
    imageDataUris,
  };
}
```

Update the two call sites. Line 272:

```typescript
      runImageInput("describe image", [imageDataUri]),
```

Line 385:

```typescript
      runImageInput("describe image", [imageDataUri]),
```

- [ ] **Step 8: Run typecheck — expect only gateway.ts errors remaining**

Run: `pnpm typecheck`
Expected: FAIL — one remaining error in `src/feishu/gateway.ts` referring to `imageDataUri`. Session and tests are clean.

- [ ] **Step 9: Run the session tests to confirm the rename is consistent**

Run: `pnpm vitest run test/unit/claude/context-mitigation.test.ts`
Expected: PASS — all existing cases still green with the renamed field.

- [ ] **Step 10: Stage but don't commit (Task 5 finishes the rename)**

```bash
git add src/claude/session.ts test/unit/claude/context-mitigation.test.ts
```

---

## Task 5: Extract `translateReceiveEvent` from gateway.ts

**Files:**
- Create: `src/feishu/message-translator.ts`
- Modify: `src/feishu/gateway.ts:117-188`

This task is a pure refactor — no behavior change, no post support yet. It gives us a testable seam for Task 6.

- [ ] **Step 1: Create the translator module**

Create `src/feishu/message-translator.ts`:

```typescript
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
```

- [ ] **Step 2: Replace the body of `handleReceiveV1`**

Edit `src/feishu/gateway.ts` lines 117-188. Keep the dedup and access checks; delegate everything after to `translateReceiveEvent`. Remove the now-unused imports if any (check the `let imageDataUri` declaration is gone).

```typescript
  private async handleReceiveV1(event: ReceiveV1Event): Promise<void> {
    const log = this.logger.child({
      message_id: event.message.message_id,
      chat_id: event.message.chat_id,
    });

    if (this.dedup.check(event.message.message_id)) {
      log.debug("Duplicate message, skipping");
      return;
    }

    const decision = this.access.check(event.sender.sender_id.open_id);
    if (!decision.allowed) {
      log.warn(
        { open_id: event.sender.sender_id.open_id, action: decision.action },
        "Unauthorized sender",
      );
      return;
    }

    const incoming = await translateReceiveEvent(event, this.feishuClient, log);
    if (incoming === null) return;

    try {
      await this.onMessage(incoming);
    } catch (err) {
      log.error({ err }, "Message handler threw");
    }
  }
```

Add the import at the top of gateway.ts alongside the other `./` imports:

```typescript
import { translateReceiveEvent } from "./message-translator.js";
```

- [ ] **Step 3: Run the typechecker — should be clean**

Run: `pnpm typecheck`
Expected: PASS. The rename chain is closed.

- [ ] **Step 4: Run the whole suite to confirm no regression from the refactor**

Run: `pnpm vitest run`
Expected: PASS across the board (including the two tests updated in Tasks 3 and 4).

- [ ] **Step 5: Commit the rename + refactor together**

```bash
git add src/types.ts src/claude/session.ts src/feishu/gateway.ts src/feishu/message-translator.ts \
  test/unit/feishu/messages.test.ts test/unit/claude/context-mitigation.test.ts
git commit -m "refactor: rename imageDataUri to imageDataUris and extract translator"
```

---

## Task 6: Add `post` support in the translator (with tests)

**Files:**
- Modify: `src/feishu/message-translator.ts`
- Create: `test/unit/feishu/message-translator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/feishu/message-translator.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
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
```

- [ ] **Step 2: Run tests to verify the post-specific ones fail**

Run: `pnpm vitest run test/unit/feishu/message-translator.test.ts`
Expected: FAIL — the 6 post-message tests fail; the 4 regression tests pass (they hit the text/image/unsupported branches that already exist).

- [ ] **Step 3: Add the `post` branch to the translator**

Edit `src/feishu/message-translator.ts`. Add the import at the top:

```typescript
import { parsePost } from "./post-parser.js";
```

Insert the `post` branch between the `image` branch and the `else` in `translateReceiveEvent`:

```typescript
  } else if (msgType === "post") {
    let parsed;
    try {
      parsed = parsePost(event.message.content);
    } catch (err) {
      log.error({ err }, "Failed to parse post message content");
      return null;
    }
    text = parsed.text;

    if (parsed.imageKeys.length > 0) {
      try {
        const buffers = await Promise.all(
          parsed.imageKeys.map((k) =>
            client.downloadImage(event.message.message_id, k),
          ),
        );
        imageDataUris = buffers.map(
          (b) => `data:${detectImageMime(b)};base64,${b.toString("base64")}`,
        );
      } catch (err) {
        log.warn({ err }, "Failed to download post image — dropping message");
        return null;
      }
    }

    if (text.length === 0 && imageDataUris === undefined) {
      log.info("Empty post, dropping");
      return null;
    }
  } else {
```

The final `else` (the unsupported-type branch) is unchanged.

- [ ] **Step 4: Run translator tests to verify they all pass**

Run: `pnpm vitest run test/unit/feishu/message-translator.test.ts`
Expected: PASS — all 10 tests.

- [ ] **Step 5: Run the whole suite to confirm no wider regression**

Run: `pnpm vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/feishu/message-translator.ts test/unit/feishu/message-translator.test.ts
git commit -m "feat: translate Feishu post messages with inline images"
```

---

## Task 7: Thread `imageDataUris` from `onMessage` into `session.submit`

**Files:**
- Modify: `src/index.ts:787-795`

This fixes a pre-existing thread-through bug: today `msg.imageDataUri` (now `imageDataUris`) is set on `IncomingMessage` but never forwarded to `session.submit`, so even the standalone-image path was silently dropped before reaching the SDK. With the rename in place this is a one-line addition.

- [ ] **Step 1: Update the submit call**

Edit `src/index.ts` lines 787-795:

```typescript
      const outcome = await session.submit(
        {
          ...parsed,
          senderOpenId: msg.senderOpenId,
          parentMessageId: msg.messageId,
          ...(msg.imageDataUris ? { imageDataUris: msg.imageDataUris } : {}),
          locale,
        },
        emit,
      );
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "fix: forward image attachments from onMessage into session.submit"
```

---

## Task 8: Final verification (typecheck + lint + tests + manual smoke)

**Files:** none

- [ ] **Step 1: Run the full gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS, PASS, build succeeds.

- [ ] **Step 2: Manual smoke test**

Restart the running service (the user currently has PID 69188 running via `tsx src/index.ts`). Send three Feishu messages from an allowlisted sender:

1. A plain text message → should behave exactly as before.
2. A standalone image (paperclip → image) → Claude should now answer about the image.
3. A rich-text post: type something like "看这张图有什么异常？" then paste a PNG screenshot inline, send → Claude should see both the text and the image in one turn.

Confirm the log no longer prints `"Unsupported message type, dropping"` for case 3, and Claude's response references the image content.

- [ ] **Step 3: If all three cases work, nothing to commit. If bugs surface, open follow-up tasks — do not silently patch.**

---

## Self-Review (completed while writing)

- **Spec coverage:** Each spec section maps to a task — image-mime.ts → T1, post-parser.ts → T2, IncomingMessage rename → T3, session.ts propagation → T4, gateway post branch → T6 (with T5 as the extraction prerequisite), tests → tests are inline in each task. T7 fixes the index.ts thread-through bug discovered during exploration. T8 is the final gate.
- **Placeholder scan:** No "TBD", "TODO", or vague instructions. Every code block is complete.
- **Type consistency:** `imageDataUris` is `readonly string[]` everywhere it's declared (types.ts, SubmitInput, QueuedInput); `Promise<Buffer>` return type for `downloadImage` matches existing `src/feishu/client.ts` signature; `detectImageMime` returns `SupportedImageMime` used once by the translator and once by the internal MIME switch in buildPrompt (which widens via `image/${string}`, so the narrow type is fine).
- **Scope check:** Single coherent change: Feishu post support + correct MIME tagging + one latent bug fix in the same pipeline. No unrelated refactoring.

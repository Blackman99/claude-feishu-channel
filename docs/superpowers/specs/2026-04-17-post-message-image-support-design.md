# Feishu `post` message support (text + inline images)

Date: 2026-04-17
Status: approved, ready for implementation plan

## Problem

Feishu messages whose `message_type` is `post` currently hit the `else` branch at `src/feishu/gateway.ts:166-169` and log `"Unsupported message type, dropping"`. Posts are how Feishu delivers any message where the user typed text *and* embedded an image in the same turn — which is the most natural way users attach screenshots. The bot silently drops these instead of forwarding them to Claude.

A latent second issue: the existing standalone-`image` branch at `src/feishu/gateway.ts:160` hardcodes `data:image/jpeg;base64,…`, so PNG screenshots (the typical paste) are mis-tagged as JPEG when sent to the Claude API.

## Goals

- Accept `message_type === "post"` events.
- Flatten post content to plain text while preserving links, `@`-mentions, and emoji markers.
- Extract every inline `image_key`, download each, and forward all images to Claude in the same turn.
- Send every image with the correct MIME type (sniffed from the downloaded bytes), including from the existing standalone-image path.

## Non-goals

- `file`, `audio`, `video`, `media_group`, `sticker`, or any other message type. They continue to drop with the existing info log.
- Interleaving text and image blocks in the order they appeared inside the post — all text flattens to one string, all images become an ordered array.
- Partial delivery. If any image fails to download, the whole message is dropped.
- Persistence of queued inputs. (They live in memory today; unchanged.)

## Architecture

Add a `post` branch to `handleReceiveV1` in `src/feishu/gateway.ts:140-169`, alongside the existing `text` and `image` branches. Post parsing lives in a new pure module so the Feishu schema quirks are unit-testable in isolation, matching the pattern of `src/feishu/tool-result.ts`.

```
Feishu WS event
  └─> FeishuGateway.handleReceiveV1  (src/feishu/gateway.ts)
        ├── text branch  (unchanged)
        ├── image branch (unchanged logic; swap hardcoded MIME for sniffed MIME)
        └── post branch  (NEW)
              ├── post-parser.parsePost(rawContent)         → {text, imageKeys[]}
              ├── feishuClient.downloadImage(msgId, key)    × N  (existing)
              └── image-mime.detectImageMime(buffer)        × N  (NEW)
```

New files:
- `src/feishu/post-parser.ts` — pure flattener, no I/O.
- `src/feishu/image-mime.ts` — pure magic-byte sniffer, no I/O.

Modified files:
- `src/feishu/gateway.ts` — add `post` branch; use `detectImageMime` in both `image` and `post` branches.
- `src/types.ts` — rename `IncomingMessage.imageDataUri?: string` to `imageDataUris?: readonly string[]`.
- `src/claude/session.ts` — mirror the rename in `SubmitInput` and `QueuedInput`; rewrite `buildPrompt`, `promptPreview`, and `immediateRequestSummary` to iterate over an array.
- `test/unit/feishu/post-parser.test.ts` — new.
- `test/unit/feishu/image-mime.test.ts` — new.
- `test/unit/feishu/gateway.test.ts` — extend with post-event cases.
- `test/unit/claude/session.test.ts` — extend `buildPrompt` cases.

`src/persistence/state-store.ts` is untouched — queued inputs are not persisted.

## Data shape changes

**`IncomingMessage`** (`src/types.ts`):

```ts
// before
imageDataUri?: string;
// after
imageDataUris?: readonly string[];   // undefined OR non-empty; never []
```

**`SubmitInput` / `QueuedInput`** (`src/claude/session.ts:143-167`): same rename and type change, propagated through the optional-field spread pattern already used.

**`ClaudeSession.buildPrompt`** (`src/claude/session.ts:1090-1137`): loop over `imageDataUris`, emit one `{type: "image", source: {type: "base64", media_type, data}}` block per image (image blocks first), followed by one `{type: "text", text}` block. The empty-text fallback becomes `"What is in these images?"` (plural) when `imageDataUris.length > 1` and the fallback is otherwise reached.

**`promptPreview` / `immediateRequestSummary`** (`src/claude/session.ts:689-709`): iterate the array instead of the single field; the summary uses one line `"[${n} image attachments preserved for the next turn]"`.

## Post parsing rules

### Input schema

`event.message.content` is a JSON string:

```json
{
  "title": "optional title",
  "content": [
    [
      {"tag": "text", "text": "…", "un_escape": true},
      {"tag": "img", "image_key": "img_…"},
      {"tag": "a", "text": "…", "href": "…"},
      {"tag": "at", "user_id": "ou_…", "user_name": "…"},
      {"tag": "emotion", "emoji_type": "SMILE"}
    ],
    [ /* next paragraph */ ]
  ]
}
```

### Exported API

```ts
// src/feishu/post-parser.ts
export interface ParsedPost {
  text: string;          // paragraphs joined by "\n\n", trimmed
  imageKeys: string[];   // in document order; may be empty
}
export function parsePost(rawContent: string): ParsedPost;
```

### Flattening table

| Tag | Rendered as |
|---|---|
| `text` | `el.text` verbatim; if `un_escape === true`, decode common HTML entities (`&lt; &gt; &amp; &quot; &#39;`) |
| `a` | `` `${el.text} (${el.href})` `` |
| `at` | `` `@${el.user_name ?? el.user_id ?? "user"}` `` |
| `emotion` | `` `:${el.emoji_type}:` `` |
| `img` / `media` | push `image_key` to `imageKeys`; emit no text |
| anything else | skip silently — schema is forward-compatible |

- Paragraphs are joined with `"\n\n"`.
- Intra-paragraph elements are concatenated with no separator (they share a line).
- If `title` is present and non-empty, it is prepended as the first paragraph.
- Final `text` is `.trim()`ed before return.
- If JSON parsing fails or `content` is not an array, `parsePost` **throws**; the gateway catches.

### Gateway branch (pseudo)

```ts
} else if (msgType === "post") {
  let parsed: ParsedPost;
  try {
    parsed = parsePost(event.message.content);
  } catch (err) {
    log.error({ err }, "Failed to parse post message content");
    return;
  }
  text = parsed.text;

  if (parsed.imageKeys.length > 0) {
    try {
      const buffers = await Promise.all(
        parsed.imageKeys.map((k) =>
          this.feishuClient.downloadImage(event.message.message_id, k),
        ),
      );
      imageDataUris = buffers.map(
        (b) => `data:${detectImageMime(b)};base64,${b.toString("base64")}`,
      );
    } catch (err) {
      log.warn({ err }, "Failed to download post image — dropping message");
      return;
    }
  }

  if (text.length === 0 && imageDataUris === undefined) {
    log.info("Empty post, dropping");
    return;
  }
}
```

The existing `image` branch is updated to use `detectImageMime(imageBytes)` instead of hardcoding `image/jpeg`.

## MIME sniffing

```ts
// src/feishu/image-mime.ts
export function detectImageMime(
  buf: Buffer,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp";
```

Sniff magic bytes:

| Bytes (hex) | MIME |
|---|---|
| `89 50 4E 47` | `image/png` |
| `FF D8 FF` | `image/jpeg` |
| `47 49 46` | `image/gif` |
| `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` | `image/webp` |
| anything else | `image/jpeg` (fallback; log at `debug` from caller) |

No external dependency; pure byte check on the first ~12 bytes.

## Error handling

| Situation | Behavior |
|---|---|
| `JSON.parse` fails on post content | `log.error({err}, "Failed to parse post message content")` → drop (matches text branch at `src/feishu/gateway.ts:145`) |
| `parsePost` throws on malformed shape (non-array `content`, etc.) | same as above |
| Post flattens to zero text and zero images | `log.info("Empty post, dropping")` → drop |
| Any single `downloadImage` rejects | `log.warn({err}, "Failed to download post image — dropping message")` → drop whole message (parallels `src/feishu/gateway.ts:163`) |
| `detectImageMime` can't identify the buffer | return `image/jpeg`; caller logs at `debug` |
| Unknown inline post tag | skip silently |

## Tests

### New — `test/unit/feishu/post-parser.test.ts`

- Single paragraph with `text` + `a` + `at` + `emotion` flattens in order.
- Multiple paragraphs joined with `\n\n`.
- `img` tags pushed to `imageKeys` in document order; emit no text.
- `title` becomes leading paragraph when non-empty; absent/empty title omitted.
- Unknown tag is skipped (does not throw, does not appear in text).
- `un_escape: true` decodes `&lt; &gt; &amp; &quot; &#39;`.
- Malformed JSON throws.
- Missing `content` array throws.
- Post with only images (no text elements) returns empty string + populated `imageKeys`.

### New — `test/unit/feishu/image-mime.test.ts`

- PNG / JPEG / GIF / WebP magic bytes each return correct MIME.
- Short buffer (<12 bytes) → `image/jpeg` fallback.
- Random bytes → `image/jpeg` fallback.

### Extend — `test/unit/feishu/gateway.test.ts`

- Post event with 1 paragraph of text + 2 images produces `IncomingMessage` with flattened text and `imageDataUris.length === 2`; each URI's MIME matches the fake downloader's PNG/JPEG fixture bytes.
- Post event with text only → `imageDataUris === undefined`.
- Post event where 2nd `downloadImage` rejects → `onMessage` not called (dropped).
- Post event whose content is malformed JSON → `onMessage` not called, error logged.
- Existing: unknown message_type still drops with info log (regression guard).
- Existing standalone `image` event: `imageDataUris[0]` starts with `data:image/png` when the fake downloader returns PNG magic bytes (confirms MIME sniff is wired into the image branch too).

### Extend — `test/unit/claude/session.test.ts`

- `buildPrompt` with `imageDataUris.length === 2` emits content blocks in order `[image, image, text]`.
- `buildPrompt` with empty text + `imageDataUris.length === 2` falls back to text `"What is in these images?"`.
- `buildPrompt` with empty text + `imageDataUris.length === 1` still produces `"What is in this image?"` (singular, existing behavior preserved).
- `promptPreview` appends one URI per image.

## Migration / compatibility

- `IncomingMessage` is not persisted; no on-disk migration.
- `imageDataUri` (old) is renamed to `imageDataUris` (new). The rename is a compile-time break; all three source callsites (`src/types.ts`, `src/feishu/gateway.ts`, `src/claude/session.ts`) and related tests are updated in the same change.
- No config, no schema, no CLI flag changes.

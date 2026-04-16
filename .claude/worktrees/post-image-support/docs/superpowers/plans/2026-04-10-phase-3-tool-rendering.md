# Phase 3: Tool Call Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each task is a fresh subagent dispatch with the task text + file context + TDD steps copied verbatim. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream Claude's tool calls, tool results, thinking blocks, and turn stats to Feishu as separate, visually-distinct messages — replacing Phase 2's single concatenated text reply.

**Architecture:** ClaudeSession changes from a `Promise<string>` return to a streaming callback (`emit(event)`) that yields one `RenderEvent` per content block as SDK messages arrive. Consumer (`src/index.ts`) dispatches each event to the right Feishu method: `text` → `sendText`, `tool_use`/`tool_result` → `sendCard` (new), `thinking`/`turn_end` → styled `sendText`. Card rendering is split across pure helpers (truncation, tool-param formatting, card JSON builders) for tight TDD. A new `[render]` config block controls byte thresholds, thinking visibility, and turn-stat display — the whole block is optional with defaults, so existing config tests don't need patching.

**Tech Stack:** TypeScript strict, `@anthropic-ai/claude-agent-sdk` v0.2.98 (SDK content blocks: `text` / `thinking` / `tool_use` / tool-result-as-user-message), `@larksuiteoapi/node-sdk` v1.60.0 (`msg_type: "interactive"` with Card v2 element-based JSON, passed as untyped `JSON.stringify(card)`), vitest, zod v4, smol-toml.

**Out of scope (deferred):**
- Special-tool specialized rendering (TodoWrite checkbox inplace, ExitPlanMode approve button, Task subagent folding, AskUserQuestion button callbacks) — these need button callback infrastructure which arrives in Phase 5. Phase 3 renders them with the generic tool formatter.
- Permission request cards (`⚠️ 需要批准`) — Phase 5.
- Markdown → Feishu rich-post conversion for text blocks — Phase 8 polish. Phase 3 sends text blocks as plain text messages.
- File upload for tool_result > 20KB — Phase 8 or on-demand. Phase 3 just inline-truncates with an "(N more bytes omitted)" suffix.
- "Expand full content" interactive buttons — require card callback wiring which is Phase 5. Phase 3 has no expand buttons.
- Per-chat "send mutex" beyond the ClaudeSession mutex — Phase 2's mutex already serializes `handleMessage` calls, and within a single turn we sequentially `await` each send, so ordering is naturally preserved. No new primitive needed.

**Known tech facts (baked in from recon):**
- `@anthropic-ai/claude-agent-sdk` content block field names: `{type: "thinking", thinking: string, signature: string}` (field is `thinking`, NOT `text`), `{type: "tool_use", id, name, input: unknown}` (input is unknown — must validate per tool name), `{type: "tool_result", tool_use_id, is_error?, content?: string | Array<...>}` (content can be string OR array of blocks — handle both).
- `SDKResultSuccess` message carries `duration_ms: number`, `usage.input_tokens: number`, `usage.output_tokens: number`, `total_cost_usd: number` — Phase 3 uses duration + usage.
- Tool results arrive as SDK `user` messages (not `assistant`) whose `message.content` contains `tool_result` blocks.
- Lark `@larksuiteoapi/node-sdk` exports NO card types. Build our own TypeScript interface in `src/feishu/card-types.ts` and pass `content: JSON.stringify(card)` as an untyped string at the SDK boundary.
- Feishu Card v2 format: top-level `{version: "1.0", header: {title, color}, elements: [...]}`. `header.color` values: `green` / `red` / `yellow` / `blue` / `grey`. Markdown element: `{tag: "markdown", content: "..."}`. No native collapsible sections — for thinking/long-output we just inline-truncate.

---

## File structure

**New files:**
- `src/feishu/card-types.ts` — `FeishuCardV2` / `FeishuElement` / `FeishuHeader` interfaces (our own, since Lark SDK exports none)
- `src/feishu/truncate.ts` — `truncateForInline(text, maxBytes)` pure helper (UTF-8 byte-aware)
- `src/feishu/tool-formatters.ts` — `formatToolParams(name, input)` dispatch on tool name
- `src/feishu/tool-result.ts` — `extractToolResultText(content)` handling string | array forms
- `src/feishu/cards.ts` — `buildToolUseCard(block)` / `buildToolResultCard(params)` using the helpers above
- `src/feishu/messages.ts` — `formatThinkingText(text)` / `formatResultTip(stats)` / `formatErrorText(err)` plain-text formatters
- `src/feishu/render-event.ts` — `RenderEvent` tagged union type (shared between session and consumer)
- Tests for all of the above in `test/unit/feishu/<name>.test.ts`

**Modified files:**
- `src/config.ts` — add `RenderSchema` with all-optional fields + defaults, wire into `ConfigSchema`, map to camelCase in `loadConfig`
- `src/types.ts` — extend `AppConfig` with `render: {...}`
- `config.example.toml` — add `[render]` section with comments
- `src/claude/session.ts` — change `handleMessage` signature from `(text): Promise<string>` to `(text, emit): Promise<void>`, expand `SDKMessageLike` to cover `user` messages and `result` stats fields, emit one `RenderEvent` per content block
- `src/feishu/client.ts` — add `sendCard(chatId, card)` method mirroring `sendText`'s error handling
- `src/index.ts` — replace `handleMessage().then(sendText)` with an event dispatcher that routes each `RenderEvent` to the right client method, banner → "Phase 3 ready"
- `test/unit/claude/session.test.ts` — rewrite Phase 2's tests to assert on collected emit events instead of return value
- `README.md` — Phase 3 status, `[render]` config, what users now see

**Deleted files:**
- `src/feishu/renderer.ts` — `extractAssistantText` is no longer used (each text block is emitted as its own event)
- `test/unit/feishu/renderer.test.ts` — delete alongside

---

## Task 1: `[render]` config block

**Files:**
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `config.example.toml`
- Test: `test/unit/config.test.ts` (add new tests; do NOT modify `MINIMAL_CONFIG` — the `[render]` block is entirely optional with defaults)

**Design decision:** Unlike Phase 2's `[claude]` block, `[render]` is fully optional — every field has a sensible default, so existing config tests do not need patching. A config without `[render]` at all parses successfully.

- [ ] **Step 1: Write failing tests**

Append to `test/unit/config.test.ts` (add a new `describe` block before the closing bracket):

```typescript
describe("render config", () => {
  it("defaults to inline_max_bytes=2048, hide_thinking=false, show_turn_stats=true when [render] is absent", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"
`);
    const cfg = await loadConfig(path);
    expect(cfg.render.inlineMaxBytes).toBe(2048);
    expect(cfg.render.hideThinking).toBe(false);
    expect(cfg.render.showTurnStats).toBe(true);
  });

  it("accepts explicit [render] values", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"

[render]
inline_max_bytes = 512
hide_thinking = true
show_turn_stats = false
`);
    const cfg = await loadConfig(path);
    expect(cfg.render.inlineMaxBytes).toBe(512);
    expect(cfg.render.hideThinking).toBe(true);
    expect(cfg.render.showTurnStats).toBe(false);
  });

  it("rejects negative inline_max_bytes", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[claude]
default_cwd = "/tmp/cfc-test"

[render]
inline_max_bytes = -1
`);
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/unit/config.test.ts`
Expected: FAIL — `cfg.render` is undefined.

- [ ] **Step 3: Extend `AppConfig` in `src/types.ts`**

Add after the `claude` block (before `persistence`):

```typescript
  render: {
    /** Max bytes (UTF-8) of inline content in a card before truncation. */
    inlineMaxBytes: number;
    /** If true, skip thinking blocks entirely. */
    hideThinking: boolean;
    /** If true, send a stats tip ("✅ 12.3s · 1.2k in / 3.4k out") at turn end. */
    showTurnStats: boolean;
  };
```

- [ ] **Step 4: Add `RenderSchema` and wire it into `src/config.ts`**

Add below `ClaudeSchema`:

```typescript
const RenderSchema = z
  .object({
    inline_max_bytes: z.number().int().positive().default(2048),
    hide_thinking: z.boolean().default(false),
    show_turn_stats: z.boolean().default(true),
  })
  .default({
    inline_max_bytes: 2048,
    hide_thinking: false,
    show_turn_stats: true,
  });
```

Extend `ConfigSchema` to include it:

```typescript
const ConfigSchema = z.object({
  feishu: FeishuSchema,
  access: AccessSchema,
  claude: ClaudeSchema,
  render: RenderSchema,
  persistence: PersistenceSchema,
  logging: LoggingSchema,
});
```

Extend the return object in `loadConfig` (add before `persistence`):

```typescript
    render: {
      inlineMaxBytes: data.render.inline_max_bytes,
      hideThinking: data.render.hide_thinking,
      showTurnStats: data.render.show_turn_stats,
    },
```

- [ ] **Step 5: Run tests — should now pass**

Run: `pnpm test test/unit/config.test.ts`
Expected: PASS including the 3 new tests and all pre-existing tests (unchanged).

- [ ] **Step 6: Update `config.example.toml`**

Insert after the `[claude]` section:

```toml
# ─── Render / Feishu cards ───────────────────────────────────────────
[render]
# Max UTF-8 bytes of inline content (tool input params, tool output
# previews) shown in a card before we truncate and append
# "... (N more bytes omitted)".
inline_max_bytes = 2048

# If true, skip Claude's extended-thinking blocks entirely instead of
# sending them as 💭 messages.
hide_thinking = false

# If true, send a small "✅ 12.3s · 1.2k in / 3.4k out" tip after each
# turn. Disable if you find it noisy.
show_turn_stats = true
```

- [ ] **Step 7: Run full test suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 77+ tests pass (the existing 77 plus 3 new).

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/types.ts config.example.toml test/unit/config.test.ts
git commit -m "feat(config): add [render] section for card truncation + stat flags"
```

---

## Task 2: UTF-8 byte-aware truncation helper

**Files:**
- Create: `src/feishu/truncate.ts`
- Test: `test/unit/feishu/truncate.test.ts`

Pure function. No dependencies. Truncates strings by UTF-8 byte length (not character count — a CJK char is 3 bytes, an emoji is 4, and the Feishu card has a byte-based limit on element content). Must NOT split a multi-byte char in the middle.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { truncateForInline } from "../../../src/feishu/truncate.js";

describe("truncateForInline", () => {
  it("returns the input unchanged when within byte budget", () => {
    expect(truncateForInline("hello", 100)).toBe("hello");
  });

  it("returns the input unchanged at exactly the byte budget", () => {
    expect(truncateForInline("hello", 5)).toBe("hello");
  });

  it("truncates and appends an omitted-bytes suffix when over budget", () => {
    const input = "a".repeat(100);
    const out = truncateForInline(input, 20);
    // Byte length of preview part should be <= 20. Suffix is appended.
    expect(out).toMatch(/^a{20}\n… \(80 more bytes omitted\)$/);
  });

  it("counts UTF-8 bytes, not code units (CJK = 3 bytes each)", () => {
    // "你好" is 6 bytes, "世界" is 6 bytes — 12 bytes total.
    const input = "你好世界"; // 12 bytes
    // With budget 6 we should keep "你好" (6 bytes) and mark 6 omitted.
    expect(truncateForInline(input, 6)).toBe("你好\n… (6 more bytes omitted)");
  });

  it("never splits a multi-byte character in the middle", () => {
    // Budget of 4 bytes cannot fit a second "你" (would need 6). So only
    // "你" (3 bytes) is kept.
    const input = "你好"; // 6 bytes
    expect(truncateForInline(input, 4)).toBe("你\n… (3 more bytes omitted)");
  });

  it("handles emoji (4-byte UTF-8)", () => {
    const input = "🎉🎉🎉"; // 12 bytes
    // Budget 5 → only one 🎉 (4 bytes) fits.
    expect(truncateForInline(input, 5)).toBe("🎉\n… (8 more bytes omitted)");
  });

  it("returns empty string unchanged", () => {
    expect(truncateForInline("", 100)).toBe("");
  });

  it("throws on non-positive budget", () => {
    expect(() => truncateForInline("abc", 0)).toThrow();
    expect(() => truncateForInline("abc", -1)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `pnpm test test/unit/feishu/truncate.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement `src/feishu/truncate.ts`**

```typescript
/**
 * Truncate a string so its UTF-8 byte length does not exceed `maxBytes`.
 * When truncation happens, append "\n… (N more bytes omitted)" where N
 * is the byte count of the omitted suffix. The truncation boundary
 * never falls in the middle of a multi-byte character.
 *
 * Used to clip tool input / tool output for inline display inside
 * Feishu cards, which have a total content byte limit.
 */
export function truncateForInline(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    throw new Error(`truncateForInline: maxBytes must be positive (got ${maxBytes})`);
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;

  // Walk code points and accumulate bytes until we'd exceed the budget.
  let byteCount = 0;
  let kept = "";
  for (const ch of text) {
    const chBytes = encoder.encode(ch).length;
    if (byteCount + chBytes > maxBytes) break;
    byteCount += chBytes;
    kept += ch;
  }
  const omittedBytes = bytes.length - byteCount;
  return `${kept}\n… (${omittedBytes} more bytes omitted)`;
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `pnpm test test/unit/feishu/truncate.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/feishu/truncate.ts test/unit/feishu/truncate.test.ts
git commit -m "feat(feishu): add UTF-8 byte-aware truncation helper"
```

---

## Task 3: Per-tool input formatters

**Files:**
- Create: `src/feishu/tool-formatters.ts`
- Test: `test/unit/feishu/tool-formatters.test.ts`

Given a tool name and its unknown `input` object, produce a short, human-readable summary string per spec §7.3. Since `input` is typed as `unknown` by the SDK, each case must validate defensively before pulling fields out.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { formatToolParams } from "../../../src/feishu/tool-formatters.js";

describe("formatToolParams", () => {
  describe("Read", () => {
    it("formats path + line range", () => {
      expect(formatToolParams("Read", { file_path: "src/app.ts", offset: 42, limit: 39 }))
        .toBe("src/app.ts:42-80");
    });

    it("formats path without line range", () => {
      expect(formatToolParams("Read", { file_path: "src/app.ts" }))
        .toBe("src/app.ts");
    });

    it("formats path with offset only", () => {
      expect(formatToolParams("Read", { file_path: "src/app.ts", offset: 10 }))
        .toBe("src/app.ts:10-");
    });
  });

  describe("Edit", () => {
    it("formats just file_path (diff stats not available at call site)", () => {
      expect(formatToolParams("Edit", {
        file_path: "src/app.ts",
        old_string: "foo",
        new_string: "bar",
      })).toBe("src/app.ts");
    });
  });

  describe("Write", () => {
    it("formats path + content byte length", () => {
      expect(formatToolParams("Write", {
        file_path: "out.txt",
        content: "hello world",
      })).toBe("out.txt (11 bytes)");
    });
  });

  describe("Bash", () => {
    it("formats command with $ prefix", () => {
      expect(formatToolParams("Bash", { command: "npm test" }))
        .toBe("$ npm test");
    });

    it("truncates commands over 80 chars", () => {
      const cmd = "echo " + "x".repeat(100);
      const out = formatToolParams("Bash", { command: cmd });
      expect(out.startsWith("$ ")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(80 + 2 /* "$ " */ + 1 /* ellipsis */);
      expect(out.endsWith("…")).toBe(true);
    });
  });

  describe("Grep", () => {
    it("formats pattern + glob", () => {
      expect(formatToolParams("Grep", {
        pattern: "TODO",
        glob: "*.ts",
      })).toBe('"TODO" in *.ts');
    });

    it("formats pattern alone when no glob", () => {
      expect(formatToolParams("Grep", { pattern: "TODO" }))
        .toBe('"TODO"');
    });
  });

  describe("default fallback", () => {
    it("returns single-line JSON for unknown tools", () => {
      expect(formatToolParams("WeirdTool", { a: 1, b: "x" }))
        .toBe('{"a":1,"b":"x"}');
    });

    it("truncates very long JSON", () => {
      const big = { data: "x".repeat(500) };
      const out = formatToolParams("WeirdTool", big);
      expect(out.length).toBeLessThanOrEqual(200);
    });

    it("handles malformed input (non-object) gracefully", () => {
      expect(formatToolParams("WeirdTool", null)).toBe("null");
      expect(formatToolParams("WeirdTool", 42)).toBe("42");
      expect(formatToolParams("WeirdTool", "string input")).toBe('"string input"');
    });
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `pnpm test test/unit/feishu/tool-formatters.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement `src/feishu/tool-formatters.ts`**

```typescript
/**
 * Format a Claude tool's `input` object into a short human summary
 * per spec §7.3. Tool `input` is typed `unknown` by the SDK because it
 * is schema-driven — every case below validates fields defensively.
 */
export function formatToolParams(name: string, input: unknown): string {
  const obj = isRecord(input) ? input : null;

  switch (name) {
    case "Read":
      return formatRead(obj);
    case "Edit":
      return formatEdit(obj);
    case "Write":
      return formatWrite(obj);
    case "Bash":
      return formatBash(obj);
    case "Grep":
      return formatGrep(obj);
    default:
      return formatDefault(input);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatRead(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  const file = typeof obj["file_path"] === "string" ? obj["file_path"] : "?";
  const offset = typeof obj["offset"] === "number" ? obj["offset"] : undefined;
  const limit = typeof obj["limit"] === "number" ? obj["limit"] : undefined;
  if (offset === undefined && limit === undefined) return file;
  if (offset !== undefined && limit !== undefined) {
    return `${file}:${offset}-${offset + limit - 1}`;
  }
  if (offset !== undefined) return `${file}:${offset}-`;
  return `${file}:-${limit}`;
}

function formatEdit(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  return typeof obj["file_path"] === "string" ? obj["file_path"] : "?";
}

function formatWrite(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  const file = typeof obj["file_path"] === "string" ? obj["file_path"] : "?";
  const content = typeof obj["content"] === "string" ? obj["content"] : "";
  const bytes = new TextEncoder().encode(content).length;
  return `${file} (${bytes} bytes)`;
}

const BASH_MAX = 80;

function formatBash(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  const cmd = typeof obj["command"] === "string" ? obj["command"] : "?";
  if (cmd.length <= BASH_MAX) return `$ ${cmd}`;
  return `$ ${cmd.slice(0, BASH_MAX)}…`;
}

function formatGrep(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  const pattern = typeof obj["pattern"] === "string" ? obj["pattern"] : "?";
  const glob = typeof obj["glob"] === "string" ? obj["glob"] : undefined;
  return glob ? `"${pattern}" in ${glob}` : `"${pattern}"`;
}

const DEFAULT_MAX = 200;

function formatDefault(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (s.length > DEFAULT_MAX) return s.slice(0, DEFAULT_MAX - 1) + "…";
  return s;
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `pnpm test test/unit/feishu/tool-formatters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/tool-formatters.ts test/unit/feishu/tool-formatters.test.ts
git commit -m "feat(feishu): add per-tool input formatters (Read/Edit/Write/Bash/Grep)"
```

---

## Task 4: Tool result content extractor

**Files:**
- Create: `src/feishu/tool-result.ts`
- Test: `test/unit/feishu/tool-result.test.ts`

A tool_result block's `content` field can be **either** a string **or** an array of mixed content blocks (text, image, etc.). Extract a single string representation so the card can display something.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { extractToolResultText } from "../../../src/feishu/tool-result.js";

describe("extractToolResultText", () => {
  it("returns a string content as-is", () => {
    expect(extractToolResultText("hello output")).toBe("hello output");
  });

  it("returns empty string for undefined content", () => {
    expect(extractToolResultText(undefined)).toBe("");
  });

  it("joins text blocks from an array with newlines", () => {
    expect(extractToolResultText([
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ])).toBe("line one\nline two");
  });

  it("replaces image blocks with a placeholder", () => {
    expect(extractToolResultText([
      { type: "text", text: "here:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
    ])).toBe("here:\n[image]");
  });

  it("replaces unknown block types with a placeholder", () => {
    expect(extractToolResultText([
      { type: "text", text: "ok" },
      { type: "widget_frobnicator" },
    ])).toBe("ok\n[widget_frobnicator]");
  });

  it("returns empty string for empty array", () => {
    expect(extractToolResultText([])).toBe("");
  });

  it("skips text blocks with no text field", () => {
    expect(extractToolResultText([
      { type: "text", text: "keep" },
      { type: "text" },
      { type: "text", text: "also keep" },
    ])).toBe("keep\nalso keep");
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `pnpm test test/unit/feishu/tool-result.test.ts`
Expected: FAIL — file missing.

- [ ] **Step 3: Implement `src/feishu/tool-result.ts`**

```typescript
/**
 * Shallow structural type of a tool_result content block. The real
 * SDK type is a broader union from @anthropic-ai/sdk; we only narrow
 * on fields we render.
 */
export interface ToolResultBlock {
  type: string;
  text?: string;
}

/**
 * Flatten a `tool_result` block's `content` into a single display string.
 * The SDK allows content to be either a raw string OR an array of
 * content blocks (text, image, etc.). Non-text blocks are replaced with
 * a `[blockType]` placeholder so the card always has *something* to show.
 */
export function extractToolResultText(
  content: string | readonly ToolResultBlock[] | undefined,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else {
      parts.push(`[${block.type}]`);
    }
  }
  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `pnpm test test/unit/feishu/tool-result.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/tool-result.ts test/unit/feishu/tool-result.test.ts
git commit -m "feat(feishu): extract tool_result content into a display string"
```

---

## Task 5: Feishu card type definitions + card builders

**Files:**
- Create: `src/feishu/card-types.ts`
- Create: `src/feishu/cards.ts`
- Test: `test/unit/feishu/cards.test.ts`

The Lark SDK exports no card types — we define our own narrow TypeScript interface that matches Feishu Card v2, then build two cards: one for tool_use and one for tool_result. Both use the formatters + truncation helpers from the earlier tasks.

- [ ] **Step 1: Create `src/feishu/card-types.ts` (pure types, no logic)**

```typescript
/**
 * Narrow TypeScript interface for Feishu Card v2 JSON. The Lark Node
 * SDK does not export any card types, so we define exactly the subset
 * Phase 3 needs and pass card objects to the SDK as
 * `JSON.stringify(card)`.
 *
 * Reference: Feishu open-platform docs, "消息卡片 v2 元素级"
 */
export interface FeishuCardV2 {
  version: "1.0";
  header?: FeishuHeader;
  elements: FeishuElement[];
}

export interface FeishuHeader {
  title: { content: string; tag: "plain_text" };
  subtitle?: { content: string; tag: "plain_text" };
  /** `green` | `red` | `yellow` | `blue` | `grey` (+ others). */
  template?: FeishuHeaderColor;
}

export type FeishuHeaderColor =
  | "green"
  | "red"
  | "yellow"
  | "blue"
  | "grey";

export type FeishuElement =
  | FeishuMarkdownElement
  | FeishuDividerElement;

export interface FeishuMarkdownElement {
  tag: "markdown";
  content: string;
}

export interface FeishuDividerElement {
  tag: "hr";
}
```

Note: we use `template` (not `color`) in header — that's the correct Card v2 field name for header color. The recon mentioned `color` in the raw JSON, but the official field per Feishu docs is `template` for 色板 styles on card v2 headers. The implementer should verify by checking an actual Feishu card JSON or Lark SDK examples at implementation time — if the real field is `color`, rename throughout this task.

- [ ] **Step 2: Write failing tests for `cards.ts`**

Create `test/unit/feishu/cards.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildToolUseCard,
  buildToolResultCard,
} from "../../../src/feishu/cards.js";

describe("buildToolUseCard", () => {
  it("renders a blue-header card with tool name and param summary", () => {
    const card = buildToolUseCard(
      { id: "tu_1", name: "Bash", input: { command: "npm test" } },
      { inlineMaxBytes: 2048 },
    );
    expect(card.version).toBe("1.0");
    expect(card.header?.title.content).toBe("🔧 Bash");
    expect(card.header?.template).toBe("blue");
    // Body should mention the command summary.
    const bodyText = card.elements
      .filter((e): e is { tag: "markdown"; content: string } => e.tag === "markdown")
      .map((e) => e.content)
      .join("\n");
    expect(bodyText).toContain("$ npm test");
  });

  it("uses the per-tool formatter (Read → path:start-end)", () => {
    const card = buildToolUseCard(
      { id: "tu_2", name: "Read", input: { file_path: "src/a.ts", offset: 1, limit: 10 } },
      { inlineMaxBytes: 2048 },
    );
    const body = (card.elements[0] as { content: string }).content;
    expect(body).toContain("src/a.ts:1-10");
  });

  it("truncates inline body at inlineMaxBytes", () => {
    const hugeInput = { data: "x".repeat(10000) };
    const card = buildToolUseCard(
      { id: "tu_3", name: "WeirdTool", input: hugeInput },
      { inlineMaxBytes: 100 },
    );
    const body = (card.elements[0] as { content: string }).content;
    // Body should be at most ~100 bytes plus the "(N more bytes omitted)" footer.
    expect(body).toContain("more bytes omitted");
  });
});

describe("buildToolResultCard", () => {
  it("renders a green-header card on success", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "42 files changed",
      inlineMaxBytes: 2048,
    });
    expect(card.header?.title.content).toBe("✅ Result");
    expect(card.header?.template).toBe("green");
    expect((card.elements[0] as { content: string }).content).toContain("42 files changed");
  });

  it("renders a red-header card on error", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: true,
      text: "Permission denied",
      inlineMaxBytes: 2048,
    });
    expect(card.header?.title.content).toBe("❌ Error");
    expect(card.header?.template).toBe("red");
    expect((card.elements[0] as { content: string }).content).toContain("Permission denied");
  });

  it("truncates long output", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "x".repeat(10000),
      inlineMaxBytes: 100,
    });
    const body = (card.elements[0] as { content: string }).content;
    expect(body).toContain("more bytes omitted");
  });

  it("shows an empty placeholder when result text is blank", () => {
    const card = buildToolResultCard({
      toolUseId: "tu_1",
      isError: false,
      text: "",
      inlineMaxBytes: 2048,
    });
    const body = (card.elements[0] as { content: string }).content;
    expect(body).toBe("_(no output)_");
  });
});
```

- [ ] **Step 3: Run tests — should fail**

Run: `pnpm test test/unit/feishu/cards.test.ts`
Expected: FAIL — files missing.

- [ ] **Step 4: Implement `src/feishu/cards.ts`**

```typescript
import type { FeishuCardV2 } from "./card-types.js";
import { formatToolParams } from "./tool-formatters.js";
import { truncateForInline } from "./truncate.js";

export interface ToolUseBlockInput {
  id: string;
  name: string;
  input: unknown;
}

export interface CardRenderConfig {
  inlineMaxBytes: number;
}

/**
 * Build a Feishu Card v2 JSON representing a Claude tool_use block.
 * Header: 🔧 <ToolName> with blue template. Body: per-tool param summary,
 * truncated to `inlineMaxBytes`.
 */
export function buildToolUseCard(
  block: ToolUseBlockInput,
  config: CardRenderConfig,
): FeishuCardV2 {
  const summary = formatToolParams(block.name, block.input);
  const body = truncateForInline(summary, config.inlineMaxBytes);
  return {
    version: "1.0",
    header: {
      title: { content: `🔧 ${block.name}`, tag: "plain_text" },
      template: "blue",
    },
    elements: [{ tag: "markdown", content: body }],
  };
}

export interface ToolResultCardParams {
  toolUseId: string;
  isError: boolean;
  text: string;
  inlineMaxBytes: number;
}

/**
 * Build a Feishu Card v2 JSON representing a tool_result. Green header
 * on success, red on error. Body is the extracted result text,
 * truncated to `inlineMaxBytes`.
 */
export function buildToolResultCard(params: ToolResultCardParams): FeishuCardV2 {
  const headerTitle = params.isError ? "❌ Error" : "✅ Result";
  const template = params.isError ? "red" : "green";
  const body =
    params.text.length === 0
      ? "_(no output)_"
      : truncateForInline(params.text, params.inlineMaxBytes);
  return {
    version: "1.0",
    header: {
      title: { content: headerTitle, tag: "plain_text" },
      template,
    },
    elements: [{ tag: "markdown", content: body }],
  };
}
```

- [ ] **Step 5: Run tests — should pass**

Run: `pnpm test test/unit/feishu/cards.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/feishu/card-types.ts src/feishu/cards.ts test/unit/feishu/cards.test.ts
git commit -m "feat(feishu): tool_use / tool_result card builders"
```

---

## Task 6: Plain-text formatters (thinking, turn stats, error)

**Files:**
- Create: `src/feishu/messages.ts`
- Test: `test/unit/feishu/messages.test.ts`

Some render events become styled plain-text messages, not cards:
- Thinking → `"💭 思考过程\n\n<text>"`
- Turn stats → `"✅ 本轮耗时 5.2s · 输入 1.2k / 输出 3.4k tokens"`
- Error → `"❌ <message>"`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import {
  formatThinkingText,
  formatResultTip,
  formatErrorText,
} from "../../../src/feishu/messages.js";

describe("formatThinkingText", () => {
  it("prepends the 💭 header", () => {
    expect(formatThinkingText("I should check the docs first"))
      .toBe("💭 思考过程\n\nI should check the docs first");
  });

  it("handles empty input", () => {
    expect(formatThinkingText("")).toBe("💭 思考过程\n\n");
  });
});

describe("formatResultTip", () => {
  it("formats duration + token usage", () => {
    expect(formatResultTip({
      durationMs: 5234,
      inputTokens: 1200,
      outputTokens: 3400,
    })).toBe("✅ 本轮耗时 5.2s · 输入 1.2k / 输出 3.4k tokens");
  });

  it("formats sub-second duration", () => {
    expect(formatResultTip({
      durationMs: 450,
      inputTokens: 100,
      outputTokens: 50,
    })).toBe("✅ 本轮耗时 0.5s · 输入 100 / 输出 50 tokens");
  });

  it("formats long duration (> 60s) as seconds", () => {
    expect(formatResultTip({
      durationMs: 125_000,
      inputTokens: 5000,
      outputTokens: 2000,
    })).toBe("✅ 本轮耗时 125.0s · 输入 5.0k / 输出 2.0k tokens");
  });

  it("does not use k suffix below 1000", () => {
    expect(formatResultTip({
      durationMs: 1000,
      inputTokens: 999,
      outputTokens: 1,
    })).toBe("✅ 本轮耗时 1.0s · 输入 999 / 输出 1 tokens");
  });
});

describe("formatErrorText", () => {
  it("prepends the ❌ marker", () => {
    expect(formatErrorText("boom")).toBe("❌ 错误: boom");
  });

  it("handles multiline errors", () => {
    expect(formatErrorText("line one\nline two"))
      .toBe("❌ 错误: line one\nline two");
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `pnpm test test/unit/feishu/messages.test.ts`
Expected: FAIL — file missing.

- [ ] **Step 3: Implement `src/feishu/messages.ts`**

```typescript
export function formatThinkingText(text: string): string {
  return `💭 思考过程\n\n${text}`;
}

export interface ResultTipStats {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export function formatResultTip(stats: ResultTipStats): string {
  const seconds = (stats.durationMs / 1000).toFixed(1);
  const input = formatTokenCount(stats.inputTokens);
  const output = formatTokenCount(stats.outputTokens);
  return `✅ 本轮耗时 ${seconds}s · 输入 ${input} / 输出 ${output} tokens`;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatErrorText(message: string): string {
  return `❌ 错误: ${message}`;
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `pnpm test test/unit/feishu/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/messages.ts test/unit/feishu/messages.test.ts
git commit -m "feat(feishu): thinking / turn-stats / error text formatters"
```

---

## Task 7: `FeishuClient.sendCard`

**Files:**
- Modify: `src/feishu/client.ts`
- Test: `test/unit/feishu/client.test.ts` (create new — there's no existing test file for `FeishuClient`; if there IS one, add to it instead)

Mirror `sendText`'s error-handling contract: throw on non-zero response code, throw on missing `message_id`, return `{messageId}` on success. Use a mock `LarkClient` for tests.

- [ ] **Step 1: Write failing tests**

If `test/unit/feishu/client.test.ts` already exists, append to its `describe` block. Otherwise create:

```typescript
import { describe, it, expect, vi } from "vitest";
import { FeishuClient } from "../../../src/feishu/client.js";

function makeFakeLark(
  createImpl: (args: unknown) => unknown,
): { client: unknown; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(createImpl);
  return {
    client: { im: { v1: { message: { create } } } },
    create,
  };
}

describe("FeishuClient.sendCard", () => {
  it("posts msg_type=interactive with JSON-stringified card content", async () => {
    const { client, create } = makeFakeLark(() => ({
      code: 0,
      data: { message_id: "om_abc" },
    }));
    const fc = new FeishuClient(client as never);
    const card = {
      version: "1.0" as const,
      elements: [{ tag: "markdown" as const, content: "hi" }],
    };
    const res = await fc.sendCard("oc_x", card);
    expect(res.messageId).toBe("om_abc");
    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0]![0] as {
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
    const { client } = makeFakeLark(() => ({ code: 99991663, msg: "too busy" }));
    const fc = new FeishuClient(client as never);
    await expect(
      fc.sendCard("oc_x", { version: "1.0", elements: [] }),
    ).rejects.toThrow(/99991663.*too busy/);
  });

  it("throws on code=0 but missing message_id", async () => {
    const { client } = makeFakeLark(() => ({ code: 0, data: {} }));
    const fc = new FeishuClient(client as never);
    await expect(
      fc.sendCard("oc_x", { version: "1.0", elements: [] }),
    ).rejects.toThrow(/no message_id/);
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `pnpm test test/unit/feishu/client.test.ts`
Expected: FAIL — `sendCard` doesn't exist yet.

- [ ] **Step 3: Add `sendCard` to `src/feishu/client.ts`**

At the top of the file, add the card-types import:

```typescript
import type { FeishuCardV2 } from "./card-types.js";
```

Add a method on `FeishuClient`:

```typescript
async sendCard(
  chatId: string,
  card: FeishuCardV2,
): Promise<SendTextResult> {
  const response = await this.lark.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });

  if (response.code !== 0) {
    throw new Error(
      `Feishu sendCard failed: code=${response.code} msg=${response.msg ?? ""}`,
    );
  }

  const messageId = response.data?.message_id;
  if (!messageId) {
    throw new Error(
      `Feishu sendCard returned code=0 but no message_id (chatId=${chatId})`,
    );
  }

  return { messageId };
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `pnpm test test/unit/feishu/client.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/client.ts test/unit/feishu/client.test.ts
git commit -m "feat(feishu): FeishuClient.sendCard for interactive messages"
```

---

## Task 8: `RenderEvent` type + ClaudeSession streaming refactor

**Files:**
- Create: `src/claude/render-event.ts`
- Modify: `src/claude/session.ts`
- Modify: `test/unit/claude/session.test.ts` (rewrite existing tests — they currently assert on string return; they must now assert on collected emit events)

This is the biggest task. ClaudeSession's `handleMessage` changes from `(text): Promise<string>` to `(text, emit): Promise<void>`, where `emit` is an async callback that receives one `RenderEvent` per content block. The mutex still wraps the entire body. The test rewrite is mechanical but substantial.

- [ ] **Step 1: Create `src/claude/render-event.ts`**

```typescript
/**
 * One renderable event emitted by ClaudeSession as it walks the SDK
 * message stream. The consumer (src/index.ts) dispatches each event to
 * the appropriate Feishu client method:
 *   text         → sendText
 *   thinking     → sendText (with 💭 prefix, gated by render.hideThinking)
 *   tool_use     → sendCard(buildToolUseCard)
 *   tool_result  → sendCard(buildToolResultCard)
 *   turn_end     → sendText (turn stats, gated by render.showTurnStats)
 *
 * Turn-level errors are NOT emitted — handleMessage throws instead, and
 * the consumer catches & sends an error text message.
 */
export type RenderEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "turn_end"; durationMs: number; inputTokens: number; outputTokens: number };
```

- [ ] **Step 2: Write the failing session tests**

Rewrite `test/unit/claude/session.test.ts` completely. The 7 existing tests become these (same coverage, new assertions):

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  ClaudeSession,
  type QueryFn,
  type SDKMessageLike,
} from "../../../src/claude/session.js";
import type { RenderEvent } from "../../../src/claude/render-event.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
};

function fakeQueryReturning(msgs: SDKMessageLike[]): QueryFn {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m;
    },
  });
}

function collectEvents(
  queryFn: QueryFn,
  prompt = "hi",
): { session: ClaudeSession; run: () => Promise<RenderEvent[]> } {
  const session = new ClaudeSession({
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    logger: SILENT_LOGGER,
  });
  const run = async (): Promise<RenderEvent[]> => {
    const events: RenderEvent[] = [];
    await session.handleMessage(prompt, async (e) => {
      events.push(e);
    });
    return events;
  };
  return { session, run };
}

describe("ClaudeSession", () => {
  it("emits one text event per text block on a successful turn", async () => {
    const queryFn = fakeQueryReturning([
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "part one\npart two",
        duration_ms: 1234,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);
    const { run } = collectEvents(queryFn);
    const events = await run();
    expect(events).toEqual([
      { type: "text", text: "part one" },
      { type: "text", text: "part two" },
      { type: "turn_end", durationMs: 1234, inputTokens: 100, outputTokens: 50 },
    ]);
  });

  it("emits a thinking event with the `thinking` field (not `text`)", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me think...", signature: "sig" },
            { type: "text", text: "answer" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 100,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events).toEqual([
      { type: "thinking", text: "let me think..." },
      { type: "text", text: "answer" },
      { type: "turn_end", durationMs: 100, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("emits a tool_use event with id, name, input", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 50,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events).toContainEqual({
      type: "tool_use",
      id: "tu_1",
      name: "Bash",
      input: { command: "ls" },
    });
  });

  it("emits a tool_result event from a user-type SDK message", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              is_error: false,
              content: "42 files",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 50,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tu_1",
      isError: false,
      text: "42 files",
    });
  });

  it("emits tool_result with isError=true on error flag", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_2",
              is_error: true,
              content: "permission denied",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events.find((e) => e.type === "tool_result")).toEqual({
      type: "tool_result",
      toolUseId: "tu_2",
      isError: true,
      text: "permission denied",
    });
  });

  it("handles tool_result content as an array of blocks", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_3",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const events = await collectEvents(queryFn).run();
    expect(events.find((e) => e.type === "tool_result")).toEqual({
      type: "tool_result",
      toolUseId: "tu_3",
      isError: false,
      text: "line 1\nline 2",
    });
  });

  it("throws when result subtype is an error", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom", "kaboom"],
      },
    ]);
    const { run } = collectEvents(queryFn);
    await expect(run()).rejects.toThrow(/boom.*kaboom/);
  });

  it("throws when the iterator ends without a result", async () => {
    const queryFn = fakeQueryReturning([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "oops" }] },
      },
    ]);
    const { run } = collectEvents(queryFn);
    await expect(run()).rejects.toThrow(/without a result/);
  });

  it("passes cwd, model, permissionMode, and settingSources to queryFn", async () => {
    const queryFn = vi.fn<QueryFn>(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "ok" }] },
        } satisfies SDKMessageLike;
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
        } satisfies SDKMessageLike;
      },
    }));
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: {
        defaultCwd: "/a/b",
        defaultPermissionMode: "acceptEdits",
        defaultModel: "claude-sonnet-4-6",
      },
      queryFn,
      logger: SILENT_LOGGER,
    });
    await session.handleMessage("hi", async () => {});
    expect(queryFn).toHaveBeenCalledOnce();
    const call = queryFn.mock.calls[0]![0];
    expect(call.prompt).toBe("hi");
    expect(call.options.cwd).toBe("/a/b");
    expect(call.options.model).toBe("claude-sonnet-4-6");
    expect(call.options.permissionMode).toBe("acceptEdits");
    expect(call.options.settingSources).toEqual(["project"]);
  });

  it("serializes concurrent handleMessage calls via the mutex", async () => {
    const events: string[] = [];
    let release1!: () => void;
    const gate1 = new Promise<void>((r) => (release1 = r));
    let callCount = 0;
    const queryFn: QueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        callCount += 1;
        const label = callCount === 1 ? "A" : "B";
        events.push(`${label}:start`);
        if (label === "A") await gate1;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: label }] },
        } as SDKMessageLike;
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        } as SDKMessageLike;
        events.push(`${label}:end`);
      },
    });
    const session = new ClaudeSession({
      chatId: "oc_x",
      config: BASE_CLAUDE_CONFIG,
      queryFn,
      logger: SILENT_LOGGER,
    });
    const p1 = session.handleMessage("first", async () => {});
    const p2 = session.handleMessage("second", async () => {});
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["A:start"]);
    release1();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });
});
```

- [ ] **Step 3: Run tests — should fail**

Run: `pnpm test test/unit/claude/session.test.ts`
Expected: FAIL — `handleMessage` signature mismatch, `SDKMessageLike` missing fields.

- [ ] **Step 4: Rewrite `src/claude/session.ts`**

```typescript
import type { Logger } from "pino";
import { Mutex } from "../util/mutex.js";
import type { AppConfig } from "../types.js";
import type { RenderEvent } from "./render-event.js";
import { extractToolResultText, type ToolResultBlock } from "../feishu/tool-result.js";

/**
 * Shallow structural subset of `@anthropic-ai/claude-agent-sdk`'s `SDKMessage`
 * union. Phase 3 narrows on the fields we read to dispatch RenderEvents.
 */
export interface SDKMessageLike {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: readonly SDKContentBlock[] };
  result?: string;
  errors?: readonly string[];
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface SDKContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | readonly ToolResultBlock[];
}

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  permissionMode: AppConfig["claude"]["defaultPermissionMode"];
  settingSources: readonly ("project" | "user" | "local")[];
}

export type QueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
}) => AsyncIterable<SDKMessageLike>;

export interface ClaudeSessionOptions {
  chatId: string;
  config: AppConfig["claude"];
  queryFn: QueryFn;
  logger: Logger;
}

export type RenderEventEmitter = (event: RenderEvent) => Promise<void>;

/**
 * Phase 3 ClaudeSession: streams RenderEvents as SDK messages arrive,
 * so the consumer can send each content block to Feishu as its own
 * message / card. Still single-turn (no cross-message resume). A per-
 * instance Mutex serializes concurrent handleMessage calls for the
 * same chat.
 */
export class ClaudeSession {
  private readonly config: AppConfig["claude"];
  private readonly queryFn: QueryFn;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();

  constructor(opts: ClaudeSessionOptions) {
    this.config = opts.config;
    this.queryFn = opts.queryFn;
    this.logger = opts.logger.child({ chat_id: opts.chatId });
  }

  async handleMessage(
    text: string,
    emit: RenderEventEmitter,
  ): Promise<void> {
    await this.mutex.run(async () => {
      this.logger.info({ len: text.length }, "Claude turn start");
      const iter = this.queryFn({
        prompt: text,
        options: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode: this.config.defaultPermissionMode,
          settingSources: ["project"],
        },
      });

      let resultMsg: SDKMessageLike | undefined;
      for await (const msg of iter) {
        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            await this.emitAssistantBlock(block, emit);
          }
        } else if (msg.type === "user" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "tool_result") {
              await emit({
                type: "tool_result",
                toolUseId: block.tool_use_id ?? "",
                isError: block.is_error === true,
                text: extractToolResultText(block.content),
              });
            }
          }
        } else if (msg.type === "result") {
          resultMsg = msg;
          // Do NOT break here — let the generator finish naturally.
        }
      }

      if (resultMsg === undefined) {
        throw new Error("Claude turn ended without a result message");
      }
      if (resultMsg.subtype !== "success") {
        const errs = resultMsg.errors?.join("; ") ?? "unknown error";
        this.logger.error(
          { subtype: resultMsg.subtype, errors: resultMsg.errors },
          "Claude turn errored",
        );
        throw new Error(`Claude turn failed (${resultMsg.subtype}): ${errs}`);
      }

      await emit({
        type: "turn_end",
        durationMs: resultMsg.duration_ms ?? 0,
        inputTokens: resultMsg.usage?.input_tokens ?? 0,
        outputTokens: resultMsg.usage?.output_tokens ?? 0,
      });
      this.logger.info(
        { durationMs: resultMsg.duration_ms },
        "Claude turn complete",
      );
    });
  }

  private async emitAssistantBlock(
    block: SDKContentBlock,
    emit: RenderEventEmitter,
  ): Promise<void> {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      await emit({ type: "text", text: block.text });
      return;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      await emit({ type: "thinking", text: block.thinking });
      return;
    }
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      await emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      return;
    }
    // Unknown / empty blocks are silently dropped — Phase 3 explicitly
    // ignores redacted_thinking, image blocks, etc. Phase 8 polish can
    // add handling when a use case arises.
  }
}
```

- [ ] **Step 5: Run tests — should pass**

Run: `pnpm test test/unit/claude/session.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/claude/session.ts src/claude/render-event.ts test/unit/claude/session.test.ts
git commit -m "feat(claude): stream RenderEvents from ClaudeSession"
```

---

## Task 9: Delete unused `extractAssistantText` renderer

**Files:**
- Delete: `src/feishu/renderer.ts`
- Delete: `test/unit/feishu/renderer.test.ts`

After Task 8, no production code imports `extractAssistantText` — each text block is emitted as its own `RenderEvent`. Remove the dead file to keep the tree honest.

- [ ] **Step 1: Verify no imports remain**

Run: `pnpm exec grep -r "extractAssistantText\|feishu/renderer" src test`
Expected: zero matches in `src/`. The only matches should be in the files we are about to delete.

- [ ] **Step 2: Delete files**

```bash
rm src/feishu/renderer.ts test/unit/feishu/renderer.test.ts
```

- [ ] **Step 3: Run full test suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -u src/feishu/renderer.ts test/unit/feishu/renderer.test.ts
git commit -m "refactor(feishu): delete unused extractAssistantText (superseded by RenderEvents)"
```

---

## Task 10: Wire `src/index.ts` to dispatch events

**Files:**
- Modify: `src/index.ts`

Replace the Phase 2 `await session.handleMessage()` + `sendText` pattern with an event-dispatching emit callback. Pull the render config so we can respect `hideThinking` / `showTurnStats`.

- [ ] **Step 1: Add the new imports near the top of `src/index.ts`**

Add to the import block:

```typescript
import { buildToolUseCard, buildToolResultCard } from "./feishu/cards.js";
import {
  formatThinkingText,
  formatResultTip,
  formatErrorText,
} from "./feishu/messages.js";
import type { RenderEvent } from "./claude/render-event.js";
```

- [ ] **Step 2: Replace the `onMessage` handler**

Find the Phase 2 `onMessage` (the function signature is `async (msg: IncomingMessage): Promise<void>` around line 93). Replace its body with:

```typescript
const onMessage = async (msg: IncomingMessage): Promise<void> => {
  logger.info({ chat_id: msg.chatId, len: msg.text.length }, "Message received");
  const session = sessionManager.getOrCreate(msg.chatId);
  const emit = async (event: RenderEvent): Promise<void> => {
    switch (event.type) {
      case "text":
        await feishuClient.sendText(msg.chatId, event.text);
        return;
      case "thinking":
        if (config.render.hideThinking) return;
        await feishuClient.sendText(msg.chatId, formatThinkingText(event.text));
        return;
      case "tool_use":
        await feishuClient.sendCard(
          msg.chatId,
          buildToolUseCard(
            { id: event.id, name: event.name, input: event.input },
            { inlineMaxBytes: config.render.inlineMaxBytes },
          ),
        );
        return;
      case "tool_result":
        await feishuClient.sendCard(
          msg.chatId,
          buildToolResultCard({
            toolUseId: event.toolUseId,
            isError: event.isError,
            text: event.text,
            inlineMaxBytes: config.render.inlineMaxBytes,
          }),
        );
        return;
      case "turn_end":
        if (!config.render.showTurnStats) return;
        await feishuClient.sendText(
          msg.chatId,
          formatResultTip({
            durationMs: event.durationMs,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          }),
        );
        return;
    }
  };
  try {
    await session.handleMessage(msg.text, emit);
  } catch (err) {
    logger.error({ err, chat_id: msg.chatId }, "Claude turn failed");
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      await feishuClient.sendText(msg.chatId, formatErrorText(errMsg));
    } catch (sendErr) {
      logger.error({ err: sendErr }, "Failed to deliver error reply");
    }
  }
};
```

- [ ] **Step 3: Update the banner**

Find the `"claude-feishu-channel Phase 2 ready"` log line and change it to:

```typescript
logger.info(
  {
    allowed_count: config.access.allowedOpenIds.length,
    unauthorized_behavior: config.access.unauthorizedBehavior,
    default_cwd: config.claude.defaultCwd,
    default_model: config.claude.defaultModel,
    permission_mode: config.claude.defaultPermissionMode,
    inline_max_bytes: config.render.inlineMaxBytes,
    hide_thinking: config.render.hideThinking,
    show_turn_stats: config.render.showTurnStats,
  },
  "claude-feishu-channel Phase 3 ready",
);
```

- [ ] **Step 4: Typecheck + full test run**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. No new tests for `src/index.ts` (it's the integration boundary — covered by manual E2E per the autonomous-phase memory).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: dispatch RenderEvents to Feishu in index.ts (Phase 3 wiring)"
```

---

## Task 11: README update

**Files:**
- Modify: `README.md`

Bring the README in line with Phase 3: new `[render]` config, tool card visibility, updated status and src/ tree, Phase 3 removed from "Next phases" list.

- [ ] **Step 1: Read the current README**

Run: `cat README.md` — check current Phase 2 status line, src/ layout, Next phases block.

- [ ] **Step 2: Apply these edits**

**(a)** Change the status line from "Phase 2 of 8" to "Phase 3 of 8".

**(b)** Under the existing Configuration section (where `[claude]` is documented from Phase 2), add a new `[render]` bullet:

```markdown
- `[render]` — card rendering knobs:
  - `inline_max_bytes` (default 2048): UTF-8 byte limit for inline tool params / tool output previews
  - `hide_thinking` (default false): skip Claude's extended-thinking blocks
  - `show_turn_stats` (default true): append "✅ 12.3s · 1.2k in / 3.4k out" after each turn
```

**(c)** In the "What you should see" / expected-reply section, update it to mention:

> Each turn now streams as multiple Feishu messages:
> - A 🔧 blue card per tool call Claude makes (Bash / Read / Edit / Write / Grep / default)
> - A ✅ green / ❌ red card per tool result
> - A 💭 thinking message (unless `hide_thinking=true`)
> - Assistant text as plain text
> - A final ✅ stats tip (unless `show_turn_stats=false`)

**(d)** Update the banner log line reference to "Phase 3 ready".

**(e)** Update the `src/` layout tree to reflect new files:

```
src/
  claude/
    preflight.ts
    render-event.ts        ← new
    session-manager.ts
    session.ts             ← rewritten (streams RenderEvents)
  feishu/
    card-types.ts          ← new
    cards.ts               ← new
    client.ts              ← added sendCard
    gateway.ts
    messages.ts            ← new
    tool-formatters.ts     ← new
    tool-result.ts         ← new
    truncate.ts            ← new
  persistence/
    state-store.ts
  util/
    logger.ts
    mutex.ts
  access.ts
  config.ts
  index.ts
  types.ts
```

(Note: `feishu/renderer.ts` is gone — omit from the tree.)

**(f)** Remove Phase 3 from the "Next phases" list. The remaining phases should read: Phase 4, 5, 6, 7, 8.

- [ ] **Step 3: Run final checks**

Run: `pnpm test && pnpm typecheck`
Expected: All green.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README for Phase 3 (tool cards + [render] config)"
```

---

## Final Review

After Task 11 is committed:

- Dispatch a final phase-wide `superpowers:code-reviewer` subagent to review all Phase 3 commits against this plan and design spec §7.
- Apply any Critical / Important fixes as follow-up commits.
- Report E2E instructions to the user. Phase 3 E2E checklist:
  1. Restart gateway: `pnpm dev` (banner should say "Phase 3 ready" and log `inline_max_bytes` / `hide_thinking` / `show_turn_stats`)
  2. Send a message that triggers at least one tool call — e.g. "帮我看看 package.json 里都有什么脚本" (should trigger Read)
  3. Verify: blue `🔧 Read` card → green `✅ Result` card with truncated preview → Claude's text reply → optional thinking / turn-stat messages
  4. Try `[render].hide_thinking = true` + reload, verify thinking messages disappear
  5. Try `[render].show_turn_stats = false` + reload, verify stats tip disappears
  6. Try a tool error (send "跑一下 nonexistent-command" so Bash fails) — verify red ❌ Error card
- Do NOT tag/push yet. User confirms E2E, then use `superpowers:finishing-a-development-branch` to tag `v0.3.0-phase3`, push main, push tag.

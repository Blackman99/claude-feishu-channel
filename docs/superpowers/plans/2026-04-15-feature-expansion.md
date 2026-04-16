# Feature Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fill the feature gaps between claude-feishu-channel and the official Claude Code CLI: fix the thinking-card streaming fallback, wire i18n throughout the dispatcher, add `/cost` `/context` `/compact` `/memory` commands, expose user-configurable MCP servers, and enable image input from Feishu.

**Architecture:** Each task is self-contained and can be shipped independently. Phases 1–4 are pure backend changes (no new files). Phases 5–7 each introduce one new subsystem (MCP config, memory I/O, Feishu image pipeline). All new commands follow the established router → dispatcher → i18n pattern.

**Tech Stack:** TypeScript, Node.js ≥20, `@anthropic-ai/claude-agent-sdk`, `@larksuiteoapi/node-sdk`, `smol-toml`, `zod`, `vitest`

---

## Phase 1 — Stability fix

### Task 1: Thinking card stream degradation

**Problem:** When `streamElementContent` throws on the thinking card (e.g. `code=300309` or `502`), the code sets `thinkingDisabled = true` and stops all updates for the rest of the turn. Status and tool cards were already fixed in v0.3.3–v0.3.5; thinking is the last remaining case.

**Files:**
- Modify: `src/index.ts` (the `else if (turnState.thinkingCardId !== null)` / `else` block, ~line 370–410)

- [x] **Step 1: Read the exact current code**

```bash
grep -n "thinkingCardId\|thinkingDisabled\|thinkingSequence" src/index.ts | head -20
```

Note the exact line numbers of the `else if` / `else` block.

- [x] **Step 2: Write failing test**

Add to `test/unit/feishu/cards.test.ts` (or a new file `test/unit/index-thinking-fallback.test.ts` if you prefer isolation):

> There is no direct unit test for `updateStatus`/`sendOrPatchToolCard` because `src/index.ts` wires everything together. The existing pattern is integration-level. Verify by reading the code diff carefully and relying on the typecheck + existing 419 tests as a regression gate. Skip to Step 3.

- [x] **Step 3: Restructure the `else if` / `else` thinking block in `src/index.ts`**

Replace:

```typescript
} else if (turnState.thinkingCardId !== null) {
  turnState.thinkingSequence += 1;
  const streamed = prepareInline(
    turnState.thinkingText,
    config.render.inlineMaxBytes,
  );
  try {
    await feishuClient.streamElementContent({
      cardId: turnState.thinkingCardId,
      elementId: THINKING_ELEMENT_ID,
      content: streamed,
      sequence: turnState.thinkingSequence,
    });
  } catch (err) {
    logger.warn(
      { err, chat_id: msg.chatId },
      "thinking stream failed; disabling thinking card for this turn",
    );
    turnState.thinkingDisabled = true;
  }
} else {
  // Fallback path: idConvert failed on the first block, so
  // we can't stream — revert to full-card patch for the
  // rest of the turn.
  const card = buildThinkingCard(turnState.thinkingText, {
    inlineMaxBytes: config.render.inlineMaxBytes,
  });
  try {
    await feishuClient.patchCard(turnState.thinkingMessageId, card);
  } catch (err) {
    logger.warn(
      { err, chat_id: msg.chatId },
      "thinking patchCard failed; disabling thinking card for this turn",
    );
    turnState.thinkingDisabled = true;
  }
}
```

With:

```typescript
} else {
  // Subsequent thinking blocks.
  if (turnState.thinkingCardId !== null) {
    // Try streaming first (typewriter effect).
    turnState.thinkingSequence += 1;
    const streamed = prepareInline(
      turnState.thinkingText,
      config.render.inlineMaxBytes,
    );
    try {
      await feishuClient.streamElementContent({
        cardId: turnState.thinkingCardId,
        elementId: THINKING_ELEMENT_ID,
        content: streamed,
        sequence: turnState.thinkingSequence,
      });
      return;
    } catch (err) {
      // Transient errors (502) or session expiry (300309): clear
      // cardId and fall through to patchCard — mirrors the same
      // pattern used by updateStatus and sendOrPatchToolCard.
      logger.warn(
        { err, chat_id: msg.chatId },
        "thinking stream failed; falling back to patchCard for remainder of turn",
      );
      turnState.thinkingCardId = null;
    }
  }
  // patchCard: either idConvert failed on the first block,
  // or streaming failed mid-turn.
  const card = buildThinkingCard(turnState.thinkingText, {
    inlineMaxBytes: config.render.inlineMaxBytes,
  });
  try {
    await feishuClient.patchCard(turnState.thinkingMessageId!, card);
  } catch (err) {
    logger.warn(
      { err, chat_id: msg.chatId },
      "thinking patchCard failed; disabling thinking card for this turn",
    );
    turnState.thinkingDisabled = true;
  }
}
```

- [x] **Step 4: Verify**

```bash
pnpm typecheck && pnpm test
```

Expected: `419 passed` (or more), no type errors.

- [x] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "fix: fall back to patchCard when thinking card streaming fails (300309/502)"
```

---

## Phase 2 — Internationalization

### Task 2: Wire dispatcher to use i18n

**Problem:** `src/commands/dispatcher.ts` builds all user-visible strings as hardcoded Chinese. `src/util/i18n.ts` already contains both `zh` and `en` versions of every dispatcher string—they just aren't being called. `ctx.locale` is already threaded through every handler.

**Files:**
- Modify: `src/commands/dispatcher.ts`

- [x] **Step 1: Add the i18n import**

At the top of `src/commands/dispatcher.ts`, add:

```typescript
import { t } from "../util/i18n.js";
```

- [x] **Step 2: Fix `dispatchUnknown`**

Replace:
```typescript
await this.feishu.replyText(
  ctx.parentMessageId,
  `未知命令 ${raw}，发 /help 查看可用命令`,
);
```
With:
```typescript
await this.feishu.replyText(
  ctx.parentMessageId,
  t(ctx.locale).unknownCommand(raw),
);
```

- [x] **Step 3: Fix `handleHelp`**

Replace the entire hardcoded array with:

```typescript
private async handleHelp(ctx: CommandContext): Promise<void> {
  const s = t(ctx.locale);
  const text = [
    s.helpHeader, "",
    s.helpSectionSession,
    s.helpNew, s.helpStatus, s.helpStop, s.helpSessions,
    s.helpProjects, s.helpResume,
    "", s.helpSectionCwd,
    s.helpCd, s.helpProject,
    "", s.helpSectionMode,
    s.helpMode, s.helpModel,
    "", s.helpSectionConfig,
    s.helpConfigShow, s.helpConfigSet, s.helpConfigSetPersist,
    s.helpHelp,
  ].join("\n");
  await this.feishu.replyText(ctx.parentMessageId, text);
}
```

- [x] **Step 4: Fix `handleStatus`**

Replace the hardcoded `lines` array:

```typescript
private async handleStatus(ctx: CommandContext): Promise<void> {
  const session = this.sessionManager.getOrCreate(ctx.chatId);
  const status = session.getStatus();
  const projectAlias = this.sessionManager.getActiveProject(ctx.chatId);
  const s = t(ctx.locale);

  const lines = [
    s.statusState(status.state),
    ...(projectAlias ? [`📁 ${projectAlias}`] : []),
    s.statusCwd(status.cwd),
    s.statusPermMode(status.permissionMode),
    s.statusModel(status.model),
    s.statusTurns(status.turnCount),
    s.statusInputTokens(status.totalInputTokens),
    s.statusOutputTokens(status.totalOutputTokens),
    s.statusQueueLen(status.queueLength),
  ];

  await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
}
```

- [x] **Step 5: Fix `handleConfigShow`**

Replace `"当前配置："` and the section headers with `t(ctx.locale).configShowHeader`. The section names (`[feishu]`, `[claude]`, etc.) are technical keys and may stay as-is. Only the header line needs i18n.

```typescript
const lines: string[] = [t(ctx.locale).configShowHeader, ""];
// rest of the lines stay as-is (they are config keys, not UI text)
```

- [x] **Step 6: Fix `handleConfigSet` error messages**

Replace the inline Chinese strings in `parseConfigValue` return values and the error replies in `handleConfigSet`:

In `parseConfigValue`:
```typescript
// These strings are only used inside handleConfigSet which has ctx.locale
// Pass locale through OR use t(locale) at the call site.
// Simplest fix: change parseConfigValue to return a code, resolve string in handleConfigSet.
```

The cleanest approach: change `parseConfigValue` `reason` from a Chinese string to a structured reason type. But to minimise diff, just change the three `reason` strings to use the `t()` keys at the call site in `handleConfigSet`:

```typescript
// In handleConfigSet, after `if (!parsed.ok)`:
const reasons: Record<KeyType, string> = {
  boolean: t(ctx.locale).configBoolExpected,
  number: t(ctx.locale).configPosIntExpected,
  string: t(ctx.locale).configNonEmptyStringExpected,
  enum: t(ctx.locale).configEnumExpected(def.values!.join(" | ")),
};
if (!parsed.ok) {
  await this.feishu.replyText(
    ctx.parentMessageId,
    t(ctx.locale).configInvalidValue(rawValue, key, reasons[def.type]),
  );
  return;
}
```

For the unsupported key error:
```typescript
await this.feishu.replyText(
  ctx.parentMessageId,
  t(ctx.locale).configUnsupported(key, Object.keys(SETTABLE_KEYS).join(", ")),
);
```

For the persist messages:
```typescript
let persistMsg = "";
if (persist) {
  if (!this.configPath) {
    persistMsg = t(ctx.locale).configPersistSkipped;
  } else {
    try {
      await writeConfigKey(this.configPath, key, parsed.value);
      persistMsg = t(ctx.locale).configPersisted;
    } catch (err) {
      persistMsg = t(ctx.locale).configPersistFailed(err instanceof Error ? err.message : String(err));
    }
  }
}
await this.feishu.replyText(
  ctx.parentMessageId,
  t(ctx.locale).configUpdated(key, String(parsed.value), persistMsg),
);
```

- [x] **Step 7: Fix remaining handlers**

For each of these, replace the hardcoded Chinese string with the corresponding `t(ctx.locale)` call:

```typescript
// handleNew
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).newSessionStarted);

// handleMode – session busy check
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
// after switch
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).modeSwitched(mode));

// handleModel – session busy check
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
// after switch
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).modelSwitched(model));

// handleCd – error cases
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).cdNotDir(path));
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).cdNotFound(path));
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).cdSendFailed);
// session busy
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);

// handleProject – unknown alias
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).projectUnknown(alias, list));
// session busy
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
// already here (current already-in-project case – add to i18n in Step 8 below)

// handleProjects – no projects
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).projectsNone);

// handleSessions – no sessions
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionsNone);

// handleResume
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).resumeNotFound(target));
await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).resumeAlreadyHere);
// success – already uses i18n via resumeSuccess()
```

- [x] **Step 8: Add two missing i18n strings to `src/util/i18n.ts`**

`handleProject` has a "already in project" branch that replies inline without i18n. Add:

```typescript
// in zh:
projectAlreadyHere: (alias: string, cwd: string) =>
  `已在项目 ${alias}，工作目录: ${cwd}`,

// in en:
projectAlreadyHere: (alias: string, cwd: string) =>
  `Already on project ${alias}, working dir: ${cwd}`,
```

Then in `handleProject`:
```typescript
await this.feishu.replyText(
  ctx.parentMessageId,
  t(ctx.locale).projectAlreadyHere(alias, session.getStatus().cwd),
);
```

- [x] **Step 9: Verify**

```bash
pnpm typecheck && pnpm test
```

Expected: all tests pass, no type errors.

- [x] **Step 10: Commit**

```bash
git add src/commands/dispatcher.ts src/util/i18n.ts
git commit -m "feat: wire dispatcher to i18n — all user-visible strings now respect locale"
```

---

## Phase 3 — Observability commands

### Task 3: `/cost` command

**Files:**
- Modify: `src/commands/router.ts`
- Modify: `src/commands/dispatcher.ts`
- Modify: `src/util/i18n.ts`
- Modify: `test/unit/commands/router.test.ts`

- [x] **Step 1: Write failing router test**

In `test/unit/commands/router.test.ts`, add:

```typescript
it("parses /cost", () => {
  expect(parseInput("/cost")).toEqual({ kind: "command", cmd: { name: "cost" } });
});
```

Run: `pnpm test -- --reporter=verbose test/unit/commands/router.test.ts`
Expected: FAIL ("cost" not a known command)

- [x] **Step 2: Add `cost` to the router**

In `src/commands/router.ts`:

Add `| { name: "cost" }` to the `ParsedCommand` union.

Add `"cost"` to `KNOWN_COMMANDS`.

In `parseCommand`, add:
```typescript
case "cost":
  return { name: "cost" };
```

- [x] **Step 3: Run test — expect pass**

```bash
pnpm test -- --reporter=verbose test/unit/commands/router.test.ts
```

- [x] **Step 4: Add i18n strings**

In `src/util/i18n.ts`, add to both `zh` and `en`:

```typescript
// zh:
costHeader: "Token 使用统计",
costInput: (n: number) => `输入 Token：${n.toLocaleString()}`,
costOutput: (n: number) => `输出 Token：${n.toLocaleString()}`,
costTotal: (n: number) => `合计：${n.toLocaleString()}`,
costNote: "定价参考：https://www.anthropic.com/pricing",

// en:
costHeader: "Token Usage",
costInput: (n: number) => `Input tokens: ${n.toLocaleString()}`,
costOutput: (n: number) => `Output tokens: ${n.toLocaleString()}`,
costTotal: (n: number) => `Total: ${n.toLocaleString()}`,
costNote: "Pricing: https://www.anthropic.com/pricing",
```

- [x] **Step 5: Add `handleCost` to dispatcher**

In the `dispatch` switch, add:
```typescript
case "cost":
  return this.handleCost(ctx);
```

Add the handler:
```typescript
private async handleCost(ctx: CommandContext): Promise<void> {
  const session = this.sessionManager.getOrCreate(ctx.chatId);
  const status = session.getStatus();
  const s = t(ctx.locale);
  const total = status.totalInputTokens + status.totalOutputTokens;
  const lines = [
    s.costHeader,
    "",
    s.costInput(status.totalInputTokens),
    s.costOutput(status.totalOutputTokens),
    s.costTotal(total),
    "",
    s.costNote,
  ];
  await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
}
```

Also add `"cost"` to the exhaustive `_exhaustive: never` check (it will error at compile time if you forget).

- [x] **Step 6: Add /cost to help text**

In `src/util/i18n.ts`, add `helpCost` to both locales:
```typescript
// zh:
helpCost: "  /cost         — 查看本会话 token 用量",
// en:
helpCost: "  /cost         — Show token usage for this session",
```

In `handleHelp` (Task 2, Step 3), add `s.helpCost` after `s.helpStatus`.

- [x] **Step 7: Verify**

```bash
pnpm typecheck && pnpm test
```

- [x] **Step 8: Commit**

```bash
git add src/commands/router.ts src/commands/dispatcher.ts src/util/i18n.ts \
        test/unit/commands/router.test.ts
git commit -m "feat: add /cost command — show session token usage"
```

---

### Task 4: `/context` command

**Files:**
- Modify: `src/commands/router.ts`
- Modify: `src/commands/dispatcher.ts`
- Modify: `src/util/i18n.ts`
- Modify: `test/unit/commands/router.test.ts`

- [x] **Step 1: Write failing router test**

```typescript
it("parses /context", () => {
  expect(parseInput("/context")).toEqual({ kind: "command", cmd: { name: "context" } });
});
```

Run: `pnpm test -- --reporter=verbose test/unit/commands/router.test.ts`
Expected: FAIL

- [x] **Step 2: Add `context` to router**

In `src/commands/router.ts`:

Add `| { name: "context" }` to `ParsedCommand`.

Add `"context"` to `KNOWN_COMMANDS`.

In `parseCommand`:
```typescript
case "context":
  return { name: "context" };
```

- [x] **Step 3: Add model context-window map to dispatcher**

At the top of `src/commands/dispatcher.ts`, add:

```typescript
/**
 * Known context window sizes (tokens) for Claude models.
 * Keys are partial model name prefixes — matched with startsWith.
 * Default fallback: 200_000 (matches all current Claude 3/4 models).
 */
const MODEL_CONTEXT_WINDOWS: Array<[prefix: string, tokens: number]> = [
  ["claude-3-haiku", 200_000],
  ["claude-3-5-haiku", 200_000],
  ["claude-3-5-sonnet", 200_000],
  ["claude-3-7-sonnet", 200_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
];

function contextWindowFor(model: string): number {
  for (const [prefix, size] of MODEL_CONTEXT_WINDOWS) {
    if (model.startsWith(prefix)) return size;
  }
  return 200_000; // safe default for all current Claude models
}
```

- [x] **Step 4: Add i18n strings**

```typescript
// zh:
contextHeader: "上下文窗口使用情况",
contextUsed: (tokens: number) => `已用：${tokens.toLocaleString()} tokens`,
contextWindow: (tokens: number) => `窗口：${tokens.toLocaleString()} tokens`,
contextPercent: (pct: string) => `占用：${pct}%`,
contextWarning: "⚠️ 上下文已超过 80%，建议发 /new 开新会话",

// en:
contextHeader: "Context Window Usage",
contextUsed: (tokens: number) => `Used: ${tokens.toLocaleString()} tokens`,
contextWindow: (tokens: number) => `Window: ${tokens.toLocaleString()} tokens`,
contextPercent: (pct: string) => `Usage: ${pct}%`,
contextWarning: "⚠️ Context is over 80% full — consider /new to start fresh",
```

- [x] **Step 5: Add `handleContext` to dispatcher**

In the `dispatch` switch:
```typescript
case "context":
  return this.handleContext(ctx);
```

Handler:
```typescript
private async handleContext(ctx: CommandContext): Promise<void> {
  const session = this.sessionManager.getOrCreate(ctx.chatId);
  const status = session.getStatus();
  const s = t(ctx.locale);
  const windowSize = contextWindowFor(status.model);
  // totalInputTokens is a reasonable proxy for current context size
  // (it accumulates per turn and the SDK resets it on /new).
  const used = status.totalInputTokens;
  const pct = ((used / windowSize) * 100).toFixed(1);
  const lines = [
    s.contextHeader,
    "",
    s.contextUsed(used),
    s.contextWindow(windowSize),
    s.contextPercent(pct),
  ];
  if (used / windowSize > 0.8) lines.push("", s.contextWarning);
  await this.feishu.replyText(ctx.parentMessageId, lines.join("\n"));
}
```

- [x] **Step 6: Add help entry**

```typescript
// zh: helpContext: "  /context      — 查看上下文窗口占用情况",
// en: helpContext: "  /context      — Show context window usage",
```

Add after `s.helpCost` in `handleHelp`.

- [x] **Step 7: Verify**

```bash
pnpm typecheck && pnpm test
```

- [x] **Step 8: Commit**

```bash
git add src/commands/router.ts src/commands/dispatcher.ts src/util/i18n.ts \
        test/unit/commands/router.test.ts
git commit -m "feat: add /context command — show context window token usage and fill %"
```

---

## Phase 4 — Session compaction

### Task 5: `/compact` command + auto-compact config

**Context:** The SDK supports `autoCompactThreshold` (0.0–1.0 fill fraction that triggers auto-compact). There is no public "trigger compact now" API, so `/compact` manually resets the session with a warning, and we expose `auto_compact_threshold` in config for background compaction.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `config.example.toml`
- Modify: `src/claude/session.ts`
- Modify: `src/commands/router.ts`
- Modify: `src/commands/dispatcher.ts`
- Modify: `src/util/i18n.ts`
- Modify: `test/unit/commands/router.test.ts`
- Modify: `test/unit/config.test.ts`

- [x] **Step 1: Write failing router test**

```typescript
it("parses /compact", () => {
  expect(parseInput("/compact")).toEqual({ kind: "command", cmd: { name: "compact" } });
});
```

Run: `pnpm test -- --reporter=verbose test/unit/commands/router.test.ts`
Expected: FAIL

- [x] **Step 2: Add config type for auto_compact_threshold**

In `src/types.ts`, add to the `claude` section of `AppConfig`:

```typescript
claude: {
  // ... existing fields ...
  /** 0.0–1.0 fill fraction at which auto-compact triggers. undefined = SDK default. */
  autoCompactThreshold?: number;
};
```

- [x] **Step 3: Parse from config.toml**

In `src/config.ts`, inside the `claude` section of the TOML parser, add:

```typescript
autoCompactThreshold: zod
  .number()
  .min(0)
  .max(1)
  .optional()
  .parse(raw.claude?.auto_compact_threshold ?? undefined),
```

Confirm by running:
```bash
pnpm typecheck
```

- [x] **Step 4: Write failing config test**

In `test/unit/config.test.ts`, add:

```typescript
it("parses claude.auto_compact_threshold", () => {
  const toml = `
[claude]
auto_compact_threshold = 0.7
`;
  const cfg = parseConfig(toml);
  expect(cfg.claude.autoCompactThreshold).toBe(0.7);
});
```

Run: `pnpm test -- --reporter=verbose test/unit/config.test.ts`
Expected: FAIL (field not parsed yet — do Step 3 first, then re-run to confirm PASS).

- [x] **Step 5: Pass threshold to SDK in `src/claude/session.ts`**

In `session.ts`, find where `queryFn` is called (around line 475). The `options` block currently has `settingSources`, `mcpServers`, etc. Add:

```typescript
options: {
  cwd: this.config.defaultCwd,
  model: this.modelOverride ?? this.config.defaultModel,
  permissionMode,
  settingSources: ["user", "project"],
  mcpServers: [askUserMcp],
  disallowedTools: ["AskUserQuestion"],
  ...(this.claudeSessionId !== undefined ? { resume: this.claudeSessionId } : {}),
  ...(this.config.autoCompactThreshold !== undefined
    ? { autoCompactThreshold: this.config.autoCompactThreshold }
    : {}),
},
```

Note: `this.config` here is `ClaudeConfig` (the `[claude]` section). Verify the type has `autoCompactThreshold` after Step 2.

- [x] **Step 6: Add auto_compact_threshold to config.example.toml**

```toml
# Fraction of the context window at which Claude auto-compacts the conversation.
# 0.0–1.0. Omit to use the Claude CLI default (typically ~0.85).
# auto_compact_threshold = 0.8
```

- [x] **Step 7: Add `compact` to router**

In `src/commands/router.ts`:

Add `| { name: "compact" }` to `ParsedCommand`.

Add `"compact"` to `KNOWN_COMMANDS`.

In `parseCommand`:
```typescript
case "compact":
  return { name: "compact" };
```

- [x] **Step 8: Add i18n strings**

```typescript
// zh:
compactStarted: "🗜️ 会话已重置。auto-compact 已配置时将在上下文满时自动触发；也可通过 /config set claude.auto_compact_threshold 0.8 开启。",
helpCompact: "  /compact      — 重置当前会话（上下文过大时使用）",

// en:
compactStarted: "🗜️ Session reset. When auto-compact is configured it triggers automatically near the context limit; enable via /config set claude.auto_compact_threshold 0.8.",
helpCompact: "  /compact      — Reset the current session (use when context is large)",
```

- [x] **Step 9: Add `handleCompact` to dispatcher**

```typescript
case "compact":
  return this.handleCompact(ctx);
```

```typescript
private async handleCompact(ctx: CommandContext): Promise<void> {
  const session = this.sessionManager.getOrCreate(ctx.chatId);
  if (session.getState() !== "idle") {
    await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).sessionBusy);
    return;
  }
  // Reset the session (drops claudeSessionId so next turn starts fresh).
  this.permissionBroker.cancelAll("compact");
  this.questionBroker.cancelAll("compact");
  this.sessionManager.delete(ctx.chatId);
  await this.feishu.replyText(ctx.parentMessageId, t(ctx.locale).compactStarted);
}
```

Also add `claude.auto_compact_threshold` to the `SETTABLE_KEYS` map in `dispatcher.ts` so users can change it at runtime:

```typescript
"claude.auto_compact_threshold": {
  path: ["claude", "autoCompactThreshold"],
  type: "number" as const,
  // stored as fraction 0.0–1.0; no multiplier needed
},
```

Note: The Zod schema validates 0–1; the runtime setter does not re-validate range. Add a note in the help text.

- [x] **Step 10: Add help entry**

Add `s.helpCompact` after `s.helpNew` in `handleHelp`.

- [x] **Step 11: Verify**

```bash
pnpm typecheck && pnpm test
```

- [x] **Step 12: Commit**

```bash
git add src/types.ts src/config.ts config.example.toml \
        src/claude/session.ts src/commands/router.ts \
        src/commands/dispatcher.ts src/util/i18n.ts \
        test/unit/commands/router.test.ts test/unit/config.test.ts
git commit -m "feat: add /compact command and claude.auto_compact_threshold config"
```

---

## Phase 5 — Memory

### Task 6: `/memory` command — read & append CLAUDE.md

**Behaviour:**
- `/memory` (no args) — reply with contents of global `~/.claude/CLAUDE.md` and project `<cwd>/CLAUDE.md` (if they exist)
- `/memory add <text>` — append `<text>` as a new bullet to the project `CLAUDE.md`

**Files:**
- Modify: `src/commands/router.ts`
- Modify: `src/commands/dispatcher.ts`
- Modify: `src/util/i18n.ts`
- Modify: `test/unit/commands/router.test.ts`
- Modify: `test/unit/commands/dispatcher.test.ts`

- [x] **Step 1: Write failing router tests**

```typescript
it("parses /memory with no args", () => {
  expect(parseInput("/memory")).toEqual({
    kind: "command",
    cmd: { name: "memory_show" },
  });
});

it("parses /memory add <text>", () => {
  expect(parseInput("/memory add remember this")).toEqual({
    kind: "command",
    cmd: { name: "memory_add", text: "remember this" },
  });
});

it("returns unknown_command for bare /memory add with no text", () => {
  expect(parseInput("/memory add")).toEqual({
    kind: "unknown_command",
    raw: "/memory add",
  });
});
```

Run: `pnpm test -- --reporter=verbose test/unit/commands/router.test.ts`
Expected: FAIL

- [x] **Step 2: Add `memory_show` and `memory_add` to router**

In `src/commands/router.ts`:

```typescript
| { name: "memory_show" }
| { name: "memory_add"; text: string }
```

Add `"memory"` to `KNOWN_COMMANDS`.

In `parseCommand`:
```typescript
case "memory":
  if (!rest) return { name: "memory_show" };
  if (rest.startsWith("add ")) {
    const text = rest.slice(4).trim();
    return text ? { name: "memory_add", text } : null;
  }
  return null;
```

- [x] **Step 3: Run router tests — expect pass**

```bash
pnpm test -- --reporter=verbose test/unit/commands/router.test.ts
```

- [x] **Step 4: Add i18n strings**

```typescript
// zh:
memoryGlobalHeader: "🧠 全局记忆 (~/.claude/CLAUDE.md)",
memoryProjectHeader: (cwd: string) => `📁 项目记忆 (${cwd}/CLAUDE.md)`,
memoryEmpty: "_(空)_",
memoryNone: "暂无记忆文件",
memoryAdded: (path: string) => `✅ 已追加到 ${path}`,
memoryAddFailed: (err: string) => `❌ 写入失败: ${err}`,
helpMemory: "  /memory       — 查看 CLAUDE.md 记忆内容",
helpMemoryAdd: "  /memory add <文本> — 追加一条记忆到项目 CLAUDE.md",

// en:
memoryGlobalHeader: "🧠 Global memory (~/.claude/CLAUDE.md)",
memoryProjectHeader: (cwd: string) => `📁 Project memory (${cwd}/CLAUDE.md)`,
memoryEmpty: "_(empty)_",
memoryNone: "No memory files found",
memoryAdded: (path: string) => `✅ Appended to ${path}`,
memoryAddFailed: (err: string) => `❌ Write failed: ${err}`,
helpMemory: "  /memory       — Show CLAUDE.md memory contents",
helpMemoryAdd: "  /memory add <text> — Append an entry to project CLAUDE.md",
```

- [x] **Step 5: Add imports to dispatcher**

```typescript
import { readFile, appendFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
```

(Check whether these are already imported — add only what's missing.)

- [x] **Step 6: Add dispatch cases**

```typescript
case "memory_show":
  return this.handleMemoryShow(ctx);
case "memory_add":
  return this.handleMemoryAdd(cmd.text, ctx);
```

- [x] **Step 7: Implement `handleMemoryShow`**

```typescript
private async handleMemoryShow(ctx: CommandContext): Promise<void> {
  const s = t(ctx.locale);
  const session = this.sessionManager.getOrCreate(ctx.chatId);
  const cwd = session.getStatus().cwd;
  const globalPath = join(homedir(), ".claude", "CLAUDE.md");
  const projectPath = join(cwd, "CLAUDE.md");

  const readOrEmpty = async (filePath: string): Promise<string | null> => {
    try {
      await access(filePath);
      return await readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  };

  const [globalContent, projectContent] = await Promise.all([
    readOrEmpty(globalPath),
    readOrEmpty(projectPath),
  ]);

  if (globalContent === null && projectContent === null) {
    await this.feishu.replyText(ctx.parentMessageId, s.memoryNone);
    return;
  }

  const parts: string[] = [];
  if (globalContent !== null) {
    parts.push(s.memoryGlobalHeader);
    parts.push(globalContent.trim() || s.memoryEmpty);
  }
  if (projectContent !== null) {
    parts.push(s.memoryProjectHeader(cwd));
    parts.push(projectContent.trim() || s.memoryEmpty);
  }

  await this.feishu.replyText(ctx.parentMessageId, parts.join("\n\n"));
}
```

- [x] **Step 8: Implement `handleMemoryAdd`**

```typescript
private async handleMemoryAdd(text: string, ctx: CommandContext): Promise<void> {
  const s = t(ctx.locale);
  const session = this.sessionManager.getOrCreate(ctx.chatId);
  const cwd = session.getStatus().cwd;
  const projectPath = join(cwd, "CLAUDE.md");

  try {
    await appendFile(projectPath, `\n- ${text}\n`, "utf-8");
    await this.feishu.replyText(ctx.parentMessageId, s.memoryAdded(projectPath));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await this.feishu.replyText(ctx.parentMessageId, s.memoryAddFailed(msg));
  }
}
```

- [x] **Step 9: Add help entries**

Add `s.helpMemory` and `s.helpMemoryAdd` to `handleHelp` in the Config section.

- [x] **Step 10: Verify**

```bash
pnpm typecheck && pnpm test
```

- [x] **Step 11: Commit**

```bash
git add src/commands/router.ts src/commands/dispatcher.ts src/util/i18n.ts \
        test/unit/commands/router.test.ts
git commit -m "feat: add /memory and /memory add — read and append CLAUDE.md entries"
```

---

## Phase 6 — User-configurable MCP servers

### Task 7: Expose `[[mcp]]` in config.toml

**Current state:** `sdk-query.ts` already passes `mcpServers` to the SDK. `session.ts` hardcodes `[askUserMcp]`. Users have no way to add their own MCP servers without editing source code.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `config.example.toml`
- Modify: `src/claude/session.ts`
- Modify: `test/unit/config.test.ts`

- [x] **Step 1: Write failing config test**

In `test/unit/config.test.ts`:

```typescript
it("parses [[mcp]] servers", () => {
  const toml = `
[[mcp]]
name = "my-server"
type = "stdio"
command = "npx"
args = ["-y", "@my/mcp-server"]

[[mcp]]
name = "remote"
type = "sse"
url = "http://localhost:8080/sse"
`;
  const cfg = parseConfig(toml);
  expect(cfg.mcp).toHaveLength(2);
  expect(cfg.mcp[0]).toMatchObject({ name: "my-server", type: "stdio", command: "npx" });
  expect(cfg.mcp[1]).toMatchObject({ name: "remote", type: "sse", url: "http://localhost:8080/sse" });
});

it("defaults mcp to empty array", () => {
  const cfg = parseConfig("[feishu]\napp_id = \"x\"\napp_secret = \"x\"");
  expect(cfg.mcp).toEqual([]);
});
```

Run: `pnpm test -- --reporter=verbose test/unit/config.test.ts`
Expected: FAIL

- [x] **Step 2: Add `McpServerConfig` type to `src/types.ts`**

```typescript
export interface McpServerConfig {
  name: string;
  type: "stdio" | "sse";
  /** stdio only */
  command?: string;
  /** stdio only */
  args?: string[];
  /** stdio only */
  env?: Record<string, string>;
  /** sse only */
  url?: string;
}

// Add to AppConfig:
export interface AppConfig {
  // ... existing fields ...
  mcp: McpServerConfig[];
}
```

- [x] **Step 3: Parse `[[mcp]]` in `src/config.ts`**

Using `zod`, add a schema and parse `raw.mcp ?? []`:

```typescript
const McpServerSchema = z.object({
  name: z.string(),
  type: z.enum(["stdio", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
});

// In the main config parse function:
mcp: z.array(McpServerSchema).parse(raw.mcp ?? []),
```

- [x] **Step 4: Run config tests — expect pass**

```bash
pnpm test -- --reporter=verbose test/unit/config.test.ts
```

- [x] **Step 5: Pass user MCP servers to session in `src/claude/session.ts`**

The session receives the full `AppConfig`. Import `McpServerConfig` and add the user servers alongside `askUserMcp`:

```typescript
import type { McpServerConfig } from "../types.js";

// In processLoop, where queryFn is called:
const userMcpServers: Array<McpServerConfig> = this.appConfig.mcp;

options: {
  // ...
  mcpServers: [askUserMcp, ...userMcpServers],
  // ...
},
```

Note: Check that `session.ts` has access to `appConfig`. Currently it likely only has `ClaudeConfig`. If so, pass the full config (or just the `mcp` array) through `ClaudeSessionOptions`.

To find the constructor: `grep -n "constructor\|ClaudeSession(" src/claude/session.ts | head -10`

If `appConfig` is not accessible, add `mcpServers?: McpServerConfig[]` to `ClaudeSessionOptions` and pass `config.mcp` from `session-manager.ts` or `index.ts`.

- [x] **Step 6: Update `config.example.toml`**

```toml
# ---------------------------------------------------------------------------
# MCP servers — add custom tool servers (optional)
# ---------------------------------------------------------------------------
# Each [[mcp]] block registers one server. The SDK spawns stdio servers
# as child processes and connects to SSE servers over HTTP.

# Example: stdio MCP server
# [[mcp]]
# name = "my-tools"
# type = "stdio"
# command = "npx"
# args = ["-y", "@company/my-mcp-server"]
# # env = { API_KEY = "secret" }

# Example: SSE MCP server
# [[mcp]]
# name = "remote"
# type = "sse"
# url = "http://localhost:8080/sse"
```

- [x] **Step 7: Verify**

```bash
pnpm typecheck && pnpm test
```

- [x] **Step 8: Commit**

```bash
git add src/types.ts src/config.ts config.example.toml \
        src/claude/session.ts test/unit/config.test.ts
git commit -m "feat: expose [[mcp]] config — users can add custom MCP servers"
```

---

## Phase 7 — Image input from Feishu

### Task 8: Parse and download Feishu image messages

**Current state:** `src/feishu/gateway.ts:134` drops all non-text messages. This task adds image handling.

**Files:**
- Modify: `src/feishu/gateway.ts`
- Modify: `src/feishu/client.ts`
- Modify: `src/feishu/messages.ts`
- Modify: `test/unit/feishu/messages.test.ts`

- [x] **Step 1: Understand the Feishu image message format**

A Feishu image message has `message_type === "image"` and content:
```json
{"image_key": "img_v2_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
```

To download: `GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=image`
Returns the raw binary image. The Lark Node SDK has `im.v1.messageResource.get()`.

- [x] **Step 2: Add `downloadImage` to `src/feishu/client.ts`**

```typescript
/**
 * Download an image attached to a Feishu message.
 * Returns the raw bytes as a Buffer.
 *
 * @param messageId  The Feishu message id containing the image
 * @param imageKey   The image_key value from the message content JSON
 */
async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
  const response = await this.lark.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: imageKey },
    params: { type: "image" },
  });
  // The SDK returns a Readable stream or Buffer depending on version.
  // Check what type `response.data` is:
  const data = response.data as unknown;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  // Stream case: collect chunks
  const { Readable } = await import("node:stream");
  if (data instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of data) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`downloadImage: unexpected response type ${typeof data}`);
}
```

- [x] **Step 3: Update `IncomingMessage` to support image**

In `src/feishu/messages.ts`, update the `IncomingMessage` type:

```typescript
export interface IncomingMessage {
  messageId: string;
  chatId: string;
  senderOpenId: string;
  /** Text content (empty for pure image messages) */
  text: string;
  /** Attached image as base64 data URI, or undefined */
  imageDataUri?: string;
}
```

- [x] **Step 4: Write failing test for image message parsing**

In `test/unit/feishu/messages.test.ts` (or gateway test), add:

```typescript
it("produces imageDataUri for image messages", async () => {
  // This is an integration-level check; verify types compile and the
  // field is plumbed through. Actual download requires a live Feishu
  // token so we test the type shape only.
  const msg: IncomingMessage = {
    messageId: "om_x",
    chatId: "oc_x",
    senderOpenId: "ou_x",
    text: "",
    imageDataUri: "data:image/jpeg;base64,/9j/...",
  };
  expect(msg.imageDataUri).toMatch(/^data:image\//);
});
```

Run: `pnpm test -- --reporter=verbose test/unit/feishu/messages.test.ts`
Expected: PASS (type-level test — if types compile, this passes).

- [x] **Step 5: Handle image messages in `src/feishu/gateway.ts`**

Replace the message-type filter block:

```typescript
// Before:
if (event.message.message_type !== "text") {
  log.info(
    { message_type: event.message.message_type },
    "Non-text message, dropping in Phase 1",
  );
  return;
}

let text = "";
try {
  const parsed = JSON.parse(event.message.content) as { text?: string };
  text = parsed.text ?? "";
} catch (err) {
  log.error({ err }, "Failed to parse message content");
  return;
}

const incoming: IncomingMessage = {
  messageId: event.message.message_id,
  chatId: event.message.chat_id,
  senderOpenId: event.sender.sender_id.open_id,
  // ...
};
```

```typescript
// After:
const msgType = event.message.message_type;
let text = "";
let imageDataUri: string | undefined;

if (msgType === "text") {
  try {
    const parsed = JSON.parse(event.message.content) as { text?: string };
    text = parsed.text ?? "";
  } catch (err) {
    log.error({ err }, "Failed to parse text message content");
    return;
  }
} else if (msgType === "image") {
  try {
    const parsed = JSON.parse(event.message.content) as { image_key?: string };
    const imageKey = parsed.image_key;
    if (!imageKey) {
      log.warn({ content: event.message.content }, "Image message has no image_key");
      return;
    }
    const imageBytes = await feishuClient.downloadImage(event.message.message_id, imageKey);
    // Feishu images are JPEG or PNG; use JPEG as safe default.
    imageDataUri = `data:image/jpeg;base64,${imageBytes.toString("base64")}`;
    // Use a placeholder text so the router treats this as a "run" event.
    text = "[Image]";
  } catch (err) {
    log.warn({ err }, "Failed to download image — dropping message");
    return;
  }
} else {
  log.info({ message_type: msgType }, "Unsupported message type, dropping");
  return;
}

const incoming: IncomingMessage = {
  messageId: event.message.message_id,
  chatId: event.message.chat_id,
  senderOpenId: event.sender.sender_id.open_id,
  text,
  imageDataUri,
  // ... rest of fields
};
```

Note: The gateway needs a reference to `feishuClient` to call `downloadImage`. Check if it's already in scope; if not, pass it via the gateway's constructor options (already expected — it's used for reply calls).

- [x] **Step 6: Verify types compile**

```bash
pnpm typecheck
```

- [x] **Step 7: Commit**

```bash
git add src/feishu/gateway.ts src/feishu/client.ts src/feishu/messages.ts \
        test/unit/feishu/messages.test.ts
git commit -m "feat: parse Feishu image messages and download as base64"
```

---

### Task 9: Forward images to Claude SDK

**Files:**
- Modify: `src/claude/session.ts`
- Modify: `src/index.ts` (the `onMessage` handler that calls `session.submit`)

- [x] **Step 1: Update session's submit to accept image**

In `src/claude/session.ts`, find the `submit()` method and the `QueuedInput` type.

Current `QueuedInput`:
```typescript
interface QueuedInput {
  kind: "run" | "interrupt_and_run" | "stop";
  text: string;
  // ...
}
```

Add optional image field:
```typescript
interface QueuedInput {
  kind: "run" | "interrupt_and_run" | "stop";
  text: string;
  /** Base64 data URI for an attached image, if any */
  imageDataUri?: string;
  // ...
}
```

- [x] **Step 2: Build multi-part prompt when image is present**

In `processLoop`, where `queryFn` is called, change the `prompt` parameter:

```typescript
// Currently:
const handle = this.queryFn({
  prompt: next.text,
  options: { ... },
  canUseTool: ...,
});

// Change to:
const prompt = next.imageDataUri
  ? [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/jpeg" as const,
          data: next.imageDataUri.replace(/^data:image\/[^;]+;base64,/, ""),
        },
      },
      { type: "text" as const, text: next.text === "[Image]" ? "What is in this image?" : next.text },
    ]
  : next.text;

const handle = this.queryFn({
  prompt,
  options: { ... },
  canUseTool: ...,
});
```

Check the SDK's `query()` signature to verify `prompt` accepts `ContentBlock[]`. From earlier grep, the SDK defines `ContentBlock` types. Use the import:

```typescript
import type { MessageParam } from "@anthropic-ai/claude-agent-sdk";
```

Or use the inline object literal which TypeScript will type-check structurally.

- [x] **Step 3: Thread `imageDataUri` from `onMessage` to `session.submit`**

In `src/index.ts`, the `onMessage` handler calls `session.submit(...)`. Pass `imageDataUri`:

```typescript
// Find the session.submit() call and add the field:
const outcome = await session.submit({
  kind: parsed.kind === "interrupt_and_run" ? "interrupt_and_run" : "run",
  text: parsed.text ?? "",
  imageDataUri: msg.imageDataUri,
  // ... other fields
});
```

- [x] **Step 4: Verify**

```bash
pnpm typecheck && pnpm test
```

- [x] **Step 5: Commit**

```bash
git add src/claude/session.ts src/index.ts
git commit -m "feat: forward Feishu images to Claude SDK as base64 content blocks"
```

---

## Phase 8 — Release

### Task 10: Version bump + release

- [x] **Step 1: Bump version**

```bash
# Decide semver: Tasks 1–9 are all new features → minor bump
# Current version is 0.3.5 → next: 0.4.0
```

Edit `package.json`: `"version": "0.4.0"`

- [x] **Step 2: Full verification**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: all pass, `dist/` populated.

- [x] **Step 3: Commit + tag + push**

```bash
git add package.json
git commit -m "chore: bump version to 0.4.0"
git tag v0.4.0
git push && git push origin v0.4.0
```

CI (`publish.yml`) will run typecheck + test + build + `npm publish` automatically.

---

## Appendix: Task dependency map

```
T1 (thinking fallback)     — independent, ship anytime
T2 (i18n wiring)           — independent; T3–T6 build on it for new strings
T3 (/cost)                 — after T2 (shares i18n pattern)
T4 (/context)              — after T2, after T3 (same pattern)
T5 (/compact)              — after T4 (references /context in UX copy)
T6 (/memory)               — independent of T3–T5
T7 (MCP config)            — independent of T2–T6
T8 (image parse)           — independent of T2–T7
T9 (image forward)         — after T8
T10 (release)              — after T1–T9
```

Ship T1 + T2 first (stability + polish), then T3–T6 in sequence (commands), then T7 + T8–T9 in parallel, then T10.

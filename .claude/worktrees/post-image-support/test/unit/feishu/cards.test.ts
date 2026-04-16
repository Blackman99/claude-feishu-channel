import { describe, it, expect } from "vitest";
import {
  buildAnswerCard,
  buildProjectsCard,
  buildSessionsCard,
  buildStatusCard,
  buildThinkingCard,
  buildToolActivityCard,
  formatRelativeTime,
  renderToolActivityBody,
  STATUS_ELEMENT_ID,
  THINKING_ELEMENT_ID,
  TOOL_ACTIVITY_ELEMENT_ID,
  type ProjectEntry,
  type SessionEntry,
  type ToolActivityEntry,
} from "../../../src/feishu/cards.js";
import type {
  FeishuCardV2,
  FeishuCollapsiblePanelElement,
} from "../../../src/feishu/card-types.js";

function firstMarkdownContent(card: {
  body?: { elements: readonly { tag: string }[] };
}): string {
  const elements = card.body?.elements ?? [];
  const first = elements[0] as { tag: string; content?: string } | undefined;
  if (!first || first.tag !== "markdown" || typeof first.content !== "string") {
    throw new Error("expected first body element to be a markdown element");
  }
  return first.content;
}

function firstCollapsiblePanel(card: FeishuCardV2): FeishuCollapsiblePanelElement {
  const first = card.body?.elements[0];
  if (!first || first.tag !== "collapsible_panel") {
    throw new Error("expected first body element to be a collapsible_panel");
  }
  return first;
}

function panelMarkdownContent(card: FeishuCardV2): string {
  const panel = firstCollapsiblePanel(card);
  const inner = panel.elements[0];
  if (!inner || inner.tag !== "markdown" || typeof inner.content !== "string") {
    throw new Error("expected collapsible_panel's first element to be markdown");
  }
  return inner.content;
}

describe("buildThinkingCard", () => {
  it("renders a Card v2 whose body is a default-collapsed panel titled 💭 思考", () => {
    const card = buildThinkingCard("I need to list files first.", {
      inlineMaxBytes: 2048,
    });
    expect(card.schema).toBe("2.0");
    // No top-level header — the collapsible panel's own title carries
    // the "💭 思考" label, and skipping the card header keeps the
    // collapsed footprint short in the chat timeline.
    expect(card.header).toBeUndefined();
    const panel = firstCollapsiblePanel(card);
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.tag).toBe("markdown");
    expect(panel.header.title.content).toBe("💭 思考");
    // Feishu only draws the collapse/expand arrow when the panel
    // header declares its icon. Without this the panel renders in a
    // fixed state with no way for the user to toggle it.
    expect(panel.header.icon?.tag).toBe("standard_icon");
    expect(panel.header.icon?.token).toBe("down-small-ccm_outlined");
    expect(panel.header.icon_position).toBe("right");
    expect(panel.header.icon_expanded_angle).toBe(-180);
    expect(panel.elements).toHaveLength(1);
    const inner = panel.elements[0]!;
    expect(inner.tag).toBe("markdown");
    if (inner.tag !== "markdown") throw new Error("unreachable");
    expect(inner.content).toBe("I need to list files first.");
  });

  it("declares update_multi so the card can be patched later", () => {
    const card = buildThinkingCard("whatever", { inlineMaxBytes: 2048 });
    expect(card.config?.update_multi).toBe(true);
  });

  it("opts into CardKit streaming so the dispatcher can push typewriter updates", () => {
    const card = buildThinkingCard("whatever", { inlineMaxBytes: 2048 });
    expect(card.config?.streaming_mode).toBe(true);
    expect(card.config?.streaming_config?.print_strategy).toBe("fast");
    expect(card.config?.streaming_config?.print_frequency_ms?.default).toBe(50);
    expect(card.config?.streaming_config?.print_step?.default).toBe(2);
  });

  it("gives the inner markdown a stable element_id so it is streamable", () => {
    // `cardkit.v1.cardElement.content` targets elements by id, not
    // by position — the dispatcher can only stream into this card
    // if the inner markdown carries `element_id === THINKING_ELEMENT_ID`.
    const card = buildThinkingCard("whatever", { inlineMaxBytes: 2048 });
    const panel = firstCollapsiblePanel(card);
    const inner = panel.elements[0]!;
    if (inner.tag !== "markdown") throw new Error("unreachable");
    expect(inner.element_id).toBe(THINKING_ELEMENT_ID);
  });

  it("truncates long thinking text at inlineMaxBytes", () => {
    const card = buildThinkingCard("x".repeat(10000), { inlineMaxBytes: 100 });
    const panel = firstCollapsiblePanel(card);
    const inner = panel.elements[0]!;
    if (inner.tag !== "markdown") throw new Error("unreachable");
    expect(inner.content).toContain("more bytes omitted");
  });

  it("shows a placeholder when thinking text is blank", () => {
    const card = buildThinkingCard("", { inlineMaxBytes: 2048 });
    const panel = firstCollapsiblePanel(card);
    const inner = panel.elements[0]!;
    if (inner.tag !== "markdown") throw new Error("unreachable");
    expect(inner.content).toBe("_(empty)_");
  });
});

describe("buildToolActivityCard", () => {
  it("wraps the body in a default-expanded collapsible panel and declares streaming + update_multi", () => {
    const entries: ToolActivityEntry[] = [
      {
        toolUseId: "tu_1",
        name: "Bash",
        input: { command: "npm test" },
        result: { text: "PASS", isError: false },
      },
      { toolUseId: "tu_2", name: "Read", input: { file_path: "src/a.ts" } },
    ];
    const card = buildToolActivityCard(entries, { inlineMaxBytes: 2048 });
    expect(card.schema).toBe("2.0");
    expect(card.config?.update_multi).toBe(true);
    // Streaming mode so the dispatcher can push typewriter updates
    // via cardkit.v1.cardElement.content as new tools arrive.
    expect(card.config?.streaming_mode).toBe(true);
    expect(card.config?.streaming_config?.print_strategy).toBe("fast");
    // No top-level header — the panel's own title carries the label, so
    // the collapsed footprint matches the thinking card's layout.
    expect(card.header).toBeUndefined();
    const panel = firstCollapsiblePanel(card);
    // Default collapsed: the separate status card carries the
    // running "what's happening now" view, so this card is just
    // an on-demand audit trail the user expands when they want
    // per-tool history.
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.tag).toBe("markdown");
    // Title deliberately does NOT include the count. Streaming
    // only updates the inner markdown element, so any count in
    // the panel title would be frozen at the initial sendCard
    // value. The running count lives in the streamed body instead.
    expect(panel.header.title.content).toBe("🔧 工具活动");
    // Toggle icon is REQUIRED for the user to be able to collapse
    // the panel — missing it was the original bug that made the
    // tool-activity card unfoldable.
    expect(panel.header.icon?.tag).toBe("standard_icon");
    expect(panel.header.icon?.token).toBe("down-small-ccm_outlined");
    expect(panel.header.icon_position).toBe("right");
    expect(panel.header.icon_expanded_angle).toBe(-180);
    // Inner markdown carries the stable element_id the dispatcher
    // streams into.
    const inner = panel.elements[0]!;
    if (inner.tag !== "markdown") throw new Error("unreachable");
    expect(inner.element_id).toBe(TOOL_ACTIVITY_ELEMENT_ID);
  });

  it("renders one block per entry with index, name, input summary, result", () => {
    const card = buildToolActivityCard(
      [
        {
          toolUseId: "tu_1",
          name: "Bash",
          input: { command: "ls -la" },
          result: { text: "total 24", isError: false },
        },
        {
          toolUseId: "tu_2",
          name: "Read",
          input: { file_path: "src/a.ts", offset: 1, limit: 10 },
          result: { text: "import ...", isError: false },
        },
      ],
      { inlineMaxBytes: 2048 },
    );
    const body = panelMarkdownContent(card);
    // Running count lives at the top of the body (panel title
    // stays frozen under streaming).
    expect(body.startsWith("共 2 个工具")).toBe(true);
    // h3 headings separate entries (more reliable than **bold** under
    // Feishu's markdown parser).
    expect(body).toContain("### 1. Bash");
    expect(body).toContain("$ ls -la");
    expect(body).toContain("✅ total 24");
    expect(body).toContain("### 2. Read");
    expect(body).toContain("src/a.ts:1-10");
    expect(body).toContain("✅ import ...");
  });

  it("marks pending entries with ⏳ 执行中 until the result arrives", () => {
    const card = buildToolActivityCard(
      [{ toolUseId: "tu_1", name: "Bash", input: { command: "sleep 30" } }],
      { inlineMaxBytes: 2048 },
    );
    const body = panelMarkdownContent(card);
    expect(body).toContain("⏳ 执行中...");
    expect(body).not.toContain("✅");
    expect(body).not.toContain("❌");
  });

  it("uses the ❌ marker when a result is an error", () => {
    const card = buildToolActivityCard(
      [
        {
          toolUseId: "tu_1",
          name: "Bash",
          input: { command: "false" },
          result: { text: "exit 1", isError: true },
        },
      ],
      { inlineMaxBytes: 2048 },
    );
    expect(panelMarkdownContent(card)).toContain("❌ exit 1");
  });

  it("truncates long result text at inlineMaxBytes", () => {
    const card = buildToolActivityCard(
      [
        {
          toolUseId: "tu_1",
          name: "Bash",
          input: { command: "dump" },
          result: { text: "x".repeat(10000), isError: false },
        },
      ],
      { inlineMaxBytes: 100 },
    );
    expect(panelMarkdownContent(card)).toContain("more bytes omitted");
  });

  it("shows an empty placeholder when the entry list is empty", () => {
    const card = buildToolActivityCard([], { inlineMaxBytes: 2048 });
    const panel = firstCollapsiblePanel(card);
    expect(panel.header.title.content).toBe("🔧 工具活动");
    expect(panelMarkdownContent(card)).toBe("_(no tools yet)_");
  });
});

describe("renderToolActivityBody", () => {
  it("returns the streamable body text that the dispatcher pushes to CardKit", () => {
    // The dispatcher streams the body of the tool activity card
    // separately from the card envelope — this helper is what it
    // calls for every subsequent tool event. The output must match
    // what `buildToolActivityCard` embeds on the initial send so
    // the streaming diff sees a clean prefix extension.
    const entries: ToolActivityEntry[] = [
      {
        toolUseId: "tu_1",
        name: "Bash",
        input: { command: "ls -la" },
        result: { text: "total 24", isError: false },
      },
    ];
    const body = renderToolActivityBody(entries, 2048);
    const cardBody = panelMarkdownContent(
      buildToolActivityCard(entries, { inlineMaxBytes: 2048 }),
    );
    expect(body).toBe(cardBody);
    expect(body.startsWith("共 1 个工具")).toBe(true);
  });

  it("returns the empty placeholder when the entry list is empty", () => {
    expect(renderToolActivityBody([], 2048)).toBe("_(no tools yet)_");
  });
});

describe("buildAnswerCard", () => {
  it("wraps the text in a headerless Card v2 with a single markdown element", () => {
    const card = buildAnswerCard("## Result\n\nEverything **went fine**.");
    expect(card.schema).toBe("2.0");
    expect(card.header).toBeUndefined();
    // Answer cards don't get patched, so update_multi isn't required.
    expect(card.config).toBeUndefined();
    expect(firstMarkdownContent(card)).toBe(
      "## Result\n\nEverything **went fine**.",
    );
  });

  it("shows a placeholder when the answer text is blank", () => {
    const card = buildAnswerCard("");
    expect(firstMarkdownContent(card)).toBe("_(empty)_");
  });

  it("truncates answers longer than the ~28KB card budget", () => {
    const card = buildAnswerCard("x".repeat(40_000));
    const body = firstMarkdownContent(card);
    expect(body).toContain("more bytes omitted");
    // Kept-portion should be under the cap (28KB); full original is 40KB.
    expect(new TextEncoder().encode(body).length).toBeLessThan(29_000);
  });

  it("neutralizes markdown image references so Feishu won't reject the card", () => {
    // A README-style answer with a shields.io badge previously blew
    // up Feishu's card validator with code=230099 "invalid image
    // keys". The sanitizer demotes `![alt](url)` to `[alt](url)` so
    // the card still renders.
    const card = buildAnswerCard(
      "# Project\n\n![Node](https://img.shields.io/badge/Node-16-green)\n\nHello.",
    );
    const body = firstMarkdownContent(card);
    expect(body).not.toContain("![Node]");
    expect(body).toContain("[Node](https://img.shields.io/badge/Node-16-green)");
  });
});

describe("buildStatusCard", () => {
  it("renders a headerless Card v2 with a single streamable markdown element", () => {
    const card = buildStatusCard("💭 思考中...");
    expect(card.schema).toBe("2.0");
    // No top-level header and no collapsible wrapper — status card
    // is meant to be the smallest-possible live cursor.
    expect(card.header).toBeUndefined();
    const elements = card.body?.elements ?? [];
    expect(elements).toHaveLength(1);
    const first = elements[0]!;
    expect(first.tag).toBe("markdown");
    if (first.tag !== "markdown") throw new Error("unreachable");
    // Stable element_id is what lets the dispatcher push subsequent
    // status lines via `cardkit.v1.cardElement.content`.
    expect(first.element_id).toBe(STATUS_ELEMENT_ID);
    expect(first.content).toBe("💭 思考中...");
  });

  it("opts into CardKit streaming + update_multi so the dispatcher can push updates or fall back to patch", () => {
    const card = buildStatusCard("whatever");
    expect(card.config?.update_multi).toBe(true);
    expect(card.config?.streaming_mode).toBe(true);
    expect(card.config?.streaming_config?.print_strategy).toBe("fast");
  });

  it("falls back to a placeholder when given an empty initial line", () => {
    // Dispatcher sends the card at turn start before any Claude
    // event has arrived, so the initial line can legitimately be
    // blank — we still need something to render.
    const card = buildStatusCard("");
    const first = card.body?.elements[0];
    if (!first || first.tag !== "markdown") throw new Error("unreachable");
    expect(first.content).toBe("⏳ 正在处理...");
  });
});

describe("formatRelativeTime", () => {
  const NOW = new Date("2024-04-13T12:00:00.000Z").getTime();

  it("returns '刚刚' for timestamps less than 60s ago (zh)", () => {
    const ts = new Date(NOW - 30_000).toISOString();
    expect(formatRelativeTime(ts, "zh", NOW)).toBe("刚刚");
  });

  it("returns 'just now' for timestamps less than 60s ago (en)", () => {
    const ts = new Date(NOW - 30_000).toISOString();
    expect(formatRelativeTime(ts, "en", NOW)).toBe("just now");
  });

  it("returns minutes for timestamps 1-59 minutes ago", () => {
    const ts = new Date(NOW - 5 * 60_000).toISOString();
    expect(formatRelativeTime(ts, "zh", NOW)).toBe("5 分钟前");
    expect(formatRelativeTime(ts, "en", NOW)).toBe("5m ago");
  });

  it("returns hours for timestamps 1-23 hours ago", () => {
    const ts = new Date(NOW - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(ts, "zh", NOW)).toBe("3 小时前");
    expect(formatRelativeTime(ts, "en", NOW)).toBe("3h ago");
  });

  it("returns days for timestamps 24+ hours ago", () => {
    const ts = new Date(NOW - 2 * 86400_000).toISOString();
    expect(formatRelativeTime(ts, "zh", NOW)).toBe("2 天前");
    expect(formatRelativeTime(ts, "en", NOW)).toBe("2d ago");
  });

  it("returns the raw string for invalid timestamps", () => {
    expect(formatRelativeTime("not-a-date", "zh", NOW)).toBe("not-a-date");
  });
});

describe("buildSessionsCard", () => {
  const NOW = new Date("2024-04-13T12:00:00.000Z").getTime();

  const ENTRIES: SessionEntry[] = [
    {
      chatId: "oc_abc123",
      projectAlias: "my-app",
      record: {
        claudeSessionId: "sess_1",
        cwd: "/home/user/my-app",
        createdAt: "2024-04-13T10:00:00.000Z",
        lastActiveAt: "2024-04-13T11:30:00.000Z",
        model: "claude-opus-4-6",
      },
      active: true,
    },
    {
      chatId: "oc_def456",
      record: {
        claudeSessionId: "sess_2",
        cwd: "/home/user/other",
        createdAt: "2024-04-12T08:00:00.000Z",
        lastActiveAt: "2024-04-11T12:00:00.000Z",
      },
      active: false,
    },
  ];

  it("renders a Card v2 with blue header and session count", () => {
    const card = buildSessionsCard(ENTRIES, "zh", NOW);
    expect(card.schema).toBe("2.0");
    expect(card.header?.title.content).toBe("📋 会话列表");
    expect(card.header?.template).toBe("blue");
    // First body element is the session count
    const first = card.body?.elements[0];
    expect(first).toBeDefined();
    if (first!.tag !== "markdown") throw new Error("unreachable");
    expect(first!.content).toContain("2");
  });

  it("shows project alias when present and '默认项目' when absent (zh)", () => {
    const card = buildSessionsCard(ENTRIES, "zh", NOW);
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain("📁 my-app");
    expect(bodyJson).toContain("默认项目");
  });

  it("shows cwd, model, status, and relative time for each session", () => {
    const card = buildSessionsCard(ENTRIES, "zh", NOW);
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain("/home/user/my-app");
    expect(bodyJson).toContain("claude-opus-4-6");
    expect(bodyJson).toContain("🟢 活跃");
    expect(bodyJson).toContain("⚪ 未活跃");
    expect(bodyJson).toContain("30 分钟前");
  });

  it("uses English strings when locale is en", () => {
    const card = buildSessionsCard(ENTRIES, "en", NOW);
    expect(card.header?.title.content).toBe("📋 Sessions");
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain("🟢 Active");
    expect(bodyJson).toContain("⚪ Stale");
    expect(bodyJson).toContain("Default project");
  });

  it("inserts hr dividers between sessions but not before the first", () => {
    const card = buildSessionsCard(ENTRIES, "zh", NOW);
    const elements = card.body?.elements ?? [];
    // Layout: count-md, hr, session1-md, hr, session2-md
    // Actually: count-md, session1-md, hr, session2-md
    // (no hr before first session, hr between subsequent sessions)
    const tags = elements.map((e) => e.tag);
    // First is markdown (count), second is markdown (session 1),
    // third is hr, fourth is markdown (session 2)
    expect(tags[0]).toBe("markdown");
    expect(tags[1]).not.toBe("hr");
    expect(tags).toContain("hr");
  });

  it("shows '-' for model when model is not set", () => {
    const card = buildSessionsCard(ENTRIES, "zh", NOW);
    const bodyJson = JSON.stringify(card.body);
    // The second entry has no model
    expect(bodyJson).toContain("模型：-");
  });
});

describe("buildProjectsCard", () => {
  const PROJECTS: ProjectEntry[] = [
    { alias: "my-app", cwd: "/home/user/my-app", currentProject: true, sessionStatus: "active" },
    { alias: "infra", cwd: "/home/user/infra", currentProject: false, sessionStatus: "stale" },
    { alias: "docs", cwd: "/home/user/docs", currentProject: false, sessionStatus: "none" },
  ];

  it("renders a Card v2 with blue header titled 📋 项目列表 (zh)", () => {
    const card = buildProjectsCard(PROJECTS, "zh");
    expect(card.schema).toBe("2.0");
    expect(card.header?.title.content).toBe("📋 项目列表");
    expect(card.header?.template).toBe("blue");
  });

  it("renders with English header when locale is en", () => {
    const card = buildProjectsCard(PROJECTS, "en");
    expect(card.header?.title.content).toBe("📋 Projects");
  });

  it("shows project count in the first body element", () => {
    const card = buildProjectsCard(PROJECTS, "zh");
    const first = card.body?.elements[0];
    if (!first || first.tag !== "markdown") throw new Error("expected markdown");
    expect(first.content).toContain("3");
  });

  it("shows alias and cwd for each project", () => {
    const card = buildProjectsCard(PROJECTS, "zh");
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain("my-app");
    expect(bodyJson).toContain("/home/user/my-app");
    expect(bodyJson).toContain("infra");
    expect(bodyJson).toContain("/home/user/infra");
  });

  it("marks the current project with 📌 当前", () => {
    const card = buildProjectsCard(PROJECTS, "zh");
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain("📌");
  });

  it("shows 🟢 for active session, ⚪ for stale, — for none", () => {
    const card = buildProjectsCard(PROJECTS, "zh");
    const bodyJson = JSON.stringify(card.body);
    expect(bodyJson).toContain("🟢");
    expect(bodyJson).toContain("⚪");
    expect(bodyJson).toContain("— 无会话");
  });

  it("inserts hr dividers between projects but not before the first", () => {
    const card = buildProjectsCard(PROJECTS, "zh");
    const tags = (card.body?.elements ?? []).map((e) => e.tag);
    // count-md, proj1-md, hr, proj2-md, hr, proj3-md
    expect(tags[0]).toBe("markdown");
    expect(tags[1]).toBe("markdown"); // first project (no hr before it)
    expect(tags[2]).toBe("hr");
  });

  it("handles a single project without hr", () => {
    const single: ProjectEntry[] = [
      { alias: "solo", cwd: "/solo", currentProject: false, sessionStatus: "none" },
    ];
    const card = buildProjectsCard(single, "zh");
    const tags = (card.body?.elements ?? []).map((e) => e.tag);
    expect(tags).not.toContain("hr");
  });
});

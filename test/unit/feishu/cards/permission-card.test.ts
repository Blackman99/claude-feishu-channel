import { describe, it, expect } from "vitest";
import {
  buildPermissionCard,
  buildPermissionCardResolved,
  buildPermissionCardCancelled,
  buildPermissionCardTimedOut,
} from "../../../../src/feishu/cards/permission-card.js";

describe("buildPermissionCard (pending)", () => {
  it("renders header with toolName and 4 buttons each tagged with the request_id", () => {
    const card = buildPermissionCard({
      requestId: "req_abc",
      toolName: "Bash",
      input: { command: "ls -la" },
      ownerOpenId: "ou_owner",
    });
    expect(card.schema).toBe("2.0");
    expect(card.config?.update_multi).toBe(true);
    expect(card.header?.title.content).toContain("Bash");

    // Flatten all button value objects.
    const buttons: Array<{ choice?: unknown; request_id?: unknown; kind?: unknown }> = [];
    function walk(el: unknown): void {
      if (!el || typeof el !== "object") return;
      const e = el as { tag?: string; value?: Record<string, unknown>; elements?: unknown[]; columns?: unknown[] };
      if (e.tag === "button" && e.value) buttons.push(e.value as typeof buttons[number]);
      if (Array.isArray(e.elements)) e.elements.forEach(walk);
      if (Array.isArray(e.columns)) e.columns.forEach(walk);
    }
    card.body?.elements.forEach(walk);
    expect(buttons).toHaveLength(4);
    const choices = buttons.map((b) => b.choice);
    expect(choices).toEqual(
      expect.arrayContaining(["allow", "deny", "allow_turn", "allow_session"]),
    );
    for (const b of buttons) {
      expect(b.kind).toBe("permission");
      expect(b.request_id).toBe("req_abc");
    }
  });

  it("shows a code-block preview of the tool input, truncated to ~2KB", () => {
    const huge = "x".repeat(10_000);
    const card = buildPermissionCard({
      requestId: "r",
      toolName: "Edit",
      input: { content: huge },
      ownerOpenId: "ou",
    });
    const serialized = JSON.stringify(card);
    // Card must not blow past a reasonable size.
    expect(serialized.length).toBeLessThan(6_000);
  });

  it("includes an owner-only disclaimer in the body", () => {
    const card = buildPermissionCard({
      requestId: "r",
      toolName: "Bash",
      input: {},
      ownerOpenId: "ou",
    });
    const text = JSON.stringify(card);
    expect(text).toMatch(/发起者|owner|only/i);
  });
});

describe("buildPermissionCardResolved", () => {
  it("renders a one-line confirmation without buttons or header", () => {
    const card = buildPermissionCardResolved({
      toolName: "Bash",
      choice: "allow",
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(card.header).toBeUndefined();
    expect(card.body?.elements).toHaveLength(1);
    expect(json).toMatch(/允许|allow/);
    expect(json).toContain("Bash");
  });

  it("labels the deny variant correctly", () => {
    const card = buildPermissionCardResolved({
      toolName: "Bash",
      choice: "deny",
    });
    expect(JSON.stringify(card)).toMatch(/拒绝|denied/);
  });

  it("labels the allow_turn variant with the acceptEdits text", () => {
    const card = buildPermissionCardResolved({
      toolName: "Bash",
      choice: "allow_turn",
    });
    expect(JSON.stringify(card)).toMatch(/本轮.*acceptEdits/);
  });

  it("labels the allow_session variant", () => {
    const card = buildPermissionCardResolved({
      toolName: "Bash",
      choice: "allow_session",
    });
    expect(JSON.stringify(card)).toMatch(/会话.*acceptEdits/);
  });
});

describe("buildPermissionCardCancelled", () => {
  it("renders a cancelled notice without buttons", () => {
    const card = buildPermissionCardCancelled({
      toolName: "Bash",
      reason: "User issued /stop",
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(json).toMatch(/取消|cancel/i);
    expect(json).toContain("/stop");
  });
});

describe("buildPermissionCardTimedOut", () => {
  it("renders a timed-out notice without buttons", () => {
    const card = buildPermissionCardTimedOut({ toolName: "Bash" });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"button"');
    expect(json).toMatch(/超时|timed out/i);
  });
});

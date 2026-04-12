import { describe, it, expect } from "vitest";
import {
  buildCdConfirmCard,
  buildCdConfirmResolved,
  buildCdConfirmCancelled,
  buildCdConfirmTimedOut,
} from "../../../../src/feishu/cards/cd-confirm-card.js";

/** Walk all elements recursively and collect button value objects. */
function collectButtons(card: ReturnType<typeof buildCdConfirmCard>): Array<Record<string, unknown>> {
  const buttons: Array<Record<string, unknown>> = [];
  function walk(el: unknown): void {
    if (!el || typeof el !== "object") return;
    const e = el as { tag?: string; value?: Record<string, unknown>; elements?: unknown[]; columns?: unknown[] };
    if (e.tag === "button" && e.value) buttons.push(e.value);
    if (Array.isArray(e.elements)) e.elements.forEach(walk);
    if (Array.isArray(e.columns)) e.columns.forEach(walk);
  }
  card.body?.elements.forEach(walk);
  return buttons;
}

describe("buildCdConfirmCard (pending)", () => {
  it("has schema 2.0 and update_multi true", () => {
    const card = buildCdConfirmCard({ requestId: "req_123", targetPath: "/home/user" });
    expect(card.schema).toBe("2.0");
    expect(card.config?.update_multi).toBe(true);
  });

  it("has a blue header containing 切换工作目录", () => {
    const card = buildCdConfirmCard({ requestId: "req_123", targetPath: "/home/user" });
    expect(card.header?.title.content).toContain("切换工作目录");
    expect(card.header?.template).toBe("blue");
  });

  it("includes the target path in the body", () => {
    const card = buildCdConfirmCard({ requestId: "req_123", targetPath: "/home/user/projects" });
    expect(JSON.stringify(card)).toContain("/home/user/projects");
  });

  it("has exactly 2 buttons (confirm and cancel)", () => {
    const card = buildCdConfirmCard({ requestId: "req_abc", targetPath: "/tmp" });
    const buttons = collectButtons(card);
    expect(buttons).toHaveLength(2);
  });

  it("buttons carry kind=cd_confirm with request_id and accepted boolean", () => {
    const card = buildCdConfirmCard({ requestId: "req_xyz", targetPath: "/tmp" });
    const buttons = collectButtons(card);
    for (const b of buttons) {
      expect(b.kind).toBe("cd_confirm");
      expect(b.request_id).toBe("req_xyz");
      expect(typeof b.accepted).toBe("boolean");
    }
    const acceptedValues = buttons.map((b) => b.accepted);
    expect(acceptedValues).toContain(true);
    expect(acceptedValues).toContain(false);
  });

  it("includes an owner-only footer note", () => {
    const card = buildCdConfirmCard({ requestId: "req_1", targetPath: "/tmp" });
    expect(JSON.stringify(card)).toMatch(/发起者|owner|only/i);
  });

  it("uses a column_set layout for buttons", () => {
    const card = buildCdConfirmCard({ requestId: "req_1", targetPath: "/tmp" });
    const json = JSON.stringify(card);
    expect(json).toContain('"tag":"column_set"');
  });
});

describe("buildCdConfirmResolved", () => {
  it("shows the path in a markdown element, no header, no buttons", () => {
    const card = buildCdConfirmResolved({ targetPath: "/workspace/myapp" });
    const json = JSON.stringify(card);
    expect(card.header).toBeUndefined();
    expect(json).not.toContain('"tag":"button"');
    expect(json).toContain("/workspace/myapp");
  });

  it("contains 工作目录已切换 text", () => {
    const card = buildCdConfirmResolved({ targetPath: "/foo" });
    expect(JSON.stringify(card)).toMatch(/工作目录已切换/);
  });

  it("body has exactly one element", () => {
    const card = buildCdConfirmResolved({ targetPath: "/foo" });
    expect(card.body?.elements).toHaveLength(1);
  });
});

describe("buildCdConfirmCancelled", () => {
  it("shows a cancel notice, no header, no buttons", () => {
    const card = buildCdConfirmCancelled();
    const json = JSON.stringify(card);
    expect(card.header).toBeUndefined();
    expect(json).not.toContain('"tag":"button"');
    expect(json).toMatch(/取消/);
  });

  it("body has exactly one element", () => {
    const card = buildCdConfirmCancelled();
    expect(card.body?.elements).toHaveLength(1);
  });
});

describe("buildCdConfirmTimedOut", () => {
  it("shows a timeout notice, no header, no buttons", () => {
    const card = buildCdConfirmTimedOut();
    const json = JSON.stringify(card);
    expect(card.header).toBeUndefined();
    expect(json).not.toContain('"tag":"button"');
    expect(json).toMatch(/超时/);
  });

  it("body has exactly one element", () => {
    const card = buildCdConfirmTimedOut();
    expect(card.body?.elements).toHaveLength(1);
  });
});

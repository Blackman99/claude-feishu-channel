import { describe, it, expect } from "vitest";
import {
  TransitionalStubBroker,
  type PermissionRequest,
} from "../../../src/claude/permission-broker.js";

describe("TransitionalStubBroker", () => {
  const req: PermissionRequest = {
    toolName: "Bash",
    input: { command: "ls" },
    chatId: "oc_x",
    ownerOpenId: "ou_x",
    parentMessageId: "om_x",
  };

  it("throws on request()", async () => {
    await expect(new TransitionalStubBroker().request(req)).rejects.toThrow(
      /not wired yet/i,
    );
  });

  it("throws on resolveByCard()", async () => {
    await expect(
      new TransitionalStubBroker().resolveByCard({
        requestId: "r1",
        senderOpenId: "ou_x",
        choice: "allow",
      }),
    ).rejects.toThrow(/not wired yet/i);
  });

  it("cancelAll is a silent no-op", () => {
    expect(() => new TransitionalStubBroker().cancelAll("test")).not.toThrow();
  });
});

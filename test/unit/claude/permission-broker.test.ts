import { describe, it, expect } from "vitest";
import {
  NullPermissionBroker,
  type PermissionRequest,
} from "../../../src/claude/permission-broker.js";

describe("NullPermissionBroker", () => {
  it("throws on request() with a clear 'Phase 5 not wired' error", async () => {
    const broker = new NullPermissionBroker();
    const req: PermissionRequest = {
      toolName: "Bash",
      input: { command: "rm -rf /" },
      chatId: "oc_x",
    };
    await expect(broker.request(req)).rejects.toThrow(
      /Phase 5|not wired|NullPermissionBroker/i,
    );
  });
});

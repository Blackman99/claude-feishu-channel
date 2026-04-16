import { describe, it, expect } from "vitest";
import { AccessControl, type AccessDecision } from "../../src/access.js";

describe("AccessControl", () => {
  it("allows whitelisted open_id", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      unauthorizedBehavior: "ignore",
    });
    const decision: AccessDecision = ac.check("ou_alice");
    expect(decision).toEqual({ allowed: true });
  });

  it("denies non-whitelisted open_id with ignore behavior", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      unauthorizedBehavior: "ignore",
    });
    expect(ac.check("ou_bob")).toEqual({
      allowed: false,
      action: "ignore",
    });
  });

  it("denies non-whitelisted open_id with reject behavior", () => {
    const ac = new AccessControl({
      allowedOpenIds: ["ou_alice"],
      unauthorizedBehavior: "reject",
    });
    expect(ac.check("ou_bob")).toEqual({
      allowed: false,
      action: "reject",
    });
  });

  it("denies when whitelist is empty", () => {
    const ac = new AccessControl({
      allowedOpenIds: [],
      unauthorizedBehavior: "ignore",
    });
    expect(ac.check("ou_alice")).toEqual({
      allowed: false,
      action: "ignore",
    });
  });
});

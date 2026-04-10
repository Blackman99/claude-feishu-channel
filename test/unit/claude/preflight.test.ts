import { describe, it, expect } from "vitest";
import { checkCredentials } from "../../../src/claude/preflight.js";

describe("checkCredentials", () => {
  it("accepts ANTHROPIC_API_KEY", () => {
    expect(checkCredentials({ ANTHROPIC_API_KEY: "sk-ant-xxx" })).toEqual({
      ok: true,
    });
  });

  it("accepts CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(
      checkCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok_xxx" }),
    ).toEqual({ ok: true });
  });

  it("accepts CLAUDE_CODE_USE_BEDROCK=1", () => {
    expect(checkCredentials({ CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual({
      ok: true,
    });
  });

  it("accepts CLAUDE_CODE_USE_VERTEX=1", () => {
    expect(checkCredentials({ CLAUDE_CODE_USE_VERTEX: "1" })).toEqual({
      ok: true,
    });
  });

  it("accepts CLAUDE_CODE_USE_FOUNDRY=1", () => {
    expect(checkCredentials({ CLAUDE_CODE_USE_FOUNDRY: "1" })).toEqual({
      ok: true,
    });
  });

  it("rejects when no credential source is present", () => {
    const result = checkCredentials({});
    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/ANTHROPIC_API_KEY/),
    });
  });

  it("treats empty string env var as unset", () => {
    const result = checkCredentials({ ANTHROPIC_API_KEY: "" });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/ANTHROPIC_API_KEY/),
    });
  });
});

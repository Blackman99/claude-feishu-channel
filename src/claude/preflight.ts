export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify at least one credential source is present so the Claude Code
 * runtime bundled inside @anthropic-ai/claude-agent-sdk can authenticate.
 * The SDK ships its own cli.js, so we do not check for an external
 * `claude` binary.
 */
export function checkCredentials(
  env: Readonly<Record<string, string | undefined>>,
): PreflightResult {
  if (env["ANTHROPIC_API_KEY"]) return { ok: true };
  if (env["ANTHROPIC_AUTH_TOKEN"]) return { ok: true };
  if (env["CLAUDE_CODE_OAUTH_TOKEN"]) return { ok: true };
  if (env["CLAUDE_CODE_USE_BEDROCK"] === "1") return { ok: true };
  if (env["CLAUDE_CODE_USE_VERTEX"] === "1") return { ok: true };
  if (env["CLAUDE_CODE_USE_FOUNDRY"] === "1") return { ok: true };
  return {
    ok: false,
    reason:
      "No Claude credentials detected. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, " +
      "or CLAUDE_CODE_OAUTH_TOKEN (or CLAUDE_CODE_USE_BEDROCK=1 / CLAUDE_CODE_USE_VERTEX=1 " +
      "/ CLAUDE_CODE_USE_FOUNDRY=1).",
  };
}

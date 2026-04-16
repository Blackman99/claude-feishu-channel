import type { AgentProvider, AppConfig, PermissionMode } from "../types.js";

export interface ProviderDefaults {
  provider: AgentProvider;
  cwd: string;
  permissionMode: PermissionMode;
}

export function getProviderDefaults(
  config: Pick<AppConfig, "agent">,
): ProviderDefaults {
  return {
    provider: config.agent.defaultProvider,
    cwd: config.agent.defaultCwd,
    permissionMode: config.agent.defaultPermissionMode,
  };
}

export function defaultModelForProvider(
  provider: AgentProvider,
  config: Pick<AppConfig, "claude" | "codex">,
): string {
  return provider === "claude"
    ? config.claude.defaultModel
    : config.codex.defaultModel;
}

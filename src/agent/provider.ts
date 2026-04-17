import type { AgentProvider, PermissionMode } from "../types.js";

export const PROVIDER_IDS = ["claude", "codex"] as const;

export interface ProviderRunOptions {
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  resumeId?: string;
}

export interface ProviderRunHandle<Message = unknown> {
  readonly messages: AsyncIterable<Message>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): void;
}

export interface ProviderRunRequest<Prompt = unknown, CanUseTool = unknown> {
  prompt: string | AsyncIterable<Prompt>;
  options: ProviderRunOptions;
  canUseTool: CanUseTool;
}

export interface RuntimeProvider<
  Prompt = unknown,
  Message = unknown,
  CanUseTool = unknown,
> {
  readonly id: AgentProvider;
  startRun(params: ProviderRunRequest<Prompt, CanUseTool>): ProviderRunHandle<Message>;
}

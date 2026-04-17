import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import type { SDKMessageLike } from "./session.js";
import type { QueryFn, QueryHandle } from "./query-handle.js";

export interface SdkQueryFnOptions {
  /** Path to the `claude` CLI binary the SDK should spawn. */
  cliPath: string;
  logger: Logger;
}

/**
 * Build a `QueryFn` that drives turns through `@anthropic-ai/claude-agent-sdk`'s
 * `query()`. The SDK spawns the `claude` binary under the hood (via
 * `pathToClaudeCodeExecutable`), manages the stream-json protocol, and
 * exposes `canUseTool` as a TypeScript callback — which is what Phase 5's
 * permission broker needs.
 *
 * Environment variable inheritance (including `ANTHROPIC_BASE_URL` /
 * `ANTHROPIC_AUTH_TOKEN` for self-hosted endpoints) happens by passing
 * `env: { ...process.env }` into the options — the SDK forwards it to
 * the spawned child.
 *
 * The returned `QueryHandle.interrupt()` aborts the SDK's
 * `AbortController` and is idempotent.
 *
 * `setPermissionMode()` forwards to `q.setPermissionMode()` which the
 * SDK exposes for mid-turn permission mode changes (used for the
 * "本轮 acceptEdits" button).
 */
export function createSdkQueryFn(opts: SdkQueryFnOptions): QueryFn {
  return (params) => {
    const abort = new AbortController();
    let aborted = false;

    const q = query({
      prompt: params.prompt,
      options: {
        cwd: params.options.cwd,
        model: params.options.model,
        permissionMode: params.options.permissionMode,
        settingSources: params.options.settingSources as ("project" | "user" | "local")[],
        canUseTool: params.canUseTool,
        pathToClaudeCodeExecutable: opts.cliPath,
        abortController: abort,
        env: { ...process.env },
        ...(params.options.resumeId ? { resume: params.options.resumeId } : {}),
        ...(params.options.mcpServers ? { mcpServers: params.options.mcpServers } : {}),
        ...(params.options.disallowedTools
          ? { disallowedTools: [...params.options.disallowedTools] }
          : {}),
      },
    });

    const messages: AsyncIterable<SDKMessageLike> = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const msg of q as AsyncIterable<SDKMessageLike>) {
            yield msg;
          }
        } catch (err) {
          if (aborted) {
            opts.logger.debug(
              { err },
              "sdk-query iterator threw after abort — expected",
            );
            return;
          }
          throw err;
        }
      },
    };

    const interrupt = async (): Promise<void> => {
      if (aborted) return;
      aborted = true;
      abort.abort();
      // The SDK's for-await loop will observe the abort on its next
      // pull and throw; the generator wrapper above swallows that
      // expected throw. No separate drain handle is needed.
    };

    const setPermissionMode = (
      mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
    ): void => {
      try {
        void (q as { setPermissionMode?: (m: string) => Promise<void> }).setPermissionMode?.(
          mode,
        );
      } catch (err) {
        opts.logger.warn({ err, mode }, "sdk-query setPermissionMode threw");
      }
    };

    const handle: QueryHandle = {
      messages,
      interrupt,
      setPermissionMode,
    };
    return handle;
  };
}

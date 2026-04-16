import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import type {
  Codex as CodexCtor,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  UserInput,
} from "@openai/codex-sdk";
import type { QueryFn, QueryHandle } from "../claude/query-handle.js";
import type { SDKContentBlock, SDKMessageLike } from "../claude/session.js";
import type { PermissionMode } from "../types.js";

const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

interface ImageBase64Source {
  media_type: string;
  data: string;
}

function extractImageSource(block: SDKContentBlock): ImageBase64Source | undefined {
  const source = (block as { source?: unknown }).source;
  if (!source || typeof source !== "object") return undefined;
  const s = source as Record<string, unknown>;
  if (s.type !== "base64") return undefined;
  const mediaType = typeof s.media_type === "string" ? s.media_type : undefined;
  const data = typeof s.data === "string" ? s.data : undefined;
  if (!mediaType || !data) return undefined;
  return { media_type: mediaType, data };
}

interface PromptInputResult {
  input: string | UserInput[];
  cleanup: () => Promise<void>;
}

type CodexModule = typeof import("@openai/codex-sdk");

export interface CodexQueryFnOptions {
  cliPath: string;
  logger: Logger;
  loadSdk?: () => Promise<CodexModule>;
}

async function loadCodexSdk(
  loader?: () => Promise<CodexModule>,
): Promise<CodexModule> {
  try {
    return loader ? await loader() : await import("@openai/codex-sdk");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to load @openai/codex-sdk. Install the package or provide a test loader. Original error: ${message}`,
    );
  }
}

export async function checkCodexSdkInstalled(
  loader?: () => Promise<CodexModule>,
): Promise<void> {
  await loadCodexSdk(loader);
}

function makeAssistantMessage(
  block: SDKContentBlock,
): SDKMessageLike {
  return {
    type: "assistant",
    message: {
      content: [block],
    },
  };
}

function makeResultMessage(
  sessionId: string | undefined,
  usage?: { input_tokens: number; output_tokens: number },
): SDKMessageLike {
  return {
    type: "result",
    subtype: "success",
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(usage
      ? {
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        },
      }
      : {}),
  };
}

function deltaText(
  cache: Map<string, string>,
  id: string,
  next: string,
): string {
  const prev = cache.get(id) ?? "";
  cache.set(id, next);
  if (!prev) return next;
  if (next.startsWith(prev)) return next.slice(prev.length);
  return next;
}

function mapPermissionMode(mode: PermissionMode): Pick<ThreadOptions, "approvalPolicy" | "sandboxMode"> {
  switch (mode) {
    case "plan":
      return {
        approvalPolicy: "on-request",
        sandboxMode: "read-only",
      };
    case "bypassPermissions":
      return {
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      };
    case "acceptEdits":
      return {
        approvalPolicy: "on-failure",
        sandboxMode: "workspace-write",
      };
    case "default":
    default:
      return {
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      };
  }
}

function buildThreadOptions(
  params: Parameters<QueryFn>[0],
): ThreadOptions {
  return {
    model: params.options.model,
    workingDirectory: params.options.cwd,
    skipGitRepoCheck: true,
    ...mapPermissionMode(params.options.permissionMode),
  };
}

function buildTurnOptions(
  signal: AbortSignal,
): TurnOptions {
  return { signal };
}

async function promptToInput(
  prompt: string | AsyncIterable<unknown>,
  logger: Logger,
): Promise<PromptInputResult> {
  const noCleanup = async (): Promise<void> => {};
  if (typeof prompt === "string") return { input: prompt, cleanup: noCleanup };

  const parts: UserInput[] = [];
  let tempDir: string | undefined;
  let imageCounter = 0;

  const ensureTempDir = async (): Promise<string> => {
    if (tempDir === undefined) {
      tempDir = await mkdtemp(path.join(tmpdir(), "afc-codex-img-"));
    }
    return tempDir;
  };

  for await (const chunk of prompt) {
    if (!chunk || typeof chunk !== "object") continue;
    const record = chunk as Record<string, unknown>;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: readonly SDKContentBlock[] }).content;
    if (!content) continue;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        parts.push({ type: "text", text: block.text });
        continue;
      }
      if (block.type === "image") {
        const source = extractImageSource(block);
        if (!source) {
          logger.warn("Codex image block has no base64 source; omitting");
          parts.push({
            type: "text",
            text: "[image omitted: missing base64 source]",
          });
          continue;
        }
        try {
          const dir = await ensureTempDir();
          const ext = MIME_EXTENSION[source.media_type] ?? "bin";
          const filePath = path.join(dir, `image-${imageCounter}.${ext}`);
          imageCounter += 1;
          await writeFile(filePath, Buffer.from(source.data, "base64"));
          parts.push({ type: "local_image", path: filePath });
        } catch (err) {
          logger.warn(
            { err, mediaType: source.media_type },
            "Failed to materialize Codex image to temp file; omitting",
          );
          parts.push({
            type: "text",
            text: "[image omitted: failed to write temp file]",
          });
        }
      }
    }
  }

  const cleanup = async (): Promise<void> => {
    if (tempDir === undefined) return;
    const dir = tempDir;
    tempDir = undefined;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.debug({ err, dir }, "failed to remove codex image temp dir");
    }
  };

  if (parts.length === 0) {
    return { input: "[input omitted]", cleanup };
  }
  if (parts.length === 1 && parts[0]?.type === "text") {
    return { input: parts[0].text, cleanup };
  }
  return { input: parts, cleanup };
}

function mapItemStarted(item: ThreadItem): SDKMessageLike | undefined {
  switch (item.type) {
    case "command_execution":
      return makeAssistantMessage({
        type: "tool_use",
        id: item.id,
        name: "command_execution",
        input: { command: item.command },
      });
    case "mcp_tool_call":
      return makeAssistantMessage({
        type: "tool_use",
        id: item.id,
        name: `mcp:${item.server}/${item.tool}`,
        input: item.arguments,
      });
    case "web_search":
      return makeAssistantMessage({
        type: "tool_use",
        id: item.id,
        name: "web_search",
        input: { query: item.query },
      });
    case "file_change":
      return makeAssistantMessage({
        type: "tool_use",
        id: item.id,
        name: "file_change",
        input: { changes: item.changes, status: item.status },
      });
    case "todo_list":
      return makeAssistantMessage({
        type: "tool_use",
        id: item.id,
        name: "todo_list",
        input: { items: item.items },
      });
    default:
      return undefined;
  }
}

function mapTextItem(
  item: ThreadItem,
  textCache: Map<string, string>,
): SDKMessageLike | undefined {
  if (item.type === "agent_message") {
    const text = deltaText(textCache, item.id, item.text);
    return text
      ? makeAssistantMessage({ type: "text", text })
      : undefined;
  }
  if (item.type === "reasoning") {
    const text = deltaText(textCache, item.id, item.text);
    return text
      ? makeAssistantMessage({ type: "thinking", thinking: text })
      : undefined;
  }
  if (item.type === "error") {
    return makeAssistantMessage({ type: "text", text: item.message });
  }
  return undefined;
}

export function createCodexQueryFn(
  opts: CodexQueryFnOptions,
): QueryFn {
  return (params) => {
    const abort = new AbortController();
    let interrupted = false;
    const textCache = new Map<string, string>();

    const messages: AsyncIterable<SDKMessageLike> = {
      async *[Symbol.asyncIterator]() {
        const sdk = await loadCodexSdk(opts.loadSdk);
        const codex = new sdk.Codex({
          codexPathOverride: opts.cliPath,
        });
        const threadOptions = buildThreadOptions(params);
        const thread = params.options.resumeId
          ? codex.resumeThread(params.options.resumeId, threadOptions)
          : codex.startThread(threadOptions);

        const { input, cleanup } = await promptToInput(
          params.prompt as string | AsyncIterable<unknown>,
          opts.logger,
        );
        let streamed: Awaited<ReturnType<typeof thread.runStreamed>>;
        try {
          streamed = await thread.runStreamed(input, buildTurnOptions(abort.signal));
        } catch (err) {
          await cleanup();
          throw err;
        }
        const { events } = streamed;
        let threadId = thread.id ?? undefined;

        try {
          for await (const event of events) {
            if (event.type === "thread.started") {
              threadId = event.thread_id;
              continue;
            }

            if (event.type === "item.started") {
              const started = mapItemStarted(event.item);
              if (started) yield started;
              const textItem = mapTextItem(event.item, textCache);
              if (textItem) yield textItem;
              continue;
            }

            if (event.type === "item.updated" || event.type === "item.completed") {
              const textItem = mapTextItem(event.item, textCache);
              if (textItem) yield textItem;
              continue;
            }

            if (event.type === "turn.completed") {
              yield makeResultMessage(threadId ?? thread.id ?? undefined, {
                input_tokens: event.usage.input_tokens,
                output_tokens: event.usage.output_tokens,
              });
              continue;
            }

            if (event.type === "turn.failed") {
              throw new Error(event.error.message);
            }

            if (event.type === "error") {
              throw new Error(event.message);
            }
          }
        } catch (err) {
          if (interrupted || abort.signal.aborted) {
            opts.logger.debug({ err }, "codex sdk stream aborted");
            return;
          }
          throw err;
        } finally {
          await cleanup();
        }
      },
    };

    const interrupt = async (): Promise<void> => {
      interrupted = true;
      abort.abort();
    };

    const setPermissionMode = (_mode: PermissionMode): void => {
      // The current SDK exposes per-thread approval policy, but not a public
      // mid-turn mutation hook. We keep this as an explicit no-op rather than
      // pretending Claude's runtime-mode flip exists here.
      opts.logger.debug("codex sdk setPermissionMode is a no-op in this adapter");
    };

    const handle: QueryHandle = {
      messages,
      interrupt,
      setPermissionMode,
    };
    return handle;
  };
}

import type { Logger } from "pino";
import { Mutex } from "../util/mutex.js";
import type { AppConfig } from "../types.js";
import type { RenderEvent } from "./render-event.js";
import { extractToolResultText, type ToolResultBlock } from "../feishu/tool-result.js";

/**
 * Shallow structural subset of the Claude Code stream-json message
 * union (same shape as the SDK's `SDKMessage`). Phase 3 narrows on
 * only the fields we read when dispatching RenderEvents, so any
 * transport — in-process SDK or CLI subprocess — can yield these.
 */
export interface SDKMessageLike {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: readonly SDKContentBlock[] };
  result?: string;
  errors?: readonly string[];
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface SDKContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | readonly ToolResultBlock[];
}

export interface ClaudeQueryOptions {
  cwd: string;
  model: string;
  permissionMode: AppConfig["claude"]["defaultPermissionMode"];
  /** Which setting sources the SDK should load (CLAUDE.md, etc). */
  settingSources: readonly ("project" | "user" | "local")[];
}

/**
 * Structural interface of the SDK's `query` function. `src/index.ts` wraps
 * the real SDK `query` into this shape so unit tests can inject a fake.
 */
export type QueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
}) => AsyncIterable<SDKMessageLike>;

export interface ClaudeSessionOptions {
  chatId: string;
  config: AppConfig["claude"];
  queryFn: QueryFn;
  logger: Logger;
}

export type RenderEventEmitter = (event: RenderEvent) => Promise<void>;

/**
 * Phase 3 ClaudeSession: streams RenderEvents as SDK messages arrive,
 * so the consumer can send each content block to Feishu as its own
 * message / card. Still single-turn (no cross-message resume). A per-
 * instance Mutex serializes concurrent handleMessage calls for the
 * same chat.
 */
export class ClaudeSession {
  private readonly config: AppConfig["claude"];
  private readonly queryFn: QueryFn;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();

  constructor(opts: ClaudeSessionOptions) {
    this.config = opts.config;
    this.queryFn = opts.queryFn;
    this.logger = opts.logger.child({ chat_id: opts.chatId });
  }

  async handleMessage(
    text: string,
    emit: RenderEventEmitter,
  ): Promise<void> {
    await this.mutex.run(async () => {
      this.logger.info({ len: text.length }, "Claude turn start");
      const turnStartMs = Date.now();
      const iter = this.queryFn({
        prompt: text,
        options: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode: this.config.defaultPermissionMode,
          settingSources: ["project"],
        },
      });

      let resultMsg: SDKMessageLike | undefined;
      let firstMessageLogged = false;
      for await (const msg of iter) {
        if (!firstMessageLogged) {
          firstMessageLogged = true;
          this.logger.info(
            { firstMessageMs: Date.now() - turnStartMs, type: msg.type },
            "Claude first message received",
          );
        } else {
          this.logger.debug(
            { type: msg.type, subtype: msg.subtype },
            "Claude sdk message",
          );
        }
        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            await this.emitAssistantBlock(block, emit);
          }
        } else if (msg.type === "user" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "tool_result") {
              await emit({
                type: "tool_result",
                toolUseId: block.tool_use_id ?? "",
                isError: block.is_error === true,
                text: extractToolResultText(block.content),
              });
            }
          }
        } else if (msg.type === "result") {
          resultMsg = msg;
          // Do NOT break here — let the generator finish naturally.
        }
      }

      if (resultMsg === undefined) {
        throw new Error("Claude turn ended without a result message");
      }
      if (resultMsg.subtype !== "success") {
        const errs = resultMsg.errors?.join("; ") ?? "unknown error";
        this.logger.error(
          { subtype: resultMsg.subtype, errors: resultMsg.errors },
          "Claude turn errored",
        );
        throw new Error(`Claude turn failed (${resultMsg.subtype}): ${errs}`);
      }

      await emit({
        type: "turn_end",
        durationMs: resultMsg.duration_ms ?? 0,
        inputTokens: resultMsg.usage?.input_tokens ?? 0,
        outputTokens: resultMsg.usage?.output_tokens ?? 0,
      });
      this.logger.info(
        { durationMs: resultMsg.duration_ms },
        "Claude turn complete",
      );
    });
  }

  private async emitAssistantBlock(
    block: SDKContentBlock,
    emit: RenderEventEmitter,
  ): Promise<void> {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      await emit({ type: "text", text: block.text });
      return;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      await emit({ type: "thinking", text: block.thinking });
      return;
    }
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      await emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      return;
    }
    // Unknown / empty blocks are silently dropped — Phase 3 explicitly
    // ignores redacted_thinking, image blocks, etc. Phase 8 polish can
    // add handling when a use case arises.
  }
}

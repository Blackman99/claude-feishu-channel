import type { Logger } from "pino";
import { Mutex } from "../util/mutex.js";
import { extractAssistantText } from "../feishu/renderer.js";
import type { AppConfig } from "../types.js";

/**
 * Shallow structural subset of `@anthropic-ai/claude-agent-sdk`'s `SDKMessage`
 * union. Only the fields Phase 2 narrows on are declared; the SDK's real type
 * is a superset and is assignable to this interface. Phase 3+ will replace
 * this with richer typing as tool/thinking rendering lands.
 */
export interface SDKMessageLike {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: readonly { type: string; text?: string }[] };
  result?: string;
  errors?: readonly string[];
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

/**
 * Phase 2 ClaudeSession: one message in → one `query()` call → concatenated
 * assistant text out. No cross-message resume, no queue, no state machine.
 * Concurrent `handleMessage` calls for the same chat are serialized by a
 * Mutex so that a second message cannot preempt an in-flight turn.
 */
export class ClaudeSession {
  private readonly chatId: string;
  private readonly config: AppConfig["claude"];
  private readonly queryFn: QueryFn;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();

  constructor(opts: ClaudeSessionOptions) {
    this.chatId = opts.chatId;
    this.config = opts.config;
    this.queryFn = opts.queryFn;
    this.logger = opts.logger.child({ chat_id: opts.chatId });
  }

  async handleMessage(text: string): Promise<string> {
    return this.mutex.run(async () => {
      this.logger.info({ len: text.length }, "Claude turn start");
      const iter = this.queryFn({
        prompt: text,
        options: {
          cwd: this.config.defaultCwd,
          model: this.config.defaultModel,
          permissionMode: this.config.defaultPermissionMode,
          settingSources: ["project"],
        },
      });

      const chunks: string[] = [];
      let resultMsg: SDKMessageLike | undefined;
      for await (const msg of iter) {
        if (msg.type === "assistant" && msg.message?.content) {
          const partial = extractAssistantText(msg.message.content);
          if (partial !== null) chunks.push(partial);
        } else if (msg.type === "result") {
          resultMsg = msg;
          // Do NOT break or return here — allow the generator to finish
          // so any post-yield teardown in the generator runs naturally.
        }
      }
      if (resultMsg !== undefined) {
        if (resultMsg.subtype === "success") {
          this.logger.info(
            { chunks: chunks.length },
            "Claude turn complete",
          );
          return chunks.join("\n");
        }
        const errs = resultMsg.errors?.join("; ") ?? "unknown error";
        this.logger.error(
          { subtype: resultMsg.subtype, errors: resultMsg.errors },
          "Claude turn errored",
        );
        throw new Error(`Claude turn failed (${resultMsg.subtype}): ${errs}`);
      }
      throw new Error("Claude turn ended without a result message");
    });
  }
}

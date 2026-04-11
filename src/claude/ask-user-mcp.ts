import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Logger } from "pino";
import type {
  AskUserQuestionSpec,
  QuestionBroker,
  QuestionResponse,
} from "./question-broker.js";

/** Fixed server name — visible to Claude as `mcp__feishu__ask_user`. */
const SERVER_NAME = "feishu";

/** Zod schema mirroring the built-in `AskUserQuestionInput`. */
const askUserInputSchema = {
  questions: z
    .array(
      z.object({
        question: z
          .string()
          .describe("The complete question to ask the user."),
        header: z
          .string()
          .max(12)
          .describe(
            "Very short label (<=12 chars) displayed as a category chip.",
          )
          .optional(),
        options: z
          .array(
            z.object({
              label: z
                .string()
                .describe("The display text for this option."),
              description: z
                .string()
                .describe("Explanation of what this option means."),
            }),
          )
          .min(2)
          .max(4)
          .describe("The available choices for this question (2-4)."),
        multiSelect: z
          .boolean()
          .describe(
            "If true, allow multiple options. v1 of the Feishu card UI " +
              "treats this as single-select.",
          ),
      }),
    )
    .min(1)
    .max(4)
    .describe("1..4 questions to ask the user."),
};

export interface CreateAskUserMcpServerOptions {
  broker: QuestionBroker;
  /** Feishu chat id of the current turn. */
  chatId: string;
  /** Open id of the user who sent the triggering message. */
  ownerOpenId: string;
  /** Feishu `message_id` the card should reply to. */
  parentMessageId: string;
  logger: Logger;
}

/**
 * Build a per-turn in-process MCP server exposing a single tool,
 * `mcp__feishu__ask_user`, which forwards AskUserQuestion-style
 * calls through a `QuestionBroker` backed by Feishu cards.
 *
 * Built per turn because the tool handler needs the current
 * senderOpenId / parentMessageId — rebuilding the server is cheap
 * (it's just an in-memory instance), and per-turn scoping means we
 * never mix up context across chats.
 */
export function createAskUserMcpServer(
  opts: CreateAskUserMcpServerOptions,
): McpSdkServerConfigWithInstance {
  const askUserTool = tool(
    "ask_user",
    // Description deliberately nudges Claude toward this tool over
    // any built-in alternative. The built-in `AskUserQuestion` tool
    // is also `disallowedTools`'d at the session layer, so this is
    // the only path available here.
    "Ask the user a multiple-choice question in this Feishu-channel " +
      "environment. Supports 1-4 questions per call, 2-4 options per " +
      "question, single-select. Use this instead of the built-in " +
      "AskUserQuestion tool.",
    askUserInputSchema,
    async (args) => {
      opts.logger.info(
        {
          component: "ask-user-mcp",
          question_count: args.questions.length,
          chat_id: opts.chatId,
        },
        "ask_user handler invoked",
      );
      const questions: AskUserQuestionSpec[] = args.questions.map((q) => {
        if (q.multiSelect) {
          opts.logger.warn(
            { header: q.header },
            "ask_user: multiSelect=true treated as single-select in v1",
          );
        }
        const spec: AskUserQuestionSpec = {
          question: q.question,
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
          })),
          multiSelect: q.multiSelect,
          ...(q.header !== undefined ? { header: q.header } : {}),
        };
        return spec;
      });

      const response = await opts.broker.request({
        questions,
        chatId: opts.chatId,
        ownerOpenId: opts.ownerOpenId,
        parentMessageId: opts.parentMessageId,
      });

      return toCallToolResult(questions, response);
    },
  );

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "1.0.0",
    tools: [askUserTool],
  });
}

/** Translate a broker response into the MCP tool's CallToolResult. */
function toCallToolResult(
  questions: ReadonlyArray<AskUserQuestionSpec>,
  response: QuestionResponse,
) {
  if (response.kind === "answered") {
    // Mirror `AskUserQuestionOutput`: {questions, answers, annotations}.
    const payload = {
      questions: questions.map((q) => ({
        question: q.question,
        header: q.header,
        options: q.options.map((o) => ({
          label: o.label,
          description: o.description,
        })),
        multiSelect: q.multiSelect,
      })),
      answers: response.answers,
      annotations: {},
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload),
        },
      ],
    };
  }
  if (response.kind === "cancelled") {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `ask_user cancelled: ${response.reason}`,
        },
      ],
    };
  }
  // timed_out
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "ask_user timed out after 5 minutes with no response.",
      },
    ],
  };
}

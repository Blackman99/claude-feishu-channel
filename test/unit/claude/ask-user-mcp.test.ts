import { describe, it, expect } from "vitest";
import { createAskUserMcpServer } from "../../../src/claude/ask-user-mcp.js";
import { FakeQuestionBroker } from "./fakes/fake-question-broker.js";
import { createLogger } from "../../../src/util/logger.js";

const SILENT = createLogger({ level: "error", pretty: false });

/**
 * Poke the in-memory MCP server to run its single tool handler.
 * `createSdkMcpServer` returns a config object with `.instance` (the
 * underlying `McpServer`). The Claude Agent SDK invokes tools via
 * that instance's registered handlers — we can reach the same code
 * by calling the internal tool registration's handler directly.
 * Simpler: build the tool-definition list ourselves through a
 * re-export, but `createSdkMcpServer` doesn't expose the tools on
 * the returned object, so we use the server's `_registeredTools`
 * map which `tool()` populates via `server.tool(name, schema, handler)`.
 */
function getToolHandler(
  server: ReturnType<typeof createAskUserMcpServer>,
  toolName: string,
): (args: unknown) => Promise<unknown> {
  const inst = server.instance as unknown as {
    _registeredTools: Record<
      string,
      { handler: (args: unknown, extra: unknown) => Promise<unknown> }
    >;
  };
  const reg = inst._registeredTools[toolName];
  if (!reg) {
    throw new Error(
      `Tool ${toolName} not registered on MCP server. Known: ${Object.keys(
        inst._registeredTools ?? {},
      ).join(", ")}`,
    );
  }
  return (args) => reg.handler(args, {});
}

describe("createAskUserMcpServer", () => {
  it("returns a server config with a single registered tool named ask_user", () => {
    const broker = new FakeQuestionBroker();
    const server = createAskUserMcpServer({
      broker,
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_parent",
      locale: "zh",
      logger: SILENT,
    });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("feishu");
    const inst = server.instance as unknown as {
      _registeredTools: Record<string, unknown>;
    };
    expect(Object.keys(inst._registeredTools)).toContain("ask_user");
  });

  it("handler forwards questions to the broker with chat context", async () => {
    const broker = new FakeQuestionBroker();
    const server = createAskUserMcpServer({
      broker,
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_parent",
      locale: "zh",
      logger: SILENT,
    });
    const handler = getToolHandler(server, "ask_user");

    // Fire the handler but resolve the broker before awaiting.
    const pending = handler({
      questions: [
        {
          question: "Pick one",
          options: [
            { label: "A", description: "the first" },
            { label: "B", description: "the second" },
          ],
          multiSelect: false,
        },
      ],
    });
    // Give the handler a microtask to forward into the broker.
    await Promise.resolve();
    expect(broker.requests).toHaveLength(1);
    const req = broker.requests[0]!;
    expect(req.chatId).toBe("oc_1");
    expect(req.ownerOpenId).toBe("ou_owner");
    expect(req.parentMessageId).toBe("om_parent");
    expect(req.questions[0]!.question).toBe("Pick one");
    expect(req.questions[0]!.options).toHaveLength(2);

    broker.fakeResolve({
      kind: "answered",
      answers: { "Pick one": "A" },
    });
    const result = (await pending) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.type).toBe("text");
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.answers).toEqual({ "Pick one": "A" });
    expect(payload.questions).toHaveLength(1);
    expect(payload.annotations).toEqual({});
  });

  it("cancelled response maps to isError + reason", async () => {
    const broker = new FakeQuestionBroker();
    const server = createAskUserMcpServer({
      broker,
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_parent",
      locale: "zh",
      logger: SILENT,
    });
    const handler = getToolHandler(server, "ask_user");

    const pending = handler({
      questions: [
        {
          question: "Q?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
          multiSelect: false,
        },
      ],
    });
    await Promise.resolve();
    broker.fakeResolve({ kind: "cancelled", reason: "User issued /stop" });
    const result = (await pending) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("User issued /stop");
  });

  it("timed_out response maps to isError + timeout text", async () => {
    const broker = new FakeQuestionBroker();
    const server = createAskUserMcpServer({
      broker,
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_parent",
      locale: "zh",
      logger: SILENT,
    });
    const handler = getToolHandler(server, "ask_user");

    const pending = handler({
      questions: [
        {
          question: "Q?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
          multiSelect: false,
        },
      ],
    });
    await Promise.resolve();
    broker.fakeResolve({ kind: "timed_out" });
    const result = (await pending) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/timed out/i);
  });

  it("warns when multiSelect=true is passed, but still processes the question", async () => {
    const broker = new FakeQuestionBroker();
    // Capture warn calls via a logger-like shim.
    const warnCalls: unknown[] = [];
    const fakeLogger = {
      warn: (...args: unknown[]) => warnCalls.push(args),
      child: () => fakeLogger,
      error: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as unknown as Parameters<typeof createAskUserMcpServer>[0]["logger"];
    const server = createAskUserMcpServer({
      broker,
      chatId: "oc_1",
      ownerOpenId: "ou_owner",
      parentMessageId: "om_parent",
      locale: "zh",
      logger: fakeLogger,
    });
    const handler = getToolHandler(server, "ask_user");
    const pending = handler({
      questions: [
        {
          question: "Multi?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
          multiSelect: true,
        },
      ],
    });
    await Promise.resolve();
    expect(warnCalls.length).toBeGreaterThan(0);
    broker.fakeResolve({
      kind: "answered",
      answers: { "Multi?": "A" },
    });
    await pending;
  });
});

import { describe, expect, it } from "vitest";
import { ClaudeSession, type ClaudeSessionOptions } from "../../../src/claude/session.js";
import type { RenderEvent } from "../../../src/claude/render-event.js";
import { FakeClock } from "../../../src/util/clock.js";
import { createLogger } from "../../../src/util/logger.js";
import { FakePermissionBroker } from "./fakes/fake-permission-broker.js";
import { FakeQuestionBroker } from "./fakes/fake-question-broker.js";
import { FakeQueryHandle } from "./fakes/fake-query-handle.js";
import type { QueryFn } from "../../../src/claude/query-handle.js";

const SILENT_LOGGER = createLogger({ level: "error", pretty: false });

const BASE_CLAUDE_CONFIG = {
  defaultCwd: "/tmp/cfc-test",
  defaultPermissionMode: "default" as const,
  defaultModel: "claude-opus-4-6",
  cliPath: "claude",
  permissionTimeoutMs: 300_000,
  permissionWarnBeforeMs: 60_000,
};

/**
 * Harness for exercising ClaudeSession.buildPrompt indirectly via submit().
 * Mirrors the pattern used in context-mitigation.test.ts — the session's
 * queryFn captures the prompt produced by buildPrompt so tests can iterate
 * the AsyncIterable<SDKUserMessage> and inspect its content blocks.
 */
function createHarness(): {
  session: ClaudeSession;
  events: RenderEvent[];
  queryCalls: Array<{
    prompt: Parameters<QueryFn>[0]["prompt"];
    options: Parameters<QueryFn>[0]["options"];
  }>;
  fakes: FakeQueryHandle[];
  emit: (event: RenderEvent) => Promise<void>;
} {
  const events: RenderEvent[] = [];
  const queryCalls: Array<{
    prompt: Parameters<QueryFn>[0]["prompt"];
    options: Parameters<QueryFn>[0]["options"];
  }> = [];
  const fakes: FakeQueryHandle[] = [];
  const emit = async (event: RenderEvent): Promise<void> => {
    events.push(event);
  };
  const queryFn: QueryFn = (params) => {
    queryCalls.push({ prompt: params.prompt, options: params.options });
    const fake = new FakeQueryHandle();
    fake.canUseTool = params.canUseTool;
    fake.options = params.options;
    fakes.push(fake);
    return fake;
  };
  const opts: ClaudeSessionOptions = {
    chatId: "oc_x",
    config: BASE_CLAUDE_CONFIG,
    queryFn,
    clock: new FakeClock(),
    permissionBroker: new FakePermissionBroker(),
    questionBroker: new FakeQuestionBroker(),
    logger: SILENT_LOGGER,
  };
  const session = new ClaudeSession(opts);
  return { session, events, queryCalls, fakes, emit };
}

function runInput(text: string) {
  return {
    kind: "run" as const,
    text,
    senderOpenId: "ou_test",
    parentMessageId: "om_test",
    locale: "en" as const,
  };
}

function runImageInput(text: string, imageDataUris: readonly string[]) {
  return {
    ...runInput(text),
    imageDataUris,
  };
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

type UserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

async function collectUserContent(
  prompt: string | AsyncIterable<unknown>,
): Promise<UserContentBlock[]> {
  expect(typeof prompt).not.toBe("string");
  const messages: unknown[] = [];
  for await (const msg of prompt as AsyncIterable<unknown>) {
    messages.push(msg);
  }
  expect(messages).toHaveLength(1);
  const content = (
    messages[0] as { message: { content: UserContentBlock[] } }
  ).message.content;
  return content;
}

// Realistic 1x1 PNG / JPEG base64 prefixes — abbreviated, just enough to
// exercise the data-URI regex in buildPrompt.
const PNG_URI = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=`;
const JPEG_URI = `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFREREhlj`;

describe("ClaudeSession.buildPrompt", () => {
  it("emits [image, image, text] in order for 2 images with user text", async () => {
    const h = createHarness();

    const outcome = await h.session.submit(
      runImageInput("compare these", [PNG_URI, JPEG_URI]),
      h.emit,
    );
    if (outcome.kind === "rejected") throw new Error(outcome.reason);
    await flushMicrotasks();

    const content = await collectUserContent(h.queryCalls[0]!.prompt);
    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
    expect(content[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg" },
    });
    expect(content[2]).toEqual({ type: "text", text: "compare these" });

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("falls back to 'What is in these images?' when text is empty and 2 images are attached", async () => {
    const h = createHarness();

    const outcome = await h.session.submit(
      runImageInput("", [PNG_URI, JPEG_URI]),
      h.emit,
    );
    if (outcome.kind === "rejected") throw new Error(outcome.reason);
    await flushMicrotasks();

    const content = await collectUserContent(h.queryCalls[0]!.prompt);
    expect(content).toHaveLength(3);
    expect(content[2]).toEqual({
      type: "text",
      text: "What is in these images?",
    });

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("falls back to 'What is in this image?' (singular) when text is empty and 1 image is attached", async () => {
    const h = createHarness();

    const outcome = await h.session.submit(
      runImageInput("", [PNG_URI]),
      h.emit,
    );
    if (outcome.kind === "rejected") throw new Error(outcome.reason);
    await flushMicrotasks();

    const content = await collectUserContent(h.queryCalls[0]!.prompt);
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({
      type: "text",
      text: "What is in this image?",
    });

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });

  it("falls back to jpeg media_type and forwards the raw URI as data when the data URI is malformed", async () => {
    const h = createHarness();

    const outcome = await h.session.submit(
      runImageInput("describe", ["not-a-data-uri"]),
      h.emit,
    );
    if (outcome.kind === "rejected") throw new Error(outcome.reason);
    await flushMicrotasks();

    const content = await collectUserContent(h.queryCalls[0]!.prompt);
    expect(content[0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: "not-a-data-uri",
      },
    });

    h.fakes[0]!.finishWithSuccess({
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await outcome.done;
  });
});

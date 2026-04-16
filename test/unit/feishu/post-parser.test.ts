import { describe, it, expect } from "vitest";
import { parsePost } from "../../../src/feishu/post-parser.js";

function encode(post: unknown): string {
  return JSON.stringify(post);
}

describe("parsePost", () => {
  it("flattens a single-paragraph text-only post", () => {
    const raw = encode({
      content: [[{ tag: "text", text: "hello world" }]],
    });
    expect(parsePost(raw)).toEqual({ text: "hello world", imageKeys: [] });
  });

  it("renders an `a` tag as `text (href)`", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "see " },
        { tag: "a", text: "this link", href: "https://example.com" },
      ]],
    });
    expect(parsePost(raw).text).toBe("see this link (https://example.com)");
  });

  it("renders an `at` tag as `@user_name` (fallback to user_id)", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "hi " },
        { tag: "at", user_id: "ou_1", user_name: "Alice" },
        { tag: "text", text: " and " },
        { tag: "at", user_id: "ou_2" },
      ]],
    });
    expect(parsePost(raw).text).toBe("hi @Alice and @ou_2");
  });

  it("renders an `emotion` tag as `:EMOJI_TYPE:`", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "ok " },
        { tag: "emotion", emoji_type: "SMILE" },
      ]],
    });
    expect(parsePost(raw).text).toBe("ok :SMILE:");
  });

  it("collects `img` tags in document order and omits image text", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "before " },
        { tag: "img", image_key: "img_1" },
        { tag: "text", text: " middle " },
        { tag: "img", image_key: "img_2" },
        { tag: "text", text: " after" },
      ]],
    });
    expect(parsePost(raw)).toEqual({
      text: "before  middle  after",
      imageKeys: ["img_1", "img_2"],
    });
  });

  it("treats `media` tags the same as `img` tags", () => {
    const raw = encode({
      content: [[{ tag: "media", image_key: "img_m" }]],
    });
    expect(parsePost(raw)).toEqual({ text: "", imageKeys: ["img_m"] });
  });

  it("joins multiple paragraphs with a blank line", () => {
    const raw = encode({
      content: [
        [{ tag: "text", text: "line one" }],
        [{ tag: "text", text: "line two" }],
      ],
    });
    expect(parsePost(raw).text).toBe("line one\n\nline two");
  });

  it("drops empty paragraphs so image-only paragraphs do not create blank lines", () => {
    const raw = encode({
      content: [
        [{ tag: "text", text: "look" }],
        [{ tag: "img", image_key: "img_1" }],
        [{ tag: "text", text: "what do you think?" }],
      ],
    });
    expect(parsePost(raw)).toEqual({
      text: "look\n\nwhat do you think?",
      imageKeys: ["img_1"],
    });
  });

  it("prepends a non-empty title as the first paragraph", () => {
    const raw = encode({
      title: "Meeting notes",
      content: [[{ tag: "text", text: "body" }]],
    });
    expect(parsePost(raw).text).toBe("Meeting notes\n\nbody");
  });

  it("omits an empty or whitespace-only title", () => {
    const raw = encode({
      title: "   ",
      content: [[{ tag: "text", text: "body" }]],
    });
    expect(parsePost(raw).text).toBe("body");
  });

  it("decodes common HTML entities when un_escape is true", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "&lt;tag&gt; &amp; &quot;x&quot; &#39;y&#39;", un_escape: true },
      ]],
    });
    expect(parsePost(raw).text).toBe(`<tag> & "x" 'y'`);
  });

  it("leaves entities alone when un_escape is absent or false", () => {
    const raw = encode({
      content: [[{ tag: "text", text: "&lt;keep&gt;" }]],
    });
    expect(parsePost(raw).text).toBe("&lt;keep&gt;");
  });

  it("skips unknown inline tags without throwing", () => {
    const raw = encode({
      content: [[
        { tag: "text", text: "x" },
        { tag: "widget_frobnicator", foo: 1 },
        { tag: "text", text: "y" },
      ]],
    });
    expect(parsePost(raw).text).toBe("xy");
  });

  it("returns empty text for an image-only post", () => {
    const raw = encode({
      content: [[{ tag: "img", image_key: "img_1" }]],
    });
    expect(parsePost(raw)).toEqual({ text: "", imageKeys: ["img_1"] });
  });

  it("trims leading and trailing whitespace from the flattened text", () => {
    const raw = encode({
      content: [[{ tag: "text", text: "  hello  " }]],
    });
    expect(parsePost(raw).text).toBe("hello");
  });

  it("throws when the content is not valid JSON", () => {
    expect(() => parsePost("{not json")).toThrow();
  });

  it("throws when the root `content` is not an array", () => {
    expect(() => parsePost(encode({ content: "nope" }))).toThrow();
  });

  it("throws when a paragraph is not an array", () => {
    expect(() => parsePost(encode({ content: ["nope"] }))).toThrow();
  });
});

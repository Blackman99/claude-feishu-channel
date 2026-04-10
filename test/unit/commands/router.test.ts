import { describe, it, expect } from "vitest";
import { parseInput } from "../../../src/commands/router.js";

describe("parseInput", () => {
  it("plain text → run", () => {
    expect(parseInput("hello world")).toEqual({
      kind: "run",
      text: "hello world",
    });
  });

  it("preserves leading/trailing whitespace inside a run", () => {
    // Trimming is the session's concern, not the parser's.
    expect(parseInput("  hi  ")).toEqual({ kind: "run", text: "  hi  " });
  });

  it("'/stop' → stop", () => {
    expect(parseInput("/stop")).toEqual({ kind: "stop" });
  });

  it("'/stop' followed by whitespace is still stop", () => {
    expect(parseInput("/stop  ")).toEqual({ kind: "stop" });
    expect(parseInput("/stop\n")).toEqual({ kind: "stop" });
  });

  it("'/stop' with trailing text is NOT stop — it's a run", () => {
    // Phase 6 may reserve `/stop <reason>`, but Phase 4 only accepts
    // bare `/stop`. Anything else falls through to `run` so the user
    // isn't surprised by a silent stop when they mistype.
    expect(parseInput("/stop now")).toEqual({
      kind: "run",
      text: "/stop now",
    });
  });

  it("'/STOP' uppercase → stop (case-insensitive)", () => {
    expect(parseInput("/STOP")).toEqual({ kind: "stop" });
    expect(parseInput("/Stop")).toEqual({ kind: "stop" });
  });

  it("'!foo' → interrupt_and_run with text='foo'", () => {
    expect(parseInput("!foo")).toEqual({
      kind: "interrupt_and_run",
      text: "foo",
    });
  });

  it("'! foo' (with space after !) → interrupt_and_run with text='foo'", () => {
    // Leading whitespace after `!` is consumed so the rewritten
    // input doesn't carry the separator the user used to delimit.
    expect(parseInput("! foo")).toEqual({
      kind: "interrupt_and_run",
      text: "foo",
    });
  });

  it("'!' on its own (no payload) is NOT interrupt_and_run — it's a plain run", () => {
    // Interrupt semantics without a replacement message is ambiguous:
    // does the user mean "stop" or "run nothing"? We pick the
    // least-surprising interpretation and treat it as literal text,
    // letting the session reject empty input if it wants.
    expect(parseInput("!")).toEqual({ kind: "run", text: "!" });
    expect(parseInput("!   ")).toEqual({ kind: "run", text: "!   " });
  });

  it("'!!foo' → interrupt_and_run with text='!foo' (only the FIRST ! is consumed)", () => {
    // Double-bang would be a Phase 6 feature ("interrupt without
    // dropping queue"); for now we just take the first ! and let the
    // rest of the string through.
    expect(parseInput("!!foo")).toEqual({
      kind: "interrupt_and_run",
      text: "!foo",
    });
  });

  it("empty string → run with empty text", () => {
    expect(parseInput("")).toEqual({ kind: "run", text: "" });
  });

  it("whitespace only → run with whitespace text", () => {
    expect(parseInput("   ")).toEqual({ kind: "run", text: "   " });
    expect(parseInput("\n\t")).toEqual({ kind: "run", text: "\n\t" });
  });
});

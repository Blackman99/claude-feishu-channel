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

describe("parseInput — Phase 6 commands", () => {
  it("/new → command new", () => {
    expect(parseInput("/new")).toEqual({
      kind: "command",
      cmd: { name: "new" },
    });
  });

  it("/NEW → command new (case-insensitive)", () => {
    expect(parseInput("/NEW")).toEqual({
      kind: "command",
      cmd: { name: "new" },
    });
  });

  it("/new with trailing whitespace → command new", () => {
    expect(parseInput("/new  ")).toEqual({
      kind: "command",
      cmd: { name: "new" },
    });
  });

  it("/cd /path/to/dir → command cd with path", () => {
    expect(parseInput("/cd /Users/me/projects")).toEqual({
      kind: "command",
      cmd: { name: "cd", path: "/Users/me/projects" },
    });
  });

  it("/cd ~/projects → command cd preserves tilde", () => {
    expect(parseInput("/cd ~/projects")).toEqual({
      kind: "command",
      cmd: { name: "cd", path: "~/projects" },
    });
  });

  it("/cd without argument → unknown_command", () => {
    expect(parseInput("/cd")).toEqual({
      kind: "unknown_command",
      raw: "/cd",
    });
    expect(parseInput("/cd   ")).toEqual({
      kind: "unknown_command",
      raw: "/cd   ",
    });
  });

  it("/project my-app → command project", () => {
    expect(parseInput("/project my-app")).toEqual({
      kind: "command",
      cmd: { name: "project", alias: "my-app" },
    });
  });

  it("/project without argument → unknown_command", () => {
    expect(parseInput("/project")).toEqual({
      kind: "unknown_command",
      raw: "/project",
    });
  });

  it("/mode default → command mode", () => {
    expect(parseInput("/mode default")).toEqual({
      kind: "command",
      cmd: { name: "mode", mode: "default" },
    });
  });

  it("/mode acceptEdits → command mode", () => {
    expect(parseInput("/mode acceptEdits")).toEqual({
      kind: "command",
      cmd: { name: "mode", mode: "acceptEdits" },
    });
  });

  it("/mode plan → command mode", () => {
    expect(parseInput("/mode plan")).toEqual({
      kind: "command",
      cmd: { name: "mode", mode: "plan" },
    });
  });

  it("/mode bypassPermissions → command mode", () => {
    expect(parseInput("/mode bypassPermissions")).toEqual({
      kind: "command",
      cmd: { name: "mode", mode: "bypassPermissions" },
    });
  });

  it("/mode badvalue → unknown_command", () => {
    expect(parseInput("/mode badvalue")).toEqual({
      kind: "unknown_command",
      raw: "/mode badvalue",
    });
  });

  it("/mode without argument → unknown_command", () => {
    expect(parseInput("/mode")).toEqual({
      kind: "unknown_command",
      raw: "/mode",
    });
  });

  it("/model sonnet → command model", () => {
    expect(parseInput("/model sonnet")).toEqual({
      kind: "command",
      cmd: { name: "model", model: "sonnet" },
    });
  });

  it("/model claude-opus-4-6 → command model", () => {
    expect(parseInput("/model claude-opus-4-6")).toEqual({
      kind: "command",
      cmd: { name: "model", model: "claude-opus-4-6" },
    });
  });

  it("/model without argument → unknown_command", () => {
    expect(parseInput("/model")).toEqual({
      kind: "unknown_command",
      raw: "/model",
    });
  });

  it("/status → command status", () => {
    expect(parseInput("/status")).toEqual({
      kind: "command",
      cmd: { name: "status" },
    });
  });

  it("/help → command help", () => {
    expect(parseInput("/help")).toEqual({
      kind: "command",
      cmd: { name: "help" },
    });
  });

  it("/config show → command config_show", () => {
    expect(parseInput("/config show")).toEqual({
      kind: "command",
      cmd: { name: "config_show" },
    });
  });

  it("/config without show → unknown_command", () => {
    expect(parseInput("/config")).toEqual({
      kind: "unknown_command",
      raw: "/config",
    });
    expect(parseInput("/config set foo bar")).toEqual({
      kind: "unknown_command",
      raw: "/config set foo bar",
    });
  });

  it("unknown /foo → unknown_command", () => {
    expect(parseInput("/foo")).toEqual({
      kind: "unknown_command",
      raw: "/foo",
    });
  });

  it("/etc/hosts → run (not a known command word)", () => {
    // Slash followed by a non-command word falls through to run
    expect(parseInput("/etc/hosts")).toEqual({
      kind: "run",
      text: "/etc/hosts",
    });
  });

  it("'/stop now' still falls through to run (existing behavior)", () => {
    expect(parseInput("/stop now")).toEqual({
      kind: "run",
      text: "/stop now",
    });
  });
});

describe("/sessions", () => {
  it("parses /sessions as a command", () => {
    expect(parseInput("/sessions")).toEqual({ kind: "command", cmd: { name: "sessions" } });
  });

  it("parses /sessions with trailing whitespace", () => {
    expect(parseInput("/sessions  ")).toEqual({ kind: "command", cmd: { name: "sessions" } });
  });
});

describe("/resume", () => {
  it("parses /resume <id> as a command with target", () => {
    expect(parseInput("/resume ses_abc123")).toEqual({
      kind: "command",
      cmd: { name: "resume", target: "ses_abc123" },
    });
  });

  it("trims target whitespace", () => {
    expect(parseInput("/resume  ses_abc123  ")).toEqual({
      kind: "command",
      cmd: { name: "resume", target: "ses_abc123" },
    });
  });

  it("/resume without argument is unknown_command", () => {
    expect(parseInput("/resume")).toEqual({ kind: "unknown_command", raw: "/resume" });
  });

  it("/resume with empty arg is unknown_command", () => {
    expect(parseInput("/resume   ")).toEqual({ kind: "unknown_command", raw: "/resume   " });
  });
});

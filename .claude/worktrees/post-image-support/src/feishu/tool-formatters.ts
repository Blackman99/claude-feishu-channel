/**
 * Format a Claude tool's `input` object into a short human summary
 * per spec §7.3. Tool `input` is typed `unknown` by the SDK because it
 * is schema-driven — every case below validates fields defensively.
 */
export function formatToolParams(name: string, input: unknown): string {
  const obj = isRecord(input) ? input : null;

  switch (name) {
    case "Read":
      return formatRead(obj);
    case "Edit":
      return formatEdit(obj);
    case "Write":
      return formatWrite(obj);
    case "Bash":
      return formatBash(obj);
    case "Grep":
      return formatGrep(obj);
    default:
      return formatDefault(input);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatRead(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  const file = typeof obj["file_path"] === "string" ? obj["file_path"] : "?";
  const offset = typeof obj["offset"] === "number" ? obj["offset"] : undefined;
  const limit = typeof obj["limit"] === "number" ? obj["limit"] : undefined;
  if (offset === undefined && limit === undefined) return file;
  if (offset !== undefined && limit !== undefined) {
    return `${file}:${offset}-${offset + limit - 1}`;
  }
  if (offset !== undefined) return `${file}:${offset}-`;
  return `${file}:-${limit}`;
}

function formatEdit(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  return typeof obj["file_path"] === "string" ? obj["file_path"] : "?";
}

function formatWrite(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  const file = typeof obj["file_path"] === "string" ? obj["file_path"] : "?";
  const content = typeof obj["content"] === "string" ? obj["content"] : "";
  const bytes = new TextEncoder().encode(content).length;
  return `${file} (${bytes} bytes)`;
}

const BASH_MAX = 80;

function formatBash(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  const cmd = typeof obj["command"] === "string" ? obj["command"] : "?";
  if (cmd.length <= BASH_MAX) return `$ ${cmd}`;
  return `$ ${cmd.slice(0, BASH_MAX)}…`;
}

function formatGrep(obj: Record<string, unknown> | null): string {
  if (!obj) return formatDefault(obj);
  const pattern = typeof obj["pattern"] === "string" ? obj["pattern"] : "?";
  const glob = typeof obj["glob"] === "string" ? obj["glob"] : undefined;
  return glob ? `"${pattern}" in ${glob}` : `"${pattern}"`;
}

const DEFAULT_MAX = 200;

function formatDefault(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (s.length > DEFAULT_MAX) return s.slice(0, DEFAULT_MAX - 1) + "…";
  return s;
}

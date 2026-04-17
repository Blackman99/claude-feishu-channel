import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionRecord {
  provider: "claude" | "codex";
  providerSessionId?: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode?: string;
  model?: string;
}

type LegacySessionRecordInput = {
  claudeSessionId: string;
  provider?: "claude" | "codex";
  providerSessionId?: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode?: string;
  model?: string;
};

export interface State {
  version: 3;
  lastCleanShutdown: boolean;
  /**
   * Sessions keyed by `chatId\t\tprovider` (default project) or
   * `chatId\tprojectAlias\tprovider` (named project). Older state files may
   * still contain legacy keys without a provider suffix and are normalized by
   * the session manager at runtime.
   */
  sessions: Record<string, SessionRecord>;
  /** Tracks the currently active project alias per chatId. */
  activeProjects: Record<string, string>;
  /** Tracks the currently selected provider per chatId or `chatId\tprojectAlias`. */
  activeProviders: Record<string, "claude" | "codex">;
}

const INITIAL_STATE: State = {
  version: 3,
  lastCleanShutdown: true,
  sessions: {},
  activeProjects: {},
  activeProviders: {},
};

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeSessionRecord(record: unknown): SessionRecord {
  if (!record || typeof record !== "object") {
    throw new Error("Invalid session record in state file");
  }

  const session = record as LegacySessionRecordInput;

  const provider =
    session.provider === "claude" || session.provider === "codex"
      ? session.provider
      : isString(session.claudeSessionId)
        ? "claude"
      : undefined;
  const providerSessionId = isString(session.providerSessionId)
    ? session.providerSessionId
    : isString(session.claudeSessionId)
      ? session.claudeSessionId
      : undefined;

  if (!provider || !isString(session.cwd) || !isString(session.createdAt) || !isString(session.lastActiveAt)) {
    throw new Error("Unsupported session record shape in state file");
  }

  return {
    provider,
    cwd: session.cwd,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(isString(session.permissionMode)
      ? { permissionMode: session.permissionMode }
      : {}),
    ...(isString(session.model) ? { model: session.model } : {}),
  };
}

function normalizeState(parsed: {
  lastCleanShutdown?: unknown;
  sessions?: Record<string, unknown>;
  activeProjects?: Record<string, string>;
  activeProviders?: Record<string, unknown>;
}): State {
  const sessions: Record<string, SessionRecord> = {};
  for (const [key, value] of Object.entries(parsed.sessions ?? {})) {
    try {
      sessions[key] = normalizeSessionRecord(value);
    } catch (err) {
      // Older builds could persist placeholder records before a real
      // session ID was captured. Skip those malformed records on load
      // instead of failing startup for the entire bot.
      if (
        err instanceof Error &&
        /Unsupported session record shape/.test(err.message)
      ) {
        continue;
      }
      throw err;
    }
  }

  const activeProviders: Record<string, "claude" | "codex"> = {};
  for (const [key, value] of Object.entries(parsed.activeProviders ?? {})) {
    if (value === "claude" || value === "codex") {
      activeProviders[key] = value;
    }
  }

  return {
    version: 3,
    lastCleanShutdown: Boolean(parsed.lastCleanShutdown),
    sessions,
    activeProjects: parsed.activeProjects ?? {},
    activeProviders,
  };
}

export class StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<State> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(INITIAL_STATE);
      }
      throw new Error(
        `Failed to read state file ${this.path}: ${(err as Error).message}`,
      );
    }

    let parsed: State;
    try {
      parsed = JSON.parse(raw) as State;
    } catch (err) {
      throw new Error(
        `Malformed JSON in state file ${this.path}: ${(err as Error).message}`,
      );
    }
    // Migrate v1/v2 → v3: add activeProjects/activeProviders fields.
    if ((parsed as { version: number }).version === 1) {
      return normalizeState({
        lastCleanShutdown: (parsed as unknown as { lastCleanShutdown: boolean }).lastCleanShutdown,
        sessions: (parsed as unknown as { sessions: Record<string, unknown> }).sessions,
        activeProjects: {},
        activeProviders: {},
      });
    }
    if ((parsed as { version: number }).version === 2) {
      return normalizeState({
        lastCleanShutdown: (parsed as unknown as { lastCleanShutdown: boolean }).lastCleanShutdown,
        sessions: (parsed as unknown as { sessions: Record<string, unknown> }).sessions,
        activeProjects: (parsed as unknown as { activeProjects?: Record<string, string> }).activeProjects ?? {},
        activeProviders: {},
      });
    }
    if (parsed.version !== 3) {
      throw new Error(
        `Unsupported state file version ${(parsed as { version: number }).version} in ${this.path}`,
      );
    }
    return normalizeState(parsed);
  }

  async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.path);
  }

  async markUncleanAtStartup(state: State): Promise<void> {
    state.lastCleanShutdown = false;
    await this.save(state);
  }

  async markCleanShutdown(state: State): Promise<void> {
    state.lastCleanShutdown = true;
    await this.save(state);
  }
}

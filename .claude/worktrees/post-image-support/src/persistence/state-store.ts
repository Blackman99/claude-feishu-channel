import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionRecord {
  claudeSessionId: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  permissionMode?: string;
  model?: string;
}

export interface State {
  version: 2;
  lastCleanShutdown: boolean;
  /**
   * Sessions keyed by chatId (default project) or `chatId\tprojectAlias`
   * (named project). The tab character is used as a separator since it
   * cannot appear in Feishu chat IDs or project alias names.
   */
  sessions: Record<string, SessionRecord>;
  /** Tracks the currently active project alias per chatId. */
  activeProjects: Record<string, string>;
}

const INITIAL_STATE: State = {
  version: 2,
  lastCleanShutdown: true,
  sessions: {},
  activeProjects: {},
};

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
    // Migrate v1 → v2: add activeProjects field.
    if ((parsed as { version: number }).version === 1) {
      return {
        version: 2,
        lastCleanShutdown: (parsed as unknown as { lastCleanShutdown: boolean }).lastCleanShutdown,
        sessions: (parsed as unknown as { sessions: Record<string, SessionRecord> }).sessions,
        activeProjects: {},
      };
    }
    if (parsed.version !== 2) {
      throw new Error(
        `Unsupported state file version ${(parsed as { version: number }).version} in ${this.path}`,
      );
    }
    return parsed;
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

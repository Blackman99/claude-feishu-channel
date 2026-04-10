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
  version: 1;
  lastCleanShutdown: boolean;
  sessions: Record<string, SessionRecord>;
}

const INITIAL_STATE: State = {
  version: 1,
  lastCleanShutdown: true,
  sessions: {},
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
    if (parsed.version !== 1) {
      throw new Error(
        `Unsupported state file version ${parsed.version} in ${this.path}`,
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

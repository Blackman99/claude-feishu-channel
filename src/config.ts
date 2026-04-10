import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { AppConfig } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const FeishuSchema = z.object({
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
  encrypt_key: z.string().default(""),
  verification_token: z.string().default(""),
});

const AccessSchema = z.object({
  allowed_open_ids: z.array(z.string().min(1)).min(1),
  unauthorized_behavior: z.enum(["ignore", "reject"]).default("ignore"),
});

const ClaudeSchema = z.object({
  default_cwd: z.string().min(1),
  default_permission_mode: z
    .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
    .default("default"),
  default_model: z.string().min(1).default("claude-opus-4-6"),
});

const PersistenceSchema = z
  .object({
    state_file: z.string().default("~/.claude-feishu-channel/state.json"),
    log_dir: z.string().default("~/.claude-feishu-channel/logs"),
  })
  .default({
    state_file: "~/.claude-feishu-channel/state.json",
    log_dir: "~/.claude-feishu-channel/logs",
  });

const LoggingSchema = z
  .object({
    level: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .default("info"),
  })
  .default({ level: "info" });

const ConfigSchema = z.object({
  feishu: FeishuSchema,
  access: AccessSchema,
  claude: ClaudeSchema,
  persistence: PersistenceSchema,
  logging: LoggingSchema,
});

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`Config file not found: ${path}`);
    }
    throw new ConfigError(
      `Failed to read config at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new ConfigError(
      `Failed to parse TOML at ${path}: ${(err as Error).message}`,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config at ${path}:\n${formatZodError(result.error)}`,
    );
  }

  const data = result.data;
  return {
    feishu: {
      appId: data.feishu.app_id,
      appSecret: data.feishu.app_secret,
      encryptKey: data.feishu.encrypt_key,
      verificationToken: data.feishu.verification_token,
    },
    access: {
      allowedOpenIds: data.access.allowed_open_ids,
      unauthorizedBehavior: data.access.unauthorized_behavior,
    },
    claude: {
      defaultCwd: expandHome(data.claude.default_cwd),
      defaultPermissionMode: data.claude.default_permission_mode,
      defaultModel: data.claude.default_model,
    },
    persistence: {
      stateFile: expandHome(data.persistence.state_file),
      logDir: expandHome(data.persistence.log_dir),
    },
    logging: {
      level: data.logging.level,
    },
  };
}

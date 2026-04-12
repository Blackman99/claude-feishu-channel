import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
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
  cli_path: z.string().min(1).default("claude"),
  permission_timeout_seconds: z.number().int().positive().default(300),
  permission_warn_before_seconds: z.number().int().positive().default(60),
});

const RenderSchema = z
  .object({
    inline_max_bytes: z.number().int().positive().default(2048),
    hide_thinking: z.boolean().default(false),
    show_turn_stats: z.boolean().default(true),
  })
  .default({
    inline_max_bytes: 2048,
    hide_thinking: false,
    show_turn_stats: true,
  });

const PersistenceSchema = z
  .object({
    state_file: z.string().default("~/.claude-feishu-channel/state.json"),
    log_dir: z.string().default("~/.claude-feishu-channel/logs"),
    session_ttl_days: z.number().int().positive().default(30),
  })
  .default({
    state_file: "~/.claude-feishu-channel/state.json",
    log_dir: "~/.claude-feishu-channel/logs",
    session_ttl_days: 30,
  });

const LoggingSchema = z
  .object({
    level: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .default("info"),
  })
  .default({ level: "info" });

const ProjectsSchema = z.record(z.string(), z.string()).default({});

const ConfigSchema = z.object({
  feishu: FeishuSchema,
  access: AccessSchema,
  claude: ClaudeSchema,
  render: RenderSchema,
  persistence: PersistenceSchema,
  logging: LoggingSchema,
  projects: ProjectsSchema,
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

/**
 * Write a single key-value pair into an existing TOML config file.
 *
 * Round-trips the file through smol-toml parse/stringify so structure
 * is preserved (minus comments — smol-toml doesn't preserve those).
 * Uses atomic write (write to .tmp, then rename) to avoid corruption.
 */
export async function writeConfigKey(
  configPath: string,
  key: string,
  value: string | number | boolean,
): Promise<void> {
  const raw = await readFile(configPath, "utf8");
  const parsed = parseToml(raw) as Record<string, Record<string, unknown>>;

  const [section, field] = key.split(".");
  if (!section || !field) {
    throw new Error(`Invalid config key format: ${key}`);
  }

  if (!parsed[section]) {
    parsed[section] = {};
  }
  parsed[section]![field] = value;

  const toml = stringifyToml(parsed);
  const tmpPath = configPath + ".tmp";
  await writeFile(tmpPath, toml, "utf8");
  await rename(tmpPath, configPath);
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
      cliPath: data.claude.cli_path,
      permissionTimeoutMs: data.claude.permission_timeout_seconds * 1000,
      permissionWarnBeforeMs: data.claude.permission_warn_before_seconds * 1000,
    },
    render: {
      inlineMaxBytes: data.render.inline_max_bytes,
      hideThinking: data.render.hide_thinking,
      showTurnStats: data.render.show_turn_stats,
    },
    persistence: {
      stateFile: expandHome(data.persistence.state_file),
      logDir: expandHome(data.persistence.log_dir),
      sessionTtlDays: data.persistence.session_ttl_days,
    },
    logging: {
      level: data.logging.level,
    },
    projects: Object.fromEntries(
      Object.entries(data.projects ?? {}).map(([k, v]) => [k, expandHome(v)]),
    ),
  };
}

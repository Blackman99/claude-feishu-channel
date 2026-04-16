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

const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

const AgentSchema = z.object({
  default_provider: z.enum(["claude", "codex"]).default("claude"),
  default_cwd: z.string().min(1),
  default_permission_mode: PermissionModeSchema.default("default"),
  permission_timeout_seconds: z.number().int().positive().default(300),
  permission_warn_before_seconds: z.number().int().positive().default(60),
  auto_compact_threshold: z.number().min(0).max(1).optional(),
});

const ClaudeSchema = z.object({
  default_model: z.string().min(1).default("claude-opus-4-6"),
  cli_path: z.string().min(1).default("claude"),
  default_cwd: z.string().min(1).optional(),
  default_permission_mode: PermissionModeSchema.default("default"),
  permission_timeout_seconds: z.number().int().positive().default(300),
  permission_warn_before_seconds: z.number().int().positive().default(60),
  auto_compact_threshold: z.number().min(0).max(1).optional(),
});

const CodexSchema = z.object({
  default_model: z.string().min(1).default("gpt-5-codex"),
  cli_path: z.string().min(1).default("codex"),
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
const McpServerSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["stdio", "sse"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "stdio" && !value.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "required for stdio MCP servers",
    });
  }
  if (value.type === "sse" && !value.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "required for sse MCP servers",
    });
  }
});

const ConfigSchema = z.object({
  feishu: FeishuSchema,
  access: AccessSchema,
  agent: AgentSchema.optional(),
  claude: ClaudeSchema,
  codex: CodexSchema.default({
    default_model: "gpt-5-codex",
    cli_path: "codex",
  }),
  render: RenderSchema,
  persistence: PersistenceSchema,
  logging: LoggingSchema,
  projects: ProjectsSchema,
  mcp: z.array(McpServerSchema).default([]),
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

function hasOwnProperty(
  value: unknown,
  key: string,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function validateMixedAgentConfig(
  path: string,
  raw: unknown,
  agent: z.infer<typeof AgentSchema>,
): void {
  if (!hasOwnProperty(raw, "claude")) return;
  const claude = raw.claude;
  if (!hasOwnProperty(claude, "default_cwd") &&
      !hasOwnProperty(claude, "default_permission_mode") &&
      !hasOwnProperty(claude, "permission_timeout_seconds") &&
      !hasOwnProperty(claude, "permission_warn_before_seconds") &&
      !hasOwnProperty(claude, "auto_compact_threshold")) {
    return;
  }

  const conflicts: string[] = [];
  if (
    hasOwnProperty(claude, "default_cwd") &&
    typeof claude.default_cwd === "string" &&
    expandHome(claude.default_cwd) !== expandHome(agent.default_cwd)
  ) {
    conflicts.push("claude.default_cwd");
  }
  if (
    hasOwnProperty(claude, "default_permission_mode") &&
    claude.default_permission_mode !== agent.default_permission_mode
  ) {
    conflicts.push("claude.default_permission_mode");
  }
  if (
    hasOwnProperty(claude, "permission_timeout_seconds") &&
    claude.permission_timeout_seconds !== agent.permission_timeout_seconds
  ) {
    conflicts.push("claude.permission_timeout_seconds");
  }
  if (
    hasOwnProperty(claude, "permission_warn_before_seconds") &&
    claude.permission_warn_before_seconds !== agent.permission_warn_before_seconds
  ) {
    conflicts.push("claude.permission_warn_before_seconds");
  }
  if (
    hasOwnProperty(claude, "auto_compact_threshold") &&
    claude.auto_compact_threshold !== agent.auto_compact_threshold
  ) {
    conflicts.push("claude.auto_compact_threshold");
  }

  if (conflicts.length > 0) {
    throw new ConfigError(
      `Invalid config at ${path}:\n${conflicts
        .map((field) => `  - ${field}: conflicts with [agent] when both sections are present`)
        .join("\n")}`,
    );
  }
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
  if (data.agent) {
    validateMixedAgentConfig(path, parsed, data.agent);
  }
  const agent = data.agent ?? {
    default_provider: "claude" as const,
    default_cwd: data.claude.default_cwd,
    default_permission_mode: data.claude.default_permission_mode,
    permission_timeout_seconds: data.claude.permission_timeout_seconds,
    permission_warn_before_seconds: data.claude.permission_warn_before_seconds,
    ...(data.claude.auto_compact_threshold !== undefined
      ? { auto_compact_threshold: data.claude.auto_compact_threshold }
      : {}),
  };
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
    agent: {
      defaultProvider: agent.default_provider,
      defaultCwd: (() => {
        if (!agent.default_cwd) {
          throw new ConfigError(
            `Invalid config at ${path}:\n  - claude.default_cwd: required when [agent] is omitted`,
          );
        }
        return expandHome(agent.default_cwd);
      })(),
      defaultPermissionMode: agent.default_permission_mode,
      permissionTimeoutMs: agent.permission_timeout_seconds * 1000,
      permissionWarnBeforeMs: agent.permission_warn_before_seconds * 1000,
      ...(agent.auto_compact_threshold !== undefined
        ? { autoCompactThreshold: agent.auto_compact_threshold }
        : {}),
    },
    claude: {
      defaultCwd: (() => {
        if (!agent.default_cwd) {
          throw new ConfigError(
            `Invalid config at ${path}:\n  - claude.default_cwd: required when [agent] is omitted`,
          );
        }
        return expandHome(agent.default_cwd);
      })(),
      defaultPermissionMode: agent.default_permission_mode,
      defaultModel: data.claude.default_model,
      cliPath: data.claude.cli_path,
      permissionTimeoutMs: agent.permission_timeout_seconds * 1000,
      permissionWarnBeforeMs: agent.permission_warn_before_seconds * 1000,
      ...(agent.auto_compact_threshold !== undefined
        ? { autoCompactThreshold: agent.auto_compact_threshold }
        : {}),
    },
    codex: {
      defaultModel: data.codex.default_model,
      cliPath: data.codex.cli_path,
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
    mcp: data.mcp.map((server) => ({
      name: server.name,
      type: server.type,
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
    })),
  };
}

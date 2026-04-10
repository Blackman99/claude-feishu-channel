import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfc-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const path = join(tmpDir, "config.toml");
  writeFileSync(path, content);
  return path;
}

const MINIMAL_CONFIG = `
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = ["ou_test"]
`;

describe("loadConfig", () => {
  it("loads a minimal valid config with defaults filled in", async () => {
    const path = writeConfig(MINIMAL_CONFIG);
    const cfg = await loadConfig(path);
    expect(cfg.feishu.appId).toBe("cli_test");
    expect(cfg.feishu.appSecret).toBe("secret");
    expect(cfg.feishu.encryptKey).toBe("");
    expect(cfg.feishu.verificationToken).toBe("");
    expect(cfg.access.allowedOpenIds).toEqual(["ou_test"]);
    expect(cfg.access.unauthorizedBehavior).toBe("ignore");
    expect(cfg.logging.level).toBe("info");
  });

  it("expands ~ in persistence paths", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}

[persistence]
state_file = "~/.claude-feishu-channel/state.json"
log_dir = "~/.claude-feishu-channel/logs"
`);
    const cfg = await loadConfig(path);
    expect(cfg.persistence.stateFile).toBe(
      join(homedir(), ".claude-feishu-channel/state.json"),
    );
    expect(cfg.persistence.logDir).toBe(
      join(homedir(), ".claude-feishu-channel/logs"),
    );
  });

  it("throws ConfigError on missing file", async () => {
    const path = join(tmpDir, "does-not-exist.toml");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError on malformed TOML", async () => {
    const path = writeConfig("this = is [ not valid toml");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError with field path on invalid schema", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
# missing app_secret

[access]
allowed_open_ids = ["ou_test"]
`);
    await expect(loadConfig(path)).rejects.toThrow(/feishu\.app_secret/);
  });

  it("throws ConfigError when allowed_open_ids is empty", async () => {
    const path = writeConfig(`
[feishu]
app_id = "cli_test"
app_secret = "secret"

[access]
allowed_open_ids = []
`);
    await expect(loadConfig(path)).rejects.toThrow(/allowed_open_ids/);
  });

  it("accepts unauthorized_behavior = 'reject'", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
unauthorized_behavior = "reject"
`);
    const cfg = await loadConfig(path);
    expect(cfg.access.unauthorizedBehavior).toBe("reject");
  });

  it("rejects unknown unauthorized_behavior value", async () => {
    const path = writeConfig(`
${MINIMAL_CONFIG}
unauthorized_behavior = "bogus"
`);
    await expect(loadConfig(path)).rejects.toThrow(/unauthorized_behavior/);
  });
});

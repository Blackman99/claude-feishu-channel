import pino from "pino";

type Logger = pino.Logger;

export interface LoggerOptions {
  level: "trace" | "debug" | "info" | "warn" | "error";
  pretty: boolean;
}

const REDACT_PATHS = [
  "*.app_secret",
  "*.appSecret",
  "*.encrypt_key",
  "*.encryptKey",
  "*.verification_token",
  "*.verificationToken",
  "config.feishu.appSecret",
  "config.feishu.encryptKey",
  "config.feishu.verificationToken",
];

export function createLogger(opts: LoggerOptions): Logger {
  const base: pino.LoggerOptions = {
    level: opts.level,
    redact: {
      paths: REDACT_PATHS,
      censor: "***",
    },
  };

  if (opts.pretty) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    });
  }
  return pino(base);
}

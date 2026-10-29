import "dotenv/config";

export type NodeEnvironment = "development" | "test" | "production";

export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

const MAX_SESSION_TOKEN_BYTES = 64;
const MAX_SESSION_TTL_SECONDS = 31_536_000;
const MAX_SESSION_TOKEN_LENGTH = 1024;
const MAX_SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS = 31_536_000;

const MAX_RATE_LIMIT_MAX = 100_000;
const MAX_RATE_LIMIT_TIME_WINDOW_MS = 86_400_000;

const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;
const DEFAULT_AUTH_RATE_LIMIT_TIME_WINDOW_MS = 60_000;

const VALID_LOG_LEVELS: readonly LogLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

function getEnvironment(): NodeEnvironment {
  const value = process.env.NODE_ENV?.trim() || "development";

  if (
    value !== "development" &&
    value !== "test" &&
    value !== "production"
  ) {
    throw new Error(
      `Invalid NODE_ENV: "${value}". Expected development, test, or production.`,
    );
  }

  return value;
}

function getOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function getRequiredString(name: string): string {
  const value = getOptionalString(name);

  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getPort(): number {
  const rawPort = process.env.PORT?.trim() || "3000";

  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Invalid PORT: "${rawPort}".`);
  }

  const port = Number(rawPort);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${rawPort}".`);
  }

  return port;
}

function getInteger(
  name: string,
  minimum: number,
  maximum: number,
): number {
  const rawValue = getOptionalString(name);

  if (rawValue === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(
      `Invalid ${name}. Expected an integer between ${minimum} and ${maximum}.`,
    );
  }

  const value = Number(rawValue);

  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `Invalid ${name}. Expected an integer between ${minimum} and ${maximum}.`,
    );
  }

  return value;
}

function getOptionalInteger(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (getOptionalString(name) === undefined) {
    return defaultValue;
  }

  return getInteger(name, minimum, maximum);
}

function getBoolean(name: string, defaultValue: boolean): boolean {
  const value = getOptionalString(name)?.toLowerCase();

  if (value === undefined) {
    return defaultValue;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Invalid ${name}. Expected "true" or "false".`);
}

function getLogLevel(): LogLevel {
  const value = getOptionalString("LOG_LEVEL") ?? "info";

  if (!VALID_LOG_LEVELS.includes(value as LogLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL: "${value}". Expected one of: ${VALID_LOG_LEVELS.join(", ")}.`,
    );
  }

  return value as LogLevel;
}

/**
 * Parses CORS_ORIGIN as a comma separated list and returns an array.
 * @fastify/cors treats a single string as one origin, so the list must
 * be returned as an array for multiple origins to work.
 */
function getCorsOrigin(): string[] | undefined {
  const value = getOptionalString("CORS_ORIGIN");

  if (value === undefined) {
    return undefined;
  }

  const origins = value.split(",").map((origin) => origin.trim());

  if (origins.some((origin) => origin.length === 0)) {
    throw new Error("CORS_ORIGIN contains an empty origin.");
  }

  for (const origin of origins) {
    let parsedOrigin: URL;

    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS_ORIGIN entry: "${origin}".`);
    }

    if (
      (parsedOrigin.protocol !== "http:" &&
        parsedOrigin.protocol !== "https:") ||
      parsedOrigin.origin !== origin ||
      parsedOrigin.username !== "" ||
      parsedOrigin.password !== ""
    ) {
      throw new Error(`Invalid CORS_ORIGIN entry: "${origin}".`);
    }
  }

  return origins;
}

const nodeEnv = getEnvironment();

const sessionTokenBytes = getInteger(
  "SESSION_TOKEN_BYTES",
  1,
  MAX_SESSION_TOKEN_BYTES,
);

const sessionTtlSeconds = getInteger(
  "SESSION_TTL_SECONDS",
  1,
  MAX_SESSION_TTL_SECONDS,
);

const sessionMaxTokenLength = getInteger(
  "SESSION_MAX_TOKEN_LENGTH",
  1,
  MAX_SESSION_TOKEN_LENGTH,
);

const sessionLastUsedUpdateIntervalSeconds = getInteger(
  "SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS",
  0,
  MAX_SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS,
);

const rateLimitMax = getInteger(
  "RATE_LIMIT_MAX",
  1,
  MAX_RATE_LIMIT_MAX,
);

const rateLimitTimeWindow = getInteger(
  "RATE_LIMIT_TIME_WINDOW_MS",
  1,
  MAX_RATE_LIMIT_TIME_WINDOW_MS,
);

const authRateLimitMax = getOptionalInteger(
  "AUTH_RATE_LIMIT_MAX",
  DEFAULT_AUTH_RATE_LIMIT_MAX,
  1,
  MAX_RATE_LIMIT_MAX,
);

const authRateLimitTimeWindow = getOptionalInteger(
  "AUTH_RATE_LIMIT_TIME_WINDOW_MS",
  DEFAULT_AUTH_RATE_LIMIT_TIME_WINDOW_MS,
  1,
  MAX_RATE_LIMIT_TIME_WINDOW_MS,
);

const minimumEncodedTokenLength = Math.ceil(
  (sessionTokenBytes * 8) / 6,
);

if (sessionMaxTokenLength < minimumEncodedTokenLength) {
  throw new Error(
    "SESSION_MAX_TOKEN_LENGTH is too small for SESSION_TOKEN_BYTES.",
  );
}

export const env = Object.freeze({
  nodeEnv,
  port: getPort(),
  appName: getOptionalString("APP_NAME") ?? "LUMORA Backend",
  appVersion: getOptionalString("APP_VERSION") ?? "0.1.0",
  databaseUrl: getRequiredString("DATABASE_URL"),
  corsOrigin: getCorsOrigin(),
  logLevel: getLogLevel(),
  trustProxy: getBoolean("TRUST_PROXY", false),
  sessionTokenBytes,
  sessionTtlSeconds,
  sessionMaxTokenLength,
  sessionLastUsedUpdateIntervalSeconds,
  rateLimitMax,
  rateLimitTimeWindow,
  authRateLimitMax,
  authRateLimitTimeWindow,
});

export function requireProductionSecrets(): void {
  if (env.nodeEnv !== "production") {
    return;
  }

  getRequiredString("DATABASE_URL");
}

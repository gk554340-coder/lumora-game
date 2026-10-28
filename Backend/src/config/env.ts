import "dotenv/config";

export type NodeEnvironment = "development" | "test" | "production";

const MAX_SESSION_TOKEN_BYTES = 64;
const MAX_SESSION_TTL_SECONDS = 31_536_000;
const MAX_SESSION_TOKEN_LENGTH = 1024;
const MAX_SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS = 31_536_000;

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

  if (!value) {
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

function getOptionalInteger(
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const rawValue = getOptionalString(name);

  if (rawValue === undefined) {
    return undefined;
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

const nodeEnv = getEnvironment();

const sessionTokenBytes = getOptionalInteger(
  "SESSION_TOKEN_BYTES",
  1,
  MAX_SESSION_TOKEN_BYTES,
);

const sessionTtlSeconds = getOptionalInteger(
  "SESSION_TTL_SECONDS",
  1,
  MAX_SESSION_TTL_SECONDS,
);

const sessionMaxTokenLength = getOptionalInteger(
  "SESSION_MAX_TOKEN_LENGTH",
  1,
  MAX_SESSION_TOKEN_LENGTH,
);

const sessionLastUsedUpdateIntervalSeconds = getOptionalInteger(
  "SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS",
  0,
  MAX_SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS,
);

const sessionSettings = [
  ["SESSION_TOKEN_BYTES", sessionTokenBytes],
  ["SESSION_TTL_SECONDS", sessionTtlSeconds],
  ["SESSION_MAX_TOKEN_LENGTH", sessionMaxTokenLength],
  [
    "SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS",
    sessionLastUsedUpdateIntervalSeconds,
  ],
] as const;

for (const [name, value] of sessionSettings) {
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const minimumEncodedTokenLength = Math.ceil(
  (sessionTokenBytes! * 8) / 6,
);

if (sessionMaxTokenLength! < minimumEncodedTokenLength) {
  throw new Error(
    "SESSION_MAX_TOKEN_LENGTH is too small for SESSION_TOKEN_BYTES.",
  );
}

export const env = Object.freeze({
  nodeEnv,
  port: getPort(),
  appName: getOptionalString("APP_NAME") ?? "LUMORA Backend",
  appVersion: getOptionalString("APP_VERSION") ?? "0.1.0",
  databaseUrl: getOptionalString("DATABASE_URL"),
  jwtSecret: getOptionalString("JWT_SECRET"),
  corsOrigin: getOptionalString("CORS_ORIGIN"),
  logLevel: getOptionalString("LOG_LEVEL") ?? "info",
  sessionTokenBytes: sessionTokenBytes!,
  sessionTtlSeconds: sessionTtlSeconds!,
  sessionMaxTokenLength: sessionMaxTokenLength!,
  sessionLastUsedUpdateIntervalSeconds:
    sessionLastUsedUpdateIntervalSeconds!,
});

export function requireProductionSecrets(): void {
  if (env.nodeEnv !== "production") {
    return;
  }

  getRequiredString("DATABASE_URL");
  getRequiredString("JWT_SECRET");
}


import "dotenv/config";

export type NodeEnvironment = "development" | "test" | "production";

function getEnvironment(): NodeEnvironment {
  const value = process.env.NODE_ENV?.trim() || "development";

  if (
    value !== "development" &&
    value !== "test" &&
    value !== "production"
  ) {
    throw new Error(
      `Invalid NODE_ENV: "${value}". Expected development, test, or production.`
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
  minimum: number
): number | undefined {
  const rawValue = getOptionalString(name);

  if (rawValue === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(
      `Invalid ${name}. Expected an integer >= ${minimum}.`
    );
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `Invalid ${name}. Expected an integer >= ${minimum}.`
    );
  }

  return value;
}

const nodeEnv = getEnvironment();

const sessionTokenBytes = getOptionalInteger(
  "SESSION_TOKEN_BYTES",
  1
);

const sessionTtlSeconds = getOptionalInteger(
  "SESSION_TTL_SECONDS",
  1
);

const sessionMaxTokenLength = getOptionalInteger(
  "SESSION_MAX_TOKEN_LENGTH",
  1
);

const sessionLastUsedUpdateIntervalSeconds = getOptionalInteger(
  "SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS",
  0
);

const sessionSettings = [
  ["SESSION_TOKEN_BYTES", sessionTokenBytes],
  ["SESSION_TTL_SECONDS", sessionTtlSeconds],
  ["SESSION_MAX_TOKEN_LENGTH", sessionMaxTokenLength],
  [
    "SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS",
    sessionLastUsedUpdateIntervalSeconds
  ]
] as const;

if (nodeEnv === "production") {
  for (const [name, value] of sessionSettings) {
    if (value === undefined) {
      throw new Error(
        `Missing required environment variable: ${name}`
      );
    }
  }
}

if (
  sessionTokenBytes !== undefined &&
  sessionMaxTokenLength !== undefined
) {
  const minimumEncodedTokenLength = Math.ceil(
    (sessionTokenBytes * 8) / 6
  );

  if (sessionMaxTokenLength < minimumEncodedTokenLength) {
    throw new Error(
      "SESSION_MAX_TOKEN_LENGTH is too small for SESSION_TOKEN_BYTES."
    );
  }
}

export const env = {
  nodeEnv,

  port: getPort(),

  appName: process.env.APP_NAME?.trim() || "LUMORA Backend",

  appVersion: process.env.APP_VERSION?.trim() || "0.1.0",

  databaseUrl: getOptionalString("DATABASE_URL"),

  jwtSecret: getOptionalString("JWT_SECRET"),

  corsOrigin: getOptionalString("CORS_ORIGIN"),

  logLevel: process.env.LOG_LEVEL?.trim() || "info",

  sessionTokenBytes,

  sessionTtlSeconds,

  sessionMaxTokenLength,

  sessionLastUsedUpdateIntervalSeconds
} as const;

export function requireProductionSecrets(): void {
  if (env.nodeEnv !== "production") {
    return;
  }

  getRequiredString("DATABASE_URL");
  getRequiredString("JWT_SECRET");
}

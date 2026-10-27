export type NodeEnvironment = "development" | "test" | "production";

function getEnvironment(): NodeEnvironment {
  const value = process.env.NODE_ENV ?? "development";

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

  return value ? value : undefined;
}

function getRequiredString(name: string): string {
  const value = getOptionalString(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getPort(): number {
  const rawPort = process.env.PORT ?? "3000";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${rawPort}".`);
  }

  return port;
}

export const env = {
  nodeEnv: getEnvironment(),

  port: getPort(),

  appName: process.env.APP_NAME?.trim() || "LUMORA Backend",

  appVersion: process.env.APP_VERSION?.trim() || "0.1.0",

  databaseUrl: getOptionalString("DATABASE_URL"),

  jwtSecret: getOptionalString("JWT_SECRET"),

  corsOrigin: getOptionalString("CORS_ORIGIN"),

  logLevel: process.env.LOG_LEVEL?.trim() || "info"
} as const;

export function requireProductionSecrets(): void {
  if (env.nodeEnv !== "production") {
    return;
  }

  getRequiredString("DATABASE_URL");
  getRequiredString("JWT_SECRET");
}


import { env } from "./env.js";

function requirePositiveInteger(
  name: string,
  value: number | undefined
): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      `Invalid or missing session configuration: ${name}`
    );
  }

  return value;
}

function requireNonNegativeInteger(
  name: string,
  value: number | undefined
): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `Invalid or missing session configuration: ${name}`
    );
  }

  return value;
}

const tokenBytes = requirePositiveInteger(
  "SESSION_TOKEN_BYTES",
  env.sessionTokenBytes
);

const ttlSeconds = requirePositiveInteger(
  "SESSION_TTL_SECONDS",
  env.sessionTtlSeconds
);

const maxTokenLength = requirePositiveInteger(
  "SESSION_MAX_TOKEN_LENGTH",
  env.sessionMaxTokenLength
);

const lastUsedUpdateIntervalSeconds =
  requireNonNegativeInteger(
    "SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS",
    env.sessionLastUsedUpdateIntervalSeconds
  );

const minimumEncodedTokenLength = Math.ceil(
  (tokenBytes * 8) / 6
);

if (maxTokenLength < minimumEncodedTokenLength) {
  throw new Error(
    "SESSION_MAX_TOKEN_LENGTH is too small for the configured token size."
  );
}

export const sessionConfig = Object.freeze({
  tokenBytes,
  ttlSeconds,
  maxTokenLength,
  lastUsedUpdateIntervalSeconds,
});

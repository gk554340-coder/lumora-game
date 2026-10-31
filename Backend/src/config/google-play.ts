/**
 * Google Play Billing settings.
 *
 * Payments are optional. If none of the GOOGLE_PLAY_* settings exist,
 * loadGooglePlayConfig returns null and the payment endpoints answer
 * 503 PAYMENTS_NOT_CONFIGURED. If only some of them exist the server
 * refuses to start, so a half-configured production never runs by
 * accident.
 */

export interface GooglePlayServiceAccount {
  clientEmail: string;
  privateKey: string;
}

export interface GooglePlayConfig {
  packageName: string;
  serviceAccount: GooglePlayServiceAccount;
  accountSecret: string;
  allowTestPurchases: boolean;
}

const MIN_ACCOUNT_SECRET_LENGTH = 32;

function optional(
  source: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = source[name]?.trim();
  return value || undefined;
}

function parseServiceAccount(raw: string): GooglePlayServiceAccount {
  const text = raw.startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must be JSON or base64-encoded JSON.",
    );
  }

  const data = parsed as Record<string, unknown> | null;
  const clientEmail = data?.client_email;
  const privateKey = data?.private_key;

  if (
    typeof clientEmail !== "string" ||
    typeof privateKey !== "string" ||
    !clientEmail ||
    !privateKey
  ) {
    throw new Error(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must contain client_email and private_key.",
    );
  }

  return { clientEmail, privateKey };
}

export function loadGooglePlayConfig(
  source: NodeJS.ProcessEnv = process.env,
): GooglePlayConfig | null {
  const packageName = optional(source, "GOOGLE_PLAY_PACKAGE_NAME");
  const serviceAccountRaw = optional(
    source,
    "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
  );
  const accountSecret = optional(source, "GOOGLE_PLAY_ACCOUNT_SECRET");

  const provided = [packageName, serviceAccountRaw, accountSecret].filter(
    (value) => value !== undefined,
  ).length;

  if (provided === 0) {
    return null;
  }

  if (
    packageName === undefined ||
    serviceAccountRaw === undefined ||
    accountSecret === undefined
  ) {
    throw new Error(
      "Google Play is partly configured. Set GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON and GOOGLE_PLAY_ACCOUNT_SECRET together, or none of them.",
    );
  }

  if (accountSecret.length < MIN_ACCOUNT_SECRET_LENGTH) {
    throw new Error(
      `GOOGLE_PLAY_ACCOUNT_SECRET must be at least ${MIN_ACCOUNT_SECRET_LENGTH} characters.`,
    );
  }

  const flag = optional(
    source,
    "GOOGLE_PLAY_ALLOW_TEST_PURCHASES",
  )?.toLowerCase();

  if (flag !== undefined && flag !== "true" && flag !== "false") {
    throw new Error(
      'Invalid GOOGLE_PLAY_ALLOW_TEST_PURCHASES. Expected "true" or "false".',
    );
  }

  const isProduction = source.NODE_ENV?.trim() === "production";

  return {
    packageName,
    serviceAccount: parseServiceAccount(serviceAccountRaw),
    accountSecret,
    allowTestPurchases:
      flag === undefined ? !isProduction : flag === "true",
  };
}

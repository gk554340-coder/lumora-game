import {
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import { UserStatus } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import { sessionConfig } from "../config/session.js";
import { AppError } from "../errors/AppError.js";
import { createSession } from "./session.service.js";

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
  legacy: boolean;
}

export interface PasswordVerification {
  valid: boolean;
  needsRehash: boolean;
}

// Parameters used for every new hash. To make hashing harder later,
// change these values: existing hashes keep working (their own
// parameters are stored inside them) and are upgraded at next login.
const CURRENT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

// Hashes created before parameters were stored (scrypt$salt$key).
const LEGACY_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

// Upper and lower bounds for parameters read back from the database, so
// a corrupted or tampered value cannot exhaust memory or CPU.
const MIN_N = 16384;
const MAX_N = 65536;
const MAX_R = 16;
const MAX_P = 4;

const PARAMS_PATTERN = /^N=(\d+),r=(\d+),p=(\d+)$/;
const SALT_PATTERN = /^[0-9a-f]{32}$/i;
const KEY_PATTERN = /^[0-9a-f]{128}$/i;

function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: 256 * params.N * params.r,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

function areParamsAllowed(params: ScryptParams): boolean {
  const { N, r, p } = params;

  return (
    Number.isSafeInteger(N) &&
    Number.isSafeInteger(r) &&
    Number.isSafeInteger(p) &&
    N >= MIN_N &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= MAX_R &&
    p >= 1 &&
    p <= MAX_P
  );
}

function buildParsedHash(
  params: ScryptParams,
  saltHex: string,
  keyHex: string,
  legacy: boolean,
): ParsedHash | null {
  if (!SALT_PATTERN.test(saltHex) || !KEY_PATTERN.test(keyHex)) {
    return null;
  }

  return {
    params,
    salt: Buffer.from(saltHex, "hex"),
    key: Buffer.from(keyHex, "hex"),
    legacy,
  };
}

function parseStoredHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");

  if (parts[0] !== "scrypt") {
    return null;
  }

  if (parts.length === 3) {
    return buildParsedHash(LEGACY_PARAMS, parts[1], parts[2], true);
  }

  if (parts.length === 4) {
    const match = PARAMS_PATTERN.exec(parts[1]);

    if (!match) {
      return null;
    }

    const params: ScryptParams = {
      N: Number(match[1]),
      r: Number(match[2]),
      p: Number(match[3]),
    };

    if (!areParamsAllowed(params)) {
      return null;
    }

    return buildParsedHash(params, parts[2], parts[3], false);
  }

  return null;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, CURRENT_PARAMS);
  const { N, r, p } = CURRENT_PARAMS;

  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(
  password: string,
  stored: string,
): Promise<PasswordVerification> {
  const parsed = parseStoredHash(stored);

  if (!parsed) {
    return { valid: false, needsRehash: false };
  }

  const actual = await deriveKey(password, parsed.salt, parsed.params);
  const valid = timingSafeEqual(actual, parsed.key);

  const outdated =
    parsed.legacy ||
    parsed.params.N !== CURRENT_PARAMS.N ||
    parsed.params.r !== CURRENT_PARAMS.r ||
    parsed.params.p !== CURRENT_PARAMS.p;

  return { valid, needsRehash: valid && outdated };
}

let dummyHashPromise: Promise<string> | undefined;

/**
 * A valid hash of a random value, created once on first use. Login
 * verifies against it when the account does not exist, so that every
 * login attempt costs one scrypt run regardless of the email.
 */
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHashPromise;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export async function registerUser(input: {
  email: string;
  password: string;
  username?: string;
}) {
  const email = input.email.trim().toLowerCase();
  const username = input.username?.trim() || undefined;

  const passwordHash = await hashPassword(input.password);

  let user;

  try {
    // Nested creates run in the same transaction as the user row, so a
    // user can never exist without its profile and wallet.
    user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        profile: { create: {} },
        wallet: { create: {} },
      },
      select: {
        id: true,
        email: true,
        username: true,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError(
        "ACCOUNT_ALREADY_EXISTS",
        "Email or username is already registered.",
        409,
      );
    }

    throw error;
  }

  const session = await createSession(user.id, sessionConfig);

  return {
    user,
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

export async function loginUser(input: {
  email: string;
  password: string;
}) {
  const email = input.email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      username: true,
      passwordHash: true,
      status: true,
    },
  });

  // Always run one password verification, even when the account does
  // not exist, so response time does not reveal registered emails.
  const storedHash = user?.passwordHash ?? (await getDummyHash());
  const verification = await verifyPassword(input.password, storedHash);

  if (!user || !user.passwordHash || !verification.valid) {
    throw new AppError(
      "INVALID_CREDENTIALS",
      "Email or password is incorrect.",
      401,
    );
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new AppError(
      "ACCOUNT_UNAVAILABLE",
      "This account is not available.",
      403,
    );
  }

  // Upgrade an outdated hash (old format or weaker parameters) now that
  // the correct password is known.
  const upgradedHash = verification.needsRehash
    ? await hashPassword(input.password)
    : undefined;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
      passwordHash: upgradedHash,
    },
  });

  const session = await createSession(user.id, sessionConfig);

  return {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
    },
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      username: true,
      status: true,
      createdAt: true,
    },
  });

  if (!user || user.status !== UserStatus.ACTIVE) {
    throw new AppError(
      "ACCOUNT_UNAVAILABLE",
      "This account is not available.",
      401,
    );
  }

  return user;
}

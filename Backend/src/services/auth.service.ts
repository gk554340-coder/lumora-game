
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
const SCRYPT_OPTIONS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

function deriveKey(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      SCRYPT_OPTIONS,
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

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt);

  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");

  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const saltHex = parts[1];
  const keyHex = parts[2];

  if (
    !/^[0-9a-f]{32}$/i.test(saltHex) ||
    !/^[0-9a-f]{128}$/i.test(keyHex)
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");

  if (
    salt.length !== SALT_LENGTH ||
    expected.length !== KEY_LENGTH
  ) {
    return false;
  }

  const actual = await deriveKey(password, salt);

  return timingSafeEqual(actual, expected);
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
    user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
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

  if (
    !user ||
    !user.passwordHash ||
    !(await verifyPassword(input.password, user.passwordHash))
  ) {
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

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
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

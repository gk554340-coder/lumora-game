import {
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import { promisify } from "node:util";
import { UserStatus } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import { sessionConfig } from "../config/session.js";
import { AppError } from "../errors/AppError.js";
import { createSession } from "./session.service.js";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, KEY_LENGTH, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;

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

  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");

  if (
    salt.length !== 16 ||
    expected.length !== KEY_LENGTH ||
    parts[1].length !== 32 ||
    parts[2].length !== KEY_LENGTH * 2
  ) {
    return false;
  }

  const actual = (await scryptAsync(password, salt, KEY_LENGTH, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;

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
  const username = input.username?.trim();

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
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

    const session = await createSession(user.id, sessionConfig);

    return {
      user,
      token: session.token,
      expiresAt: session.expiresAt,
    };
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

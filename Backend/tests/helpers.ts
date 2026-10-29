import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { disconnectDatabase } from "../src/config/prisma.js";
import { AppError } from "../src/errors/AppError.js";

export const TEST_PASSWORD = "correct-horse-battery-staple";

export interface TestUser {
  email: string;
  userId: string;
  token: string;
}

export async function startApp(): Promise<FastifyInstance> {
  const app = buildApp();
  await app.ready();
  return app;
}

export async function stopApp(app: FastifyInstance): Promise<void> {
  await app.close();
  await disconnectDatabase();
}

export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.test`;
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function registerTestUser(
  app: FastifyInstance,
): Promise<TestUser> {
  const email = uniqueEmail();

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: TEST_PASSWORD },
  });

  assert.equal(response.statusCode, 201);

  const body = response.json();

  return {
    email,
    userId: body.data.user.id,
    token: body.data.token,
  };
}

export async function expectAppError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, "expected an AppError");
    assert.equal(error.code, code);
    return true;
  });
}

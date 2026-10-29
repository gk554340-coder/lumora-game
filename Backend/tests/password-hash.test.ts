import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import {
  TEST_PASSWORD,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

const NEW_FORMAT =
  /^scrypt\$N=32768,r=8,p=1\$[0-9a-f]{32}\$[0-9a-f]{128}$/;

async function loginStatus(
  app: FastifyInstance,
  email: string,
): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: TEST_PASSWORD },
  });

  return response.statusCode;
}

describe("password hash", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  it("stores new hashes with their parameters", async () => {
    const user = await registerTestUser(app);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { passwordHash: true },
    });

    assert.match(stored.passwordHash ?? "", NEW_FORMAT);
  });

  it("accepts a legacy hash and upgrades it at login", async () => {
    const user = await registerTestUser(app);

    const salt = randomBytes(16);
    const key = scryptSync(TEST_PASSWORD, salt, 64, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const legacy = `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;

    await prisma.user.update({
      where: { id: user.userId },
      data: { passwordHash: legacy },
    });

    assert.equal(await loginStatus(app, user.email), 200);

    const upgraded = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { passwordHash: true },
    });

    assert.match(upgraded.passwordHash ?? "", NEW_FORMAT);
    assert.equal(await loginStatus(app, user.email), 200);
  });

  it("rejects a hash with absurd parameters instead of hanging", async () => {
    const user = await registerTestUser(app);

    const tampered = `scrypt$N=1073741824,r=8,p=1$${"a".repeat(32)}$${"b".repeat(128)}`;

    await prisma.user.update({
      where: { id: user.userId },
      data: { passwordHash: tampered },
    });

    assert.equal(await loginStatus(app, user.email), 401);
  });

  it("rejects a malformed hash", async () => {
    const user = await registerTestUser(app);

    await prisma.user.update({
      where: { id: user.userId },
      data: { passwordHash: "not-a-hash" },
    });

    assert.equal(await loginStatus(app, user.email), 401);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import {
  TEST_PASSWORD,
  bearer,
  registerTestUser,
  startApp,
  stopApp,
  uniqueEmail,
} from "./helpers.js";

describe("auth", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  it("serves the health endpoint", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ok");
  });

  it("registers a user together with a profile and a wallet", async () => {
    const user = await registerTestUser(app);

    const stored = await prisma.user.findUnique({
      where: { id: user.userId },
      include: { profile: true, wallet: true },
    });

    assert.ok(stored, "user row exists");
    assert.ok(stored.profile, "profile row exists");
    assert.ok(stored.wallet, "wallet row exists");
    assert.equal(stored.wallet.tokenBalance, 0);
    assert.equal(stored.wallet.gemBalance, 0);
    assert.notEqual(stored.passwordHash, TEST_PASSWORD);
  });

  it("rejects a duplicate email", async () => {
    const user = await registerTestUser(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: user.email, password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "ACCOUNT_ALREADY_EXISTS");
  });

  it("rejects a password that is too short", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: uniqueEmail(), password: "short" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
  });

  it("logs in with the right password", async () => {
    const user = await registerTestUser(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(typeof response.json().data.token, "string");
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const user = await registerTestUser(app);

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: "this-is-not-the-password" },
    });

    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: uniqueEmail(), password: TEST_PASSWORD },
    });

    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownEmail.statusCode, 401);
    assert.deepEqual(wrongPassword.json(), unknownEmail.json());
    assert.equal(wrongPassword.json().error.code, "INVALID_CREDENTIALS");
  });

  it("returns the current user for a valid token", async () => {
    const user = await registerTestUser(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: bearer(user.token),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.email, user.email);
  });

  it("rejects missing, malformed and unknown tokens with 401", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/auth/me",
    });

    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().error.code, "UNAUTHORIZED");

    const malformed = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: "Bearer bad token!" },
    });

    assert.equal(malformed.statusCode, 401);
    assert.equal(malformed.json().error.code, "INVALID_SESSION");

    const unknown = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: bearer("A".repeat(43)),
    });

    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().error.code, "INVALID_SESSION");
  });

  it("stops accepting a token after logout", async () => {
    const user = await registerTestUser(app);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: bearer(user.token),
    });

    assert.equal(logout.statusCode, 200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: bearer(user.token),
    });

    assert.equal(afterLogout.statusCode, 401);
  });

  it("blocks a suspended user immediately, even with a live session", async () => {
    const user = await registerTestUser(app);

    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "SUSPENDED" },
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: bearer(user.token),
    });

    assert.equal(me.statusCode, 401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: TEST_PASSWORD },
    });

    assert.equal(login.statusCode, 403);
    assert.equal(login.json().error.code, "ACCOUNT_UNAVAILABLE");
  });
});

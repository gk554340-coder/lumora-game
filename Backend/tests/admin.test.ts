import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import { ensureDefaultProducts } from "../src/modules/payments/product.catalog.js";
import { getWalletBalances, reconcileWallet } from "../src/modules/wallet/wallet.service.js";
import {
  TEST_PASSWORD,
  bearer,
  registerTestUser,
  startApp,
  stopApp,
  type TestUser,
} from "./helpers.js";

const ADMIN_KEY = "test-admin-key-".padEnd(48, "k");

// Set before the app starts: both are read when the routes are created.
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.ADMIN_RATE_LIMIT_MAX = "1000";

describe("admin", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  const admin = { "x-admin-key": ADMIN_KEY };

  async function auditCount(userId: string): Promise<number> {
    return prisma.auditLog.count({
      where: { userId, action: "ADMIN_ACTION" },
    });
  }

  async function post(url: string, payload: unknown, headers = admin) {
    return app.inject({ method: "POST", url, headers, payload });
  }

  it("refuses requests without the right key", async () => {
    const { userId } = await registerTestUser(app);
    const url = `/api/admin/users/lookup?id=${userId}`;

    const missing = await app.inject({ method: "GET", url });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().error.code, "ADMIN_UNAUTHORIZED");

    const wrong = await app.inject({
      method: "GET",
      url,
      headers: { "x-admin-key": "x".repeat(48) },
    });
    assert.equal(wrong.statusCode, 401);

    // A normal player token is not an admin key.
    const player = await registerTestUser(app);
    const asPlayer = await app.inject({
      method: "GET",
      url,
      headers: bearer(player.token),
    });
    assert.equal(asPlayer.statusCode, 401);

    const allowed = await app.inject({ method: "GET", url, headers: admin });
    assert.equal(allowed.statusCode, 200);
  });

  it("does not exist when no key is configured", async () => {
    const { userId } = await registerTestUser(app);

    delete process.env.ADMIN_API_KEY;

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/admin/users/lookup?id=${userId}`,
        headers: admin,
      });

      assert.equal(response.statusCode, 404);
    } finally {
      process.env.ADMIN_API_KEY = ADMIN_KEY;
    }
  });

  it("looks a player up by email or id without leaking secrets", async () => {
    const user = await registerTestUser(app);

    const byEmail = await app.inject({
      method: "GET",
      url: `/api/admin/users/lookup?email=${encodeURIComponent(user.email.toUpperCase())}`,
      headers: admin,
    });
    assert.equal(byEmail.statusCode, 200);

    const data = byEmail.json().data;
    assert.equal(data.user.id, user.userId);
    assert.equal(data.user.status, "ACTIVE");
    assert.equal(data.wallet.ledgerConsistent, true);
    assert.equal(data.activity.activeSessions, 1);
    assert.equal(JSON.stringify(byEmail.json()).includes("passwordHash"), false);

    const byId = await app.inject({
      method: "GET",
      url: `/api/admin/users/lookup?id=${user.userId}`,
      headers: admin,
    });
    assert.equal(byId.json().data.user.email, user.email);

    for (const query of ["", "email=a@b.test&id=" + user.userId]) {
      const bad = await app.inject({
        method: "GET",
        url: `/api/admin/users/lookup?${query}`,
        headers: admin,
      });
      assert.equal(bad.statusCode, 400);
    }

    const unknown = await app.inject({
      method: "GET",
      url: `/api/admin/users/lookup?id=${randomUUID()}`,
      headers: admin,
    });
    assert.equal(unknown.statusCode, 404);

    const malformed = await app.inject({
      method: "GET",
      url: "/api/admin/users/lookup?id=nope",
      headers: admin,
    });
    assert.equal(malformed.statusCode, 404);
  });

  async function login(user: TestUser) {
    return app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: TEST_PASSWORD },
    });
  }

  it("suspends a player, logs them out and can reactivate them", async () => {
    const user = await registerTestUser(app);

    const before = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: bearer(user.token),
    });
    assert.equal(before.statusCode, 200);

    const missingReason = await post(
      `/api/admin/users/${user.userId}/suspend`,
      { reason: "x" },
    );
    assert.equal(missingReason.statusCode, 400);

    const suspended = await post(`/api/admin/users/${user.userId}/suspend`, {
      reason: "Chargeback abuse",
    });
    assert.equal(suspended.statusCode, 200);
    assert.equal(suspended.json().data.changed, true);

    // The old session stops working and a new login is refused.
    const blocked = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: bearer(user.token),
    });
    assert.equal(blocked.statusCode, 401);
    assert.notEqual((await login(user)).statusCode, 200);

    // Sending it again changes nothing and is not logged twice.
    const again = await post(`/api/admin/users/${user.userId}/suspend`, {
      reason: "Chargeback abuse",
    });
    assert.equal(again.json().data.changed, false);
    assert.equal(await auditCount(user.userId), 1);

    const reactivated = await post(
      `/api/admin/users/${user.userId}/reactivate`,
      { reason: "Appeal accepted" },
    );
    assert.equal(reactivated.json().data.changed, true);

    // The old token stays revoked, but the player can log in again.
    const stillBlocked = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: bearer(user.token),
    });
    assert.equal(stillBlocked.statusCode, 401);
    assert.equal((await login(user)).statusCode, 200);

    const reactivatedAgain = await post(
      `/api/admin/users/${user.userId}/reactivate`,
      { reason: "Appeal accepted" },
    );
    assert.equal(reactivatedAgain.json().data.changed, false);
    assert.equal(await auditCount(user.userId), 2);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { userId: user.userId, action: "ADMIN_ACTION" },
      orderBy: { createdAt: "asc" },
    });
    const metadata = log.metadata as Record<string, unknown>;
    assert.equal(metadata.action, "suspend");
    assert.equal(metadata.reason, "Chargeback abuse");
    assert.equal(metadata.actor, "admin-key");
  });

  it("does not change deleted or unknown accounts", async () => {
    const user = await registerTestUser(app);
    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "DELETED" },
    });

    const deleted = await post(`/api/admin/users/${user.userId}/suspend`, {
      reason: "Test reason",
    });
    assert.equal(deleted.statusCode, 409);
    assert.equal(deleted.json().error.code, "USER_DELETED");

    const unknown = await post(`/api/admin/users/${randomUUID()}/suspend`, {
      reason: "Test reason",
    });
    assert.equal(unknown.statusCode, 404);
  });

  it("adjusts a wallet once per request id and records it", async () => {
    const user = await registerTestUser(app);
    const url = `/api/admin/users/${user.userId}/wallet-adjust`;
    const requestId = `req-${randomUUID()}`;

    const credit = await post(url, {
      currency: "GEM",
      direction: "CREDIT",
      amount: 25,
      reason: "Compensation for a bug",
      requestId,
    });
    assert.equal(credit.statusCode, 200);
    assert.equal(credit.json().data.replayed, false);
    assert.equal(credit.json().data.balances.gemBalance, 25);

    // The same request id again does not apply twice.
    const replay = await post(url, {
      currency: "GEM",
      direction: "CREDIT",
      amount: 25,
      reason: "Compensation for a bug",
      requestId,
    });
    assert.equal(replay.json().data.replayed, true);
    assert.equal((await getWalletBalances(user.userId)).gemBalance, 25);
    assert.equal(await auditCount(user.userId), 1);

    const debit = await post(url, {
      currency: "GEM",
      direction: "DEBIT",
      amount: 10,
      reason: "Correction",
      requestId: `req-${randomUUID()}`,
    });
    assert.equal(debit.json().data.balances.gemBalance, 15);

    const tooMuch = await post(url, {
      currency: "GEM",
      direction: "DEBIT",
      amount: 1000,
      reason: "Correction",
      requestId: `req-${randomUUID()}`,
    });
    assert.equal(tooMuch.statusCode >= 400, true);
    assert.equal(tooMuch.json().error.code, "INSUFFICIENT_FUNDS");
    assert.equal((await getWalletBalances(user.userId)).gemBalance, 15);

    const ledger = await prisma.walletTransaction.count({
      where: { userId: user.userId, source: "ADMIN" },
    });
    assert.equal(ledger, 2);
    assert.equal(await auditCount(user.userId), 2);
    assert.equal((await reconcileWallet(user.userId)).consistent, true);
  });

  it("rejects invalid wallet adjustments", async () => {
    const user = await registerTestUser(app);
    const url = `/api/admin/users/${user.userId}/wallet-adjust`;
    const base = {
      currency: "TOKEN",
      direction: "CREDIT",
      amount: 5,
      reason: "Valid reason",
      requestId: `req-${randomUUID()}`,
    };

    // Fastify drops unknown fields instead of failing, so an extra field
    // is not an invalid request and is not listed here.
    const cases: Array<Record<string, unknown>> = [
      { ...base, currency: "COIN" },
      { ...base, direction: "SIDEWAYS" },
      { ...base, amount: 0 },
      { ...base, amount: -5 },
      { ...base, amount: 100_001 },
      { ...base, amount: 1.5 },
      { ...base, reason: "  " },
      { ...base, requestId: "short" },
    ];

    for (const payload of cases) {
      const response = await post(url, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }

    const unknown = await post(
      `/api/admin/users/${randomUUID()}/wallet-adjust`,
      base,
    );
    assert.equal(unknown.statusCode, 404);

    assert.equal((await getWalletBalances(user.userId)).tokenBalance, 0);
  });

  it("lists refunds that could not be taken back in full", async () => {
    const user = await registerTestUser(app);
    await ensureDefaultProducts();

    const product = await prisma.purchaseProduct.findUniqueOrThrow({
      where: { sku: "lumora_gems_60" },
    });

    const purchase = await prisma.purchase.create({
      data: {
        userId: user.userId,
        productId: product.id,
        status: "REFUNDED",
        amountMinorUnit: product.priceMinorUnit,
        currency: product.currency,
        idempotencyKey: `test:${randomUUID()}`,
        refundedAt: new Date(),
      },
    });

    const payment = await prisma.payment.create({
      data: {
        userId: user.userId,
        purchaseId: purchase.id,
        provider: "GOOGLE_PLAY",
        status: "REFUNDED",
        providerOrderId: `GPA.${randomUUID()}`,
        amountMinorUnit: product.priceMinorUnit,
        currency: product.currency,
        refundedAt: new Date(),
        metadata: {
          refund: { unrecoveredGems: 40, unrecoveredTokens: 0 },
        },
      },
    });

    // A fully recovered refund must not appear.
    const clean = await prisma.purchase.create({
      data: {
        userId: user.userId,
        productId: product.id,
        status: "REFUNDED",
        amountMinorUnit: product.priceMinorUnit,
        currency: product.currency,
        idempotencyKey: `test:${randomUUID()}`,
        refundedAt: new Date(),
      },
    });
    const cleanPayment = await prisma.payment.create({
      data: {
        userId: user.userId,
        purchaseId: clean.id,
        provider: "GOOGLE_PLAY",
        status: "REFUNDED",
        providerOrderId: `GPA.${randomUUID()}`,
        amountMinorUnit: product.priceMinorUnit,
        currency: product.currency,
        refundedAt: new Date(),
        metadata: {
          refund: { unrecoveredGems: 0, unrecoveredTokens: 0 },
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/refunds/unrecovered?limit=200",
      headers: admin,
    });
    assert.equal(response.statusCode, 200);

    const items = response.json().data.items as Array<{
      paymentId: string;
      userId: string;
      sku: string;
      unrecoveredGems: number;
    }>;

    const found = items.find((item) => item.paymentId === payment.id);
    assert.equal(found?.userId, user.userId);
    assert.equal(found?.sku, "lumora_gems_60");
    assert.equal(found?.unrecoveredGems, 40);
    assert.equal(
      items.some((item) => item.paymentId === cleanPayment.id),
      false,
    );

    const badLimit = await app.inject({
      method: "GET",
      url: "/api/admin/refunds/unrecovered?limit=1000",
      headers: admin,
    });
    assert.equal(badLimit.statusCode, 400);
    assert.equal(badLimit.json().error.code, "INVALID_LIMIT");
  });
});

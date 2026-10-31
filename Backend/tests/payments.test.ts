import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import type {
  PlayBillingClient,
  PlayProductPurchase,
} from "../src/modules/payments/google-play.client.js";
import { PlayApiError } from "../src/modules/payments/google-play.client.js";
import {
  hashPurchaseToken,
  verifyGooglePlayPurchase,
} from "../src/modules/payments/payment.service.js";
import {
  obfuscatedAccountId,
  setPaymentsRuntime,
} from "../src/modules/payments/payments.runtime.js";
import { ensureDefaultProducts } from "../src/modules/payments/product.catalog.js";
import { reconcileWallet } from "../src/modules/wallet/wallet.service.js";
import {
  bearer,
  expectAppError,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

const SECRET = "test-secret-".padEnd(40, "x");

class FakePlayClient implements PlayBillingClient {
  purchases = new Map<string, PlayProductPurchase | null>();
  getCalls = 0;
  consumeCalls = 0;
  failGet = false;
  failConsume = false;

  async getProductPurchase(
    _sku: string,
    token: string,
  ): Promise<PlayProductPurchase | null> {
    this.getCalls += 1;

    if (this.failGet) {
      throw new PlayApiError("down", 503);
    }

    return this.purchases.get(token) ?? null;
  }

  async consume(_sku: string, token: string): Promise<void> {
    this.consumeCalls += 1;

    if (this.failConsume) {
      throw new PlayApiError("fail", 500);
    }

    const purchase = this.purchases.get(token);

    if (purchase) {
      purchase.consumptionState = 1;
    }
  }
}

function purchaseFor(
  userId: string,
  sku: string,
  overrides: Partial<PlayProductPurchase> = {},
): PlayProductPurchase {
  return {
    orderId: `GPA.${randomUUID()}`,
    productId: sku,
    purchaseState: 0,
    consumptionState: 0,
    quantity: 1,
    obfuscatedExternalAccountId: obfuscatedAccountId(SECRET, userId),
    purchaseType: null,
    ...overrides,
  };
}

describe("google play payments", () => {
  let app: FastifyInstance;
  let client: FakePlayClient;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    setPaymentsRuntime(null);
    await stopApp(app);
  });

  beforeEach(() => {
    client = new FakePlayClient();
    setPaymentsRuntime({
      client,
      accountSecret: SECRET,
      allowTestPurchases: true,
    });
  });

  function register(
    sku: string,
    userId: string,
    overrides: Partial<PlayProductPurchase> = {},
  ): string {
    const token = `token-${randomUUID()}`;
    client.purchases.set(token, purchaseFor(userId, sku, overrides));
    return token;
  }

  it("grants gems once, consumes and keeps the ledger consistent", async () => {
    const { userId } = await registerTestUser(app);
    const token = register("lumora_gems_60", userId);

    const result = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_60",
      token,
    );

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.granted.gems, 60);
    assert.equal(result.balances.gemBalance, 60);
    assert.equal(result.consumed, true);
    assert.equal(result.replayed, false);
    assert.equal(client.consumeCalls, 1);

    const purchase = await prisma.purchase.findUniqueOrThrow({
      where: { id: result.purchaseId },
      include: { payments: true },
    });

    assert.equal(purchase.status, "COMPLETED");
    assert.equal(purchase.payments.length, 1);
    assert.equal(purchase.payments[0]?.provider, "GOOGLE_PLAY");
    assert.equal(
      purchase.payments[0]?.providerPaymentId,
      hashPurchaseToken(token),
    );

    // The raw token is never stored.
    const stored = JSON.stringify(purchase);
    assert.equal(stored.includes(token), false);

    const report = await reconcileWallet(userId);
    assert.equal(report.consistent, true);
  });

  it("replays the same token without paying again", async () => {
    const { userId } = await registerTestUser(app);
    const token = register("lumora_gems_150", userId);

    await verifyGooglePlayPurchase(userId, "lumora_gems_150", token);
    const calls = client.getCalls;

    const again = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_150",
      token,
    );

    assert.equal(again.replayed, true);
    assert.equal(again.balances.gemBalance, 150);
    assert.equal(client.getCalls, calls);
    assert.equal(client.consumeCalls, 1);
  });

  it("does not let another user use a token", async () => {
    const owner = await registerTestUser(app);
    const other = await registerTestUser(app);
    const token = register("lumora_gems_60", owner.userId);

    await verifyGooglePlayPurchase(owner.userId, "lumora_gems_60", token);

    await expectAppError(
      verifyGooglePlayPurchase(other.userId, "lumora_gems_60", token),
      "PURCHASE_TOKEN_IN_USE",
    );
  });

  it("pays only once for parallel verifies", async () => {
    const { userId } = await registerTestUser(app);
    const token = register("lumora_gems_60", userId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        verifyGooglePlayPurchase(userId, "lumora_gems_60", token),
      ),
    );

    for (const result of results) {
      assert.equal(result.status, "COMPLETED");
    }

    const balance = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    assert.equal(balance.gemBalance, 60);

    const purchases = await prisma.purchase.count({ where: { userId } });
    assert.equal(purchases, 1);
  });

  it("rejects a purchase started by a different account", async () => {
    const buyer = await registerTestUser(app);
    const thief = await registerTestUser(app);
    const token = register("lumora_gems_60", buyer.userId);

    await expectAppError(
      verifyGooglePlayPurchase(thief.userId, "lumora_gems_60", token),
      "PURCHASE_ACCOUNT_MISMATCH",
    );

    assert.equal(
      await prisma.purchase.count({ where: { userId: thief.userId } }),
      0,
    );
  });

  it("rejects missing accounts ids, unknown tokens and unpaid states", async () => {
    const { userId } = await registerTestUser(app);

    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", "unknown-token"),
      "PURCHASE_INVALID",
    );

    const noAccount = register("lumora_gems_60", userId, {
      obfuscatedExternalAccountId: null,
    });
    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", noAccount),
      "PURCHASE_ACCOUNT_MISMATCH",
    );

    const pending = register("lumora_gems_60", userId, {
      purchaseState: 2,
    });
    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", pending),
      "PURCHASE_PENDING",
    );

    const canceled = register("lumora_gems_60", userId, {
      purchaseState: 1,
    });
    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", canceled),
      "PURCHASE_INVALID",
    );

    assert.equal(
      (await prisma.wallet.findUniqueOrThrow({ where: { userId } }))
        .gemBalance,
      0,
    );
  });

  it("rejects wrong product, quantity and purchase types", async () => {
    const { userId } = await registerTestUser(app);

    const wrongProduct = register("lumora_gems_400", userId);
    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", wrongProduct),
      "PURCHASE_INVALID",
    );

    const many = register("lumora_gems_60", userId, { quantity: 3 });
    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", many),
      "PURCHASE_INVALID",
    );

    const rewarded = register("lumora_gems_60", userId, {
      purchaseType: 2,
    });
    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", rewarded),
      "PURCHASE_INVALID",
    );

    setPaymentsRuntime({
      client,
      accountSecret: SECRET,
      allowTestPurchases: false,
    });

    const test = register("lumora_gems_60", userId, { purchaseType: 0 });
    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", test),
      "PURCHASE_INVALID",
    );

    setPaymentsRuntime({
      client,
      accountSecret: SECRET,
      allowTestPurchases: true,
    });

    const accepted = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_60",
      test,
    );
    assert.equal(accepted.balances.gemBalance, 60);
  });

  it("rejects unknown and malformed products", async () => {
    const { userId } = await registerTestUser(app);

    await expectAppError(
      verifyGooglePlayPurchase(userId, "no_such_sku", "tok"),
      "PRODUCT_NOT_FOUND",
    );
    await expectAppError(
      verifyGooglePlayPurchase(userId, "Bad Sku!", "tok"),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", "   "),
      "VALIDATION_ERROR",
    );
  });

  it("keeps the grant when consume fails and retries on replay", async () => {
    const { userId } = await registerTestUser(app);
    const token = register("lumora_gems_60", userId);

    client.failConsume = true;

    const first = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_60",
      token,
    );
    assert.equal(first.consumed, false);
    assert.equal(first.balances.gemBalance, 60);

    client.failConsume = false;

    const second = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_60",
      token,
    );
    assert.equal(second.consumed, true);
    assert.equal(second.balances.gemBalance, 60);
  });

  it("treats an already consumed purchase as consumed", async () => {
    const { userId } = await registerTestUser(app);
    const token = register("lumora_gems_60", userId);

    client.failConsume = true;
    const purchase = client.purchases.get(token);
    assert.ok(purchase);
    purchase.consumptionState = 1;

    const result = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_60",
      token,
    );
    assert.equal(result.consumed, true);
  });

  it("answers 503 when Google is down and grants nothing", async () => {
    const { userId } = await registerTestUser(app);
    const token = register("lumora_gems_60", userId);

    client.failGet = true;

    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", token),
      "PAYMENT_PROVIDER_UNAVAILABLE",
    );

    assert.equal(
      await prisma.purchase.count({ where: { userId } }),
      0,
    );

    client.failGet = false;

    const result = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_60",
      token,
    );
    assert.equal(result.balances.gemBalance, 60);
  });

  it("finishes an interrupted grant without paying twice", async () => {
    const { userId } = await registerTestUser(app);
    const token = register("lumora_gems_150", userId);

    await ensureDefaultProducts();

    const product = await prisma.purchaseProduct.findUniqueOrThrow({
      where: { sku: "lumora_gems_150" },
    });

    const tokenHash = hashPurchaseToken(token);

    // State after a crash: Google confirmed, rows exist, no gems yet.
    const purchase = await prisma.purchase.create({
      data: {
        userId,
        productId: product.id,
        status: "PENDING",
        amountMinorUnit: product.priceMinorUnit,
        currency: product.currency,
        idempotencyKey: `gp:${tokenHash}`,
      },
    });

    await prisma.payment.create({
      data: {
        userId,
        purchaseId: purchase.id,
        provider: "GOOGLE_PLAY",
        status: "CAPTURED",
        providerOrderId: `GPA.${randomUUID()}`,
        providerPaymentId: tokenHash,
        amountMinorUnit: product.priceMinorUnit,
        currency: product.currency,
        capturedAt: new Date(),
      },
    });

    const getCallsBefore = client.getCalls;

    const result = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_150",
      token,
    );

    assert.equal(result.balances.gemBalance, 150);
    assert.equal(client.getCalls, getCallsBefore);

    const completed = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    assert.equal(completed.status, "COMPLETED");

    const again = await verifyGooglePlayPurchase(
      userId,
      "lumora_gems_150",
      token,
    );
    assert.equal(again.balances.gemBalance, 150);
  });

  it("works over HTTP and requires login", async () => {
    const user = await registerTestUser(app);

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/payments/products",
    });
    assert.equal(anonymous.statusCode, 401);

    const products = await app.inject({
      method: "GET",
      url: "/api/payments/products",
      headers: bearer(user.token),
    });
    assert.equal(products.statusCode, 200);
    assert.equal(products.json().data.enabled, true);
    assert.ok(products.json().data.products.length >= 4);

    const accountId = await app.inject({
      method: "GET",
      url: "/api/payments/google-play/account-id",
      headers: bearer(user.token),
    });
    assert.equal(accountId.statusCode, 200);
    assert.equal(
      accountId.json().data.accountId,
      obfuscatedAccountId(SECRET, user.userId),
    );

    const token = register("lumora_gems_400", user.userId);

    const verify = await app.inject({
      method: "POST",
      url: "/api/payments/google-play/verify",
      headers: bearer(user.token),
      payload: { sku: "lumora_gems_400", purchaseToken: token },
    });
    assert.equal(verify.statusCode, 200);
    assert.equal(verify.json().data.balances.gemBalance, 400);

    const badBody = await app.inject({
      method: "POST",
      url: "/api/payments/google-play/verify",
      headers: bearer(user.token),
      payload: { sku: "lumora_gems_400" },
    });
    assert.equal(badBody.statusCode, 400);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/payments/google-play/verify",
      headers: bearer(user.token),
      payload: { sku: "lumora_gems_400", purchaseToken: "nope" },
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.json().error.code, "PURCHASE_INVALID");
  });

  it("answers 503 when payments are not configured", async () => {
    const user = await registerTestUser(app);
    setPaymentsRuntime(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/google-play/verify",
      headers: bearer(user.token),
      payload: { sku: "lumora_gems_60", purchaseToken: "tok" },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "PAYMENTS_NOT_CONFIGURED");

    const products = await app.inject({
      method: "GET",
      url: "/api/payments/products",
      headers: bearer(user.token),
    });
    assert.equal(products.json().data.enabled, false);
  });
});

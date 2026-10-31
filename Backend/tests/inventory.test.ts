import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import { ensureDefaultItems } from "../src/modules/inventory/item.catalog.js";
import {
  equipItem,
  getInventory,
  listShop,
  purchaseItem,
  unequipSlot,
} from "../src/modules/inventory/inventory.service.js";
import {
  creditWallet,
  debitWallet,
  getWalletBalances,
  reconcileWallet,
} from "../src/modules/wallet/wallet.service.js";
import {
  bearer,
  expectAppError,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

const GOLD = "light_aurora_gold"; // 40 gems, light_color
const RUBY = "light_ruby_flare"; // 60 gems, light_color
const MIDNIGHT = "board_midnight"; // 80 gems, board_theme

describe("shop and inventory", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  async function playerWithGems(gems: number): Promise<string> {
    const { userId } = await registerTestUser(app);

    if (gems > 0) {
      await creditWallet({
        userId,
        currency: "GEM",
        source: "BONUS",
        amount: gems,
      });
    }

    return userId;
  }

  it("lists the shop with prices and nothing owned", async () => {
    const userId = await playerWithGems(100);
    const shop = await listShop(userId);

    assert.equal(shop.gemBalance, 100);
    assert.ok(shop.items.length >= 5);

    const gold = shop.items.find((item) => item.sku === GOLD);
    assert.equal(gold?.gemPrice, 40);
    assert.equal(gold?.slot, "light_color");
    assert.equal(gold?.owned, false);
    assert.equal(gold?.equipped, false);
  });

  it("buys an item, takes the gems and keeps the ledger consistent", async () => {
    const userId = await playerWithGems(100);

    const result = await purchaseItem(userId, GOLD);

    assert.equal(result.gemPrice, 40);
    assert.equal(result.balances.gemBalance, 60);

    const inventory = await getInventory(userId);
    assert.equal(inventory.items.length, 1);
    assert.equal(inventory.items[0]?.sku, GOLD);
    assert.equal(inventory.items[0]?.equipped, false);

    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("refuses when gems are short and changes nothing", async () => {
    const userId = await playerWithGems(30);

    await expectAppError(purchaseItem(userId, GOLD), "INSUFFICIENT_FUNDS");

    assert.equal((await getWalletBalances(userId)).gemBalance, 30);
    assert.equal((await getInventory(userId)).items.length, 0);
  });

  it("does not sell the same item twice", async () => {
    const userId = await playerWithGems(200);

    await purchaseItem(userId, GOLD);
    await expectAppError(purchaseItem(userId, GOLD), "ITEM_ALREADY_OWNED");

    assert.equal((await getWalletBalances(userId)).gemBalance, 160);
  });

  it("charges once for parallel purchases", async () => {
    const userId = await playerWithGems(200);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => purchaseItem(userId, GOLD)),
    );

    assert.ok(
      results.some((result) => result.status === "fulfilled"),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        const error = result.reason as { code?: string };
        assert.equal(error.code, "ITEM_ALREADY_OWNED");
      }
    }

    assert.equal((await getWalletBalances(userId)).gemBalance, 160);
    assert.equal((await getInventory(userId)).items.length, 1);
    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("finishes an interrupted purchase without charging twice", async () => {
    const userId = await playerWithGems(100);

    // State after a crash: gems taken, item not yet added.
    await debitWallet({
      userId,
      currency: "GEM",
      source: "PURCHASE",
      amount: 40,
      idempotencyKey: `shop:${userId}:${GOLD}`,
    });

    const result = await purchaseItem(userId, GOLD);

    assert.equal(result.balances.gemBalance, 60);
    assert.equal((await getInventory(userId)).items.length, 1);
  });

  it("rejects unknown and malformed items", async () => {
    const userId = await playerWithGems(100);

    await expectAppError(purchaseItem(userId, "no_such_item"), "ITEM_NOT_FOUND");
    await expectAppError(purchaseItem(userId, "Bad Item!"), "VALIDATION_ERROR");
  });

  it("does not sell an item without a valid price", async () => {
    const userId = await playerWithGems(100);
    await ensureDefaultItems();

    const free = await prisma.inventoryItem.create({
      data: {
        sku: `broken_${Date.now()}`,
        name: "Broken",
        type: "COSMETIC",
        metadata: { slot: "light_color" },
      },
    });

    await expectAppError(
      purchaseItem(userId, free.sku),
      "ITEM_NOT_FOR_SALE",
    );

    const shop = await listShop(userId);
    assert.equal(
      shop.items.some((item) => item.sku === free.sku),
      false,
    );

    await prisma.inventoryItem.delete({ where: { id: free.id } });
  });

  it("equips only owned items, one per slot", async () => {
    const userId = await playerWithGems(300);

    await expectAppError(equipItem(userId, GOLD), "ITEM_NOT_OWNED");

    await purchaseItem(userId, GOLD);
    await purchaseItem(userId, RUBY);
    await purchaseItem(userId, MIDNIGHT);

    await equipItem(userId, GOLD);
    await equipItem(userId, MIDNIGHT);

    let items = (await getInventory(userId)).items;
    const equipped = (sku: string) =>
      items.find((item) => item.sku === sku)?.equipped;

    assert.equal(equipped(GOLD), true);
    assert.equal(equipped(MIDNIGHT), true);

    // Another item in the same slot replaces the first one.
    await equipItem(userId, RUBY);
    items = (await getInventory(userId)).items;

    assert.equal(equipped(GOLD), false);
    assert.equal(equipped(RUBY), true);
    assert.equal(equipped(MIDNIGHT), true);

    const removed = await unequipSlot(userId, "light_color");
    assert.equal(removed.unequipped, 1);

    items = (await getInventory(userId)).items;
    assert.equal(equipped(RUBY), false);
    assert.equal(equipped(MIDNIGHT), true);

    await expectAppError(unequipSlot(userId, "Bad Slot!"), "VALIDATION_ERROR");
  });

  it("keeps one player's items away from another", async () => {
    const owner = await playerWithGems(100);
    const other = await playerWithGems(100);

    await purchaseItem(owner, GOLD);

    await expectAppError(equipItem(other, GOLD), "ITEM_NOT_OWNED");
    assert.equal((await getInventory(other)).items.length, 0);
  });

  it("works over HTTP and requires login", async () => {
    const user = await registerTestUser(app);
    await creditWallet({
      userId: user.userId,
      currency: "GEM",
      source: "BONUS",
      amount: 100,
    });

    const anonymous = await app.inject({ method: "GET", url: "/api/shop" });
    assert.equal(anonymous.statusCode, 401);

    const shop = await app.inject({
      method: "GET",
      url: "/api/shop",
      headers: bearer(user.token),
    });
    assert.equal(shop.statusCode, 200);
    assert.ok(shop.json().data.items.length >= 5);

    const buy = await app.inject({
      method: "POST",
      url: "/api/shop/purchase",
      headers: bearer(user.token),
      payload: { sku: GOLD },
    });
    assert.equal(buy.statusCode, 200);
    assert.equal(buy.json().data.balances.gemBalance, 60);

    const again = await app.inject({
      method: "POST",
      url: "/api/shop/purchase",
      headers: bearer(user.token),
      payload: { sku: GOLD },
    });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, "ITEM_ALREADY_OWNED");

    const equip = await app.inject({
      method: "POST",
      url: "/api/inventory/equip",
      headers: bearer(user.token),
      payload: { sku: GOLD },
    });
    assert.equal(equip.statusCode, 200);

    const inventory = await app.inject({
      method: "GET",
      url: "/api/inventory",
      headers: bearer(user.token),
    });
    assert.equal(inventory.json().data.items[0].equipped, true);

    const unequip = await app.inject({
      method: "POST",
      url: "/api/inventory/unequip",
      headers: bearer(user.token),
      payload: { slot: "light_color" },
    });
    assert.equal(unequip.json().data.unequipped, 1);

    const badBody = await app.inject({
      method: "POST",
      url: "/api/shop/purchase",
      headers: bearer(user.token),
      payload: {},
    });
    assert.equal(badBody.statusCode, 400);
  });
});

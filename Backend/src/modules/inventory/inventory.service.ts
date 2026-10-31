import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import {
  debitWallet,
  getWalletBalances,
} from "../wallet/wallet.service.js";
import { ensureDefaultItems } from "./item.catalog.js";

/**
 * Shop and inventory.
 *
 * The server decides everything: the price comes from the database,
 * gems are taken from the wallet, and the item is added. A cosmetic
 * item can be owned once. Buying uses a fixed idempotency key per
 * player and item, so a double tap, a retry or a crash between the two
 * steps never charges twice.
 */

const SKU_PATTERN = /^[a-z0-9._]{1,100}$/;
const SLOT_PATTERN = /^[a-z0-9_]{1,50}$/;

interface ItemRules {
  gemPrice: number | null;
  slot: string | null;
}

function readRules(metadata: unknown): ItemRules {
  const data =
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};

  const price = data.gemPrice;
  const slot = data.slot;

  return {
    gemPrice:
      typeof price === "number" && Number.isInteger(price) && price > 0
        ? price
        : null,
    slot: typeof slot === "string" && SLOT_PATTERN.test(slot) ? slot : null,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function validateSku(sku: string): void {
  if (!SKU_PATTERN.test(sku)) {
    throw new AppError("VALIDATION_ERROR", "Invalid item id.", 400);
  }
}

async function findItem(sku: string) {
  validateSku(sku);
  await ensureDefaultItems();

  const item = await prisma.inventoryItem.findUnique({ where: { sku } });

  if (!item || !item.isActive) {
    throw new AppError("ITEM_NOT_FOUND", "Item not found.", 404);
  }

  return item;
}

export async function listShop(userId: string) {
  await ensureDefaultItems();

  const [items, entries, balances] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { isActive: true },
      orderBy: { sku: "asc" },
    }),
    prisma.inventoryEntry.findMany({
      where: { userId, quantity: { gt: 0 } },
      select: { itemId: true, equipped: true },
    }),
    getWalletBalances(userId),
  ]);

  const owned = new Map(entries.map((entry) => [entry.itemId, entry]));

  return {
    gemBalance: balances.gemBalance,
    items: items
      .map((item) => ({ item, rules: readRules(item.metadata) }))
      // An item without a valid price cannot be sold.
      .filter(({ rules }) => rules.gemPrice !== null)
      .map(({ item, rules }) => ({
        sku: item.sku,
        name: item.name,
        description: item.description,
        type: item.type,
        slot: rules.slot,
        gemPrice: rules.gemPrice,
        owned: owned.has(item.id),
        equipped: owned.get(item.id)?.equipped ?? false,
      })),
  };
}

export async function getInventory(userId: string) {
  const entries = await prisma.inventoryEntry.findMany({
    where: { userId, quantity: { gt: 0 } },
    include: { item: true },
    orderBy: { createdAt: "asc" },
  });

  return {
    items: entries.map((entry) => ({
      sku: entry.item.sku,
      name: entry.item.name,
      type: entry.item.type,
      slot: readRules(entry.item.metadata).slot,
      quantity: entry.quantity,
      equipped: entry.equipped,
    })),
  };
}

export async function purchaseItem(userId: string, sku: string) {
  const item = await findItem(sku);
  const rules = readRules(item.metadata);

  if (rules.gemPrice === null) {
    throw new AppError("ITEM_NOT_FOR_SALE", "This item is not for sale.", 409);
  }

  const existing = await prisma.inventoryEntry.findUnique({
    where: { userId_itemId: { userId, itemId: item.id } },
  });

  if (existing && existing.quantity > 0) {
    throw new AppError(
      "ITEM_ALREADY_OWNED",
      "You already own this item.",
      409,
    );
  }

  // Throws INSUFFICIENT_FUNDS (and changes nothing) if gems are short.
  await debitWallet({
    userId,
    currency: "GEM",
    source: "PURCHASE",
    amount: rules.gemPrice,
    idempotencyKey: `shop:${userId}:${item.sku}`,
    description: `Shop: ${item.sku}`,
  });

  try {
    await prisma.inventoryEntry.upsert({
      where: { userId_itemId: { userId, itemId: item.id } },
      create: { userId, itemId: item.id, quantity: 1 },
      update: { quantity: 1 },
    });
  } catch (error) {
    // A parallel request created the same entry. That is the goal.
    if (!hasErrorCode(error, "P2002")) {
      throw error;
    }
  }

  return {
    sku: item.sku,
    gemPrice: rules.gemPrice,
    balances: await getWalletBalances(userId),
  };
}

export async function equipItem(userId: string, sku: string) {
  const item = await findItem(sku);
  const { slot } = readRules(item.metadata);

  if (slot === null) {
    throw new AppError(
      "ITEM_NOT_EQUIPPABLE",
      "This item cannot be equipped.",
      409,
    );
  }

  const entry = await prisma.inventoryEntry.findUnique({
    where: { userId_itemId: { userId, itemId: item.id } },
  });

  if (!entry || entry.quantity <= 0) {
    throw new AppError("ITEM_NOT_OWNED", "You do not own this item.", 403);
  }

  await prisma.$transaction(async (tx) => {
    // Items in the same slot, found from their metadata.
    const sameSlot = (
      await tx.inventoryItem.findMany({
        where: { type: item.type },
        select: { id: true, metadata: true },
      })
    )
      .filter((other) => readRules(other.metadata).slot === slot)
      .map((other) => other.id);

    await tx.inventoryEntry.updateMany({
      where: { userId, itemId: { in: sameSlot }, equipped: true },
      data: { equipped: false },
    });

    await tx.inventoryEntry.update({
      where: { id: entry.id },
      data: { equipped: true },
    });
  });

  return { sku: item.sku, slot, equipped: true };
}

export async function unequipSlot(userId: string, slot: string) {
  if (!SLOT_PATTERN.test(slot)) {
    throw new AppError("VALIDATION_ERROR", "Invalid slot.", 400);
  }

  const entries = await prisma.inventoryEntry.findMany({
    where: { userId, equipped: true },
    include: { item: true },
  });

  const ids = entries
    .filter((entry) => readRules(entry.item.metadata).slot === slot)
    .map((entry) => entry.id);

  if (ids.length > 0) {
    await prisma.inventoryEntry.updateMany({
      where: { id: { in: ids } },
      data: { equipped: false },
    });
  }

  return { slot, unequipped: ids.length };
}

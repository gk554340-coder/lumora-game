import { prisma } from "../../config/prisma.js";

/**
 * Default gem packs. They are created in the database on first use and
 * the database is the source of truth afterwards. The price here is
 * only a reference: the real price the player pays is set in Google
 * Play Console under the same product id (sku).
 */

export interface DefaultProduct {
  sku: string;
  name: string;
  currency: string;
  priceMinorUnit: number;
  gemAmount: number;
}

export const DEFAULT_PRODUCTS: readonly DefaultProduct[] = [
  {
    sku: "lumora_gems_60",
    name: "Handful of Gems",
    currency: "INR",
    priceMinorUnit: 4900,
    gemAmount: 60,
  },
  {
    sku: "lumora_gems_150",
    name: "Pouch of Gems",
    currency: "INR",
    priceMinorUnit: 9900,
    gemAmount: 150,
  },
  {
    sku: "lumora_gems_400",
    name: "Chest of Gems",
    currency: "INR",
    priceMinorUnit: 24900,
    gemAmount: 400,
  },
  {
    sku: "lumora_gems_1000",
    name: "Vault of Gems",
    currency: "INR",
    priceMinorUnit: 49900,
    gemAmount: 1000,
  },
];

export async function ensureDefaultProducts(): Promise<void> {
  await prisma.purchaseProduct.createMany({
    data: DEFAULT_PRODUCTS.map((product) => ({ ...product })),
    skipDuplicates: true,
  });
}

import { prisma } from "../../config/prisma.js";

/**
 * Default shop items. They are created in the database on first use
 * and the database is the source of truth afterwards, so prices and
 * availability can change without a new release.
 *
 * All default items are cosmetic: they change how the game looks and
 * never how it plays. The price is in gems and lives in the item's
 * metadata, together with the slot it is equipped into. Only one item
 * per slot can be equipped at a time.
 */

export interface DefaultItem {
  sku: string;
  name: string;
  description: string;
  slot: "light_color" | "board_theme";
  gemPrice: number;
}

export const DEFAULT_ITEMS: readonly DefaultItem[] = [
  {
    sku: "light_aurora_gold",
    name: "Aurora Gold",
    description: "A warm golden beam.",
    slot: "light_color",
    gemPrice: 40,
  },
  {
    sku: "light_ruby_flare",
    name: "Ruby Flare",
    description: "A deep red beam with a bright core.",
    slot: "light_color",
    gemPrice: 60,
  },
  {
    sku: "light_emerald_pulse",
    name: "Emerald Pulse",
    description: "A cool green beam.",
    slot: "light_color",
    gemPrice: 60,
  },
  {
    sku: "board_midnight",
    name: "Midnight Board",
    description: "A dark board that makes light stand out.",
    slot: "board_theme",
    gemPrice: 80,
  },
  {
    sku: "board_dawn",
    name: "Dawn Board",
    description: "A soft board in sunrise colors.",
    slot: "board_theme",
    gemPrice: 80,
  },
];

export async function ensureDefaultItems(): Promise<void> {
  await prisma.inventoryItem.createMany({
    data: DEFAULT_ITEMS.map((item) => ({
      sku: item.sku,
      name: item.name,
      description: item.description,
      type: "COSMETIC" as const,
      metadata: { gemPrice: item.gemPrice, slot: item.slot },
    })),
    skipDuplicates: true,
  });
}

import { loadGooglePlayConfig } from "../config/google-play.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "../config/prisma.js";
import { GooglePlayClient } from "../modules/payments/google-play.client.js";
import { syncVoidedPurchases } from "../modules/payments/refund.service.js";

/**
 * Takes back gems for purchases that Google refunded or charged back.
 * Run it on a schedule (once a day is enough):
 *
 *   node dist/scripts/sync-voided-purchases.js
 *
 * Optional: VOIDED_PURCHASES_LOOKBACK_DAYS (1 to 30, default 28).
 * Safe to run any number of times.
 */

async function main(): Promise<void> {
  const config = loadGooglePlayConfig();

  if (!config) {
    throw new Error("Google Play is not configured.");
  }

  const rawDays = process.env.VOIDED_PURCHASES_LOOKBACK_DAYS?.trim();
  let lookbackDays: number | undefined;

  if (rawDays) {
    lookbackDays = Number(rawDays);

    if (!Number.isInteger(lookbackDays)) {
      throw new Error(
        "Invalid VOIDED_PURCHASES_LOOKBACK_DAYS. Expected an integer.",
      );
    }
  }

  await connectDatabase();

  try {
    const summary = await syncVoidedPurchases(
      new GooglePlayClient(config),
      { lookbackDays },
    );

    console.log(JSON.stringify({ event: "voided-sync", ...summary }));
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "voided-sync-failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  process.exitCode = 1;
});

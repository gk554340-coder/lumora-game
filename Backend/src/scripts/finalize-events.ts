import {
  connectDatabase,
  disconnectDatabase,
} from "../config/prisma.js";
import { finalizeEndedEvents } from "../modules/events/event.service.js";

/**
 * Pays the rewards of events that have ended and closes them.
 * Run it on a schedule (once an hour is enough):
 *
 *   node dist/scripts/finalize-events.js
 *
 * Safe to run any number of times. Exits with code 1 if any reward
 * could not be paid, so the schedule can alert; the next run retries.
 */

async function main(): Promise<void> {
  await connectDatabase();

  try {
    const results = await finalizeEndedEvents();
    const failed = results.reduce((sum, item) => sum + item.failed, 0);

    console.log(
      JSON.stringify({
        event: "events-finalized",
        events: results.length,
        rewarded: results.reduce((sum, item) => sum + item.rewarded, 0),
        failed,
      }),
    );

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "events-finalize-failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  process.exitCode = 1;
});

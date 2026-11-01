import {
  connectDatabase,
  disconnectDatabase,
} from "../config/prisma.js";
import { purgeReadNotifications } from "../modules/notifications/notification.service.js";

/**
 * Deletes notifications that players have already read and that are
 * older than the retention period, so the table stays small.
 * Unread notifications are never deleted. Run it on a schedule
 * (once a day is enough):
 *
 *   node dist/scripts/purge-notifications.js
 *
 * Optional: NOTIFICATION_RETENTION_DAYS (1 to 3650, default 90).
 * Safe to run any number of times.
 */

const DEFAULT_RETENTION_DAYS = 90;

function readRetentionDays(): number {
  const raw = process.env.NOTIFICATION_RETENTION_DAYS?.trim();

  if (!raw) {
    return DEFAULT_RETENTION_DAYS;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error(
      "Invalid NOTIFICATION_RETENTION_DAYS. Expected an integer between 1 and 3650.",
    );
  }

  return value;
}

async function main(): Promise<void> {
  const retentionDays = readRetentionDays();

  await connectDatabase();

  try {
    const deleted = await purgeReadNotifications(retentionDays);

    console.log(
      JSON.stringify({
        event: "notifications-purged",
        retentionDays,
        deleted,
      }),
    );
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "notifications-purge-failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  process.exitCode = 1;
});

import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import { grantReward } from "../rewards/reward.service.js";
import {
  EVENT_REWARD_DEFAULTS,
  EVENT_REWARD_TIERS,
  WEEKLY_EVENT_KIND,
  WEEKLY_EVENT_NAME,
  rewardCodeForRank,
  weeklyWindow,
} from "./event.catalog.js";

/**
 * Weekly events.
 *
 * Standings are computed from verified play (PlayerProgress and
 * LevelAttempt), never from numbers sent by the app. See event.catalog
 * for the scoring rule. Ranking is: higher score first, then whoever
 * reached it earlier, then user id, so the order is always the same.
 *
 * Only ACTIVE accounts are ranked and rewarded.
 *
 * At large scale, replace the live query with totals kept up to date
 * when a level is completed.
 */

export const DEFAULT_EVENT_LEADERBOARD_LIMIT = 20;
export const MAX_EVENT_LEADERBOARD_LIMIT = 100;

const FINALIZE_BATCH_SIZE = 500;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StandingRow {
  userId: string;
  total: number;
  levels: number;
  rank: number;
}

export interface FinalizeSummary {
  eventId: string;
  alreadyFinalized: boolean;
  rewarded: number;
  failed: number;
}

async function queryStandings(
  start: Date,
  end: Date,
  afterRank: number,
  limit: number,
  me: string | null,
): Promise<StandingRow[]> {
  const from = start.toISOString();
  const to = end.toISOString();

  return prisma.$queryRaw<StandingRow[]>`
    WITH firsts AS (
      SELECT "userId", "levelId"
      FROM "PlayerProgress"
      WHERE completed = true
        AND "firstCompletedAt" >= ${from}::timestamp
        AND "firstCompletedAt" < ${to}::timestamp
    ),
    best AS (
      SELECT la."userId", la."levelId",
             MAX(la.score) AS best,
             MAX(la."completedAt") AS at
      FROM "LevelAttempt" la
      JOIN firsts f
        ON f."userId" = la."userId" AND f."levelId" = la."levelId"
      WHERE la.status = 'COMPLETED'
        AND la.score IS NOT NULL
        AND la."completedAt" >= ${from}::timestamp
        AND la."completedAt" < ${to}::timestamp
      GROUP BY la."userId", la."levelId"
    ),
    totals AS (
      SELECT b."userId",
             SUM(b.best)::int AS total,
             COUNT(*)::int AS levels,
             MAX(b.at) AS last_at
      FROM best b
      JOIN "User" u ON u.id = b."userId" AND u.status = 'ACTIVE'
      GROUP BY b."userId"
    ),
    ranked AS (
      SELECT "userId", total, levels,
             ROW_NUMBER() OVER (
               ORDER BY total DESC, last_at ASC, "userId" ASC
             )::int AS rank
      FROM totals
    )
    SELECT "userId"::text AS "userId", total, levels, rank
    FROM ranked
    WHERE (rank > ${afterRank}::int AND rank <= ${afterRank + limit}::int)
       OR "userId" = ${me}::uuid
    ORDER BY rank
  `;
}

async function displayNames(
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      username: true,
      profile: { select: { displayName: true } },
    },
  });

  return new Map(
    users.map((user) => [
      user.id,
      user.profile?.displayName?.trim() ||
        user.username ||
        `Player ${user.id.slice(0, 6)}`,
    ]),
  );
}

/**
 * Finds this week's event, or creates it. The lock makes sure that
 * parallel requests create it only once.
 */
export async function ensureCurrentEvent(now: Date = new Date()) {
  const window = weeklyWindow(now);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('lumora:events:weekly'))`;

    const existing = await tx.gameEvent.findFirst({
      where: {
        configuration: { path: ["key"], equals: window.key },
      },
    });

    if (existing) {
      return existing;
    }

    return tx.gameEvent.create({
      data: {
        name: WEEKLY_EVENT_NAME,
        description:
          "Complete new levels this week. The best scores win rewards.",
        status: "ACTIVE",
        startsAt: window.start,
        endsAt: window.end,
        configuration: { kind: WEEKLY_EVENT_KIND, key: window.key },
      },
    });
  });
}

function rewardTable() {
  return EVENT_REWARD_TIERS.map((tier) => {
    const definition = EVENT_REWARD_DEFAULTS.find(
      (entry) => entry.code === tier.code,
    );
    const currencies =
      definition && "currencies" in definition.configuration
        ? definition.configuration.currencies
        : [];

    return {
      fromRank: tier.fromRank,
      toRank: tier.toRank,
      rewards: currencies,
    };
  });
}

export async function getCurrentEvent(
  userId: string,
  now: Date = new Date(),
) {
  const event = await ensureCurrentEvent(now);
  const mine = (
    await queryStandings(event.startsAt, event.endsAt, 0, 0, userId)
  )[0];

  return {
    event: {
      id: event.id,
      name: event.name,
      description: event.description,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      secondsLeft: Math.max(
        0,
        Math.ceil((event.endsAt.getTime() - now.getTime()) / 1000),
      ),
    },
    rewardTable: rewardTable(),
    me: mine
      ? { rank: mine.rank, score: mine.total, levels: mine.levels }
      : null,
  };
}

export async function getEventLeaderboard(
  userId: string,
  eventId: string,
  limit: number = DEFAULT_EVENT_LEADERBOARD_LIMIT,
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_EVENT_LEADERBOARD_LIMIT
  ) {
    throw new AppError(
      "INVALID_LIMIT",
      `The limit must be between 1 and ${MAX_EVENT_LEADERBOARD_LIMIT}.`,
      400,
    );
  }

  if (!UUID_PATTERN.test(eventId)) {
    throw new AppError("EVENT_NOT_FOUND", "Event not found.", 404);
  }

  const event = await prisma.gameEvent.findUnique({
    where: { id: eventId },
  });

  if (!event) {
    throw new AppError("EVENT_NOT_FOUND", "Event not found.", 404);
  }

  const rows = await queryStandings(
    event.startsAt,
    event.endsAt,
    0,
    limit,
    userId,
  );
  const names = await displayNames(rows.map((row) => row.userId));

  const toEntry = (row: StandingRow) => ({
    rank: row.rank,
    displayName: names.get(row.userId) ?? "Player",
    score: row.total,
    levels: row.levels,
    isYou: row.userId === userId,
  });

  return {
    event: {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
    },
    entries: rows.filter((row) => row.rank <= limit).map(toEntry),
    me: rows.filter((row) => row.userId === userId).map(toEntry)[0] ?? null,
  };
}

/**
 * Pays the rewards of an ended event and closes it. Safe to run again:
 * every reward is granted once per player and event, and an event that
 * is already closed is skipped.
 */
export async function finalizeEvent(
  eventId: string,
  now: Date = new Date(),
): Promise<FinalizeSummary> {
  const event = await prisma.gameEvent.findUnique({
    where: { id: eventId },
  });

  if (!event) {
    throw new AppError("EVENT_NOT_FOUND", "Event not found.", 404);
  }

  if (event.status === "COMPLETED") {
    return { eventId, alreadyFinalized: true, rewarded: 0, failed: 0 };
  }

  if (event.endsAt.getTime() > now.getTime()) {
    throw new AppError(
      "EVENT_NOT_ENDED",
      "This event has not ended yet.",
      409,
    );
  }

  let rewarded = 0;
  let failed = 0;
  let afterRank = 0;

  for (;;) {
    const rows = await queryStandings(
      event.startsAt,
      event.endsAt,
      afterRank,
      FINALIZE_BATCH_SIZE,
      null,
    );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      try {
        await grantReward({
          userId: row.userId,
          rewardCode: rewardCodeForRank(row.rank),
          sourceId: `event:${event.id}`,
          sourceType: "EVENT",
        });
        rewarded += 1;
      } catch {
        failed += 1;
      }
    }

    afterRank = rows[rows.length - 1]?.rank ?? afterRank;
  }

  // The event is only closed when everybody was paid. Otherwise the
  // next run pays the rest.
  if (failed === 0) {
    await prisma.gameEvent.updateMany({
      where: { id: event.id, status: { not: "COMPLETED" } },
      data: { status: "COMPLETED" },
    });
  }

  return { eventId, alreadyFinalized: false, rewarded, failed };
}

export async function finalizeEndedEvents(
  now: Date = new Date(),
): Promise<FinalizeSummary[]> {
  const ended = await prisma.gameEvent.findMany({
    where: {
      status: { in: ["SCHEDULED", "ACTIVE"] },
      endsAt: { lte: now },
    },
    orderBy: { endsAt: "asc" },
    select: { id: true },
  });

  const results: FinalizeSummary[] = [];

  for (const event of ended) {
    results.push(await finalizeEvent(event.id, now));
  }

  return results;
}

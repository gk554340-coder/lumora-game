import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import {
  EVENT_REWARD_CODES,
  rewardCodeForRank,
  weeklyWindow,
} from "../src/modules/events/event.catalog.js";
import {
  ensureCurrentEvent,
  finalizeEndedEvents,
  finalizeEvent,
  getCurrentEvent,
  getEventLeaderboard,
} from "../src/modules/events/event.service.js";
import { getOrCreateLevel } from "../src/modules/levels/level.service.js";
import { getWalletBalances } from "../src/modules/wallet/wallet.service.js";
import {
  bearer,
  expectAppError,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

const HOUR = 3_600_000;

// Every test uses its own week far in the future, so the data of other
// test files can never fall into these windows.
function weekOf(year: number, month: number, day: number) {
  return weeklyWindow(new Date(Date.UTC(year, month - 1, day, 12)));
}

describe("weekly window and rank rewards", () => {
  it("runs from Monday to Monday in UTC", () => {
    const wednesday = weeklyWindow(new Date("2031-03-12T10:00:00Z"));
    assert.equal(wednesday.start.toISOString(), "2031-03-10T00:00:00.000Z");
    assert.equal(wednesday.end.toISOString(), "2031-03-17T00:00:00.000Z");
    assert.equal(wednesday.key, "weekly:2031-03-10");

    const mondayStart = weeklyWindow(new Date("2031-03-10T00:00:00Z"));
    assert.equal(mondayStart.start.toISOString(), "2031-03-10T00:00:00.000Z");

    const sundayEnd = weeklyWindow(new Date("2031-03-16T23:59:59Z"));
    assert.equal(sundayEnd.start.toISOString(), "2031-03-10T00:00:00.000Z");

    const nextMonday = weeklyWindow(new Date("2031-03-17T00:00:00Z"));
    assert.equal(nextMonday.start.toISOString(), "2031-03-17T00:00:00.000Z");
  });

  it("maps ranks to reward tiers", () => {
    const expected: Array<[number, string]> = [
      [1, EVENT_REWARD_CODES.RANK_1],
      [2, EVENT_REWARD_CODES.TOP_3],
      [3, EVENT_REWARD_CODES.TOP_3],
      [4, EVENT_REWARD_CODES.TOP_10],
      [10, EVENT_REWARD_CODES.TOP_10],
      [11, EVENT_REWARD_CODES.TOP_100],
      [100, EVENT_REWARD_CODES.TOP_100],
      [101, EVENT_REWARD_CODES.PARTICIPANT],
      [50_000, EVENT_REWARD_CODES.PARTICIPANT],
    ];

    for (const [rank, code] of expected) {
      assert.equal(rewardCodeForRank(rank), code, `rank ${rank}`);
    }
  });
});

describe("weekly events", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  async function play(
    userId: string,
    levelNumber: number,
    score: number,
    at: Date,
    firstAt: Date = at,
  ): Promise<void> {
    const level = await getOrCreateLevel(levelNumber);

    await prisma.playerProgress.upsert({
      where: { userId_levelId: { userId, levelId: level.id } },
      create: {
        userId,
        levelId: level.id,
        completed: true,
        stars: 3,
        bestScore: score,
        firstCompletedAt: firstAt,
      },
      update: {},
    });

    await prisma.levelAttempt.create({
      data: {
        userId,
        levelId: level.id,
        attemptNumber: 1,
        status: "COMPLETED",
        score,
        completedAt: at,
      },
    });
  }

  it("creates the weekly event once, even in parallel", async () => {
    const window = weekOf(2031, 4, 2);
    const now = new Date(window.start.getTime() + HOUR);

    const events = await Promise.all(
      Array.from({ length: 6 }, () => ensureCurrentEvent(now)),
    );

    assert.equal(new Set(events.map((event) => event.id)).size, 1);
    assert.equal(events[0]?.startsAt.toISOString(), window.start.toISOString());
    assert.equal(events[0]?.endsAt.toISOString(), window.end.toISOString());
    assert.equal(events[0]?.status, "ACTIVE");

    const stored = await prisma.gameEvent.count({
      where: { configuration: { path: ["key"], equals: window.key } },
    });
    assert.equal(stored, 1);
  });

  it("ranks players by score from levels first completed this week", async () => {
    const window = weekOf(2031, 5, 7);
    const now = new Date(window.start.getTime() + 2 * HOUR);
    const event = await ensureCurrentEvent(now);
    const at = (hours: number) =>
      new Date(window.start.getTime() + hours * HOUR);

    const [a, b, tie, late, veteran, suspended, idle] = await Promise.all(
      Array.from({ length: 7 }, () => registerTestUser(app)),
    );
    assert.ok(a && b && tie && late && veteran && suspended && idle);

    // a: 100 + 80 = 180 over two levels
    await play(a.userId, 1, 100, at(1));
    await play(a.userId, 2, 80, at(2));
    // a replays level 1 with a better score: the best one counts
    await prisma.levelAttempt.create({
      data: {
        userId: a.userId,
        levelId: (await getOrCreateLevel(1)).id,
        attemptNumber: 2,
        status: "COMPLETED",
        score: 120,
        completedAt: at(3),
      },
    });
    // a is now 120 + 80 = 200

    // b and tie both reach 150; b got there first
    await play(b.userId, 1, 150, at(4));
    await play(tie.userId, 1, 150, at(5));

    // late scored in the week but the level was first completed earlier
    await play(veteran.userId, 1, 500, at(6), at(-48));

    // activity after the window does not count
    await play(late.userId, 1, 400, new Date(window.end.getTime() + HOUR));

    // a suspended account is not ranked
    await prisma.user.update({
      where: { id: suspended.userId },
      data: { status: "SUSPENDED" },
    });
    await play(suspended.userId, 1, 900, at(7));

    const board = await getEventLeaderboard(a.userId, event.id, 10);

    assert.deepEqual(
      board.entries.map((entry) => [entry.rank, entry.score, entry.isYou]),
      [
        [1, 200, true],
        [2, 150, false],
        [3, 150, false],
      ],
    );
    assert.equal(board.me?.rank, 1);
    assert.equal(board.me?.levels, 2);

    // A player outside the shown entries still sees their own rank.
    const small = await getEventLeaderboard(tie.userId, event.id, 1);
    assert.equal(small.entries.length, 1);
    assert.equal(small.me?.rank, 3);

    const nobody = await getEventLeaderboard(idle.userId, event.id, 5);
    assert.equal(nobody.me, null);

    const current = await getCurrentEvent(b.userId, now);
    assert.equal(current.event.id, event.id);
    assert.equal(current.me?.rank, 2);
    assert.equal(current.rewardTable.length, 5);
  });

  it("pays each player once by rank and closes the event", async () => {
    const window = weekOf(2031, 6, 11);
    const during = new Date(window.start.getTime() + HOUR);
    const event = await ensureCurrentEvent(during);

    const players = await Promise.all(
      Array.from({ length: 5 }, () => registerTestUser(app)),
    );

    // scores 500, 400, 300, 200, 100 give ranks 1 to 5
    for (const [index, player] of players.entries()) {
      await play(
        player.userId,
        1,
        500 - index * 100,
        new Date(window.start.getTime() + (index + 1) * HOUR),
      );
    }

    await expectAppError(
      finalizeEvent(event.id, during),
      "EVENT_NOT_ENDED",
    );

    const after = new Date(window.end.getTime() + HOUR);
    const summary = await finalizeEvent(event.id, after);

    assert.equal(summary.alreadyFinalized, false);
    assert.equal(summary.rewarded, 5);
    assert.equal(summary.failed, 0);

    const balances = await Promise.all(
      players.map((player) => getWalletBalances(player.userId)),
    );

    // rank 1, ranks 2-3, ranks 4-5
    assert.deepEqual(
      balances.map((item) => [item.gemBalance, item.tokenBalance]),
      [
        [50, 300],
        [30, 200],
        [30, 200],
        [15, 150],
        [15, 150],
      ],
    );

    const closed = await prisma.gameEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    assert.equal(closed.status, "COMPLETED");

    // Running again changes nothing.
    const again = await finalizeEvent(event.id, after);
    assert.equal(again.alreadyFinalized, true);

    const same = await Promise.all(
      players.map((player) => getWalletBalances(player.userId)),
    );
    assert.deepEqual(same, balances);
  });

  it("finishes the rewards when a run was interrupted", async () => {
    const window = weekOf(2031, 7, 9);
    const during = new Date(window.start.getTime() + HOUR);
    const event = await ensureCurrentEvent(during);

    const [first, second] = await Promise.all([
      registerTestUser(app),
      registerTestUser(app),
    ]);
    assert.ok(first && second);

    await play(first.userId, 1, 300, new Date(window.start.getTime() + HOUR));
    await play(second.userId, 1, 200, new Date(window.start.getTime() + HOUR));

    const after = new Date(window.end.getTime() + HOUR);

    // Run the whole thing twice in parallel, as two schedulers might.
    const results = await Promise.all([
      finalizeEvent(event.id, after),
      finalizeEvent(event.id, after),
    ]);
    assert.ok(results.every((result) => result.failed === 0));

    assert.equal((await getWalletBalances(first.userId)).gemBalance, 50);
    assert.equal((await getWalletBalances(second.userId)).gemBalance, 30);
  });

  it("closes every ended event in one run", async () => {
    const window = weekOf(2031, 8, 13);
    const event = await ensureCurrentEvent(
      new Date(window.start.getTime() + HOUR),
    );

    const results = await finalizeEndedEvents(
      new Date(window.end.getTime() + HOUR),
    );

    assert.ok(results.some((result) => result.eventId === event.id));

    const closed = await prisma.gameEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    assert.equal(closed.status, "COMPLETED");
  });

  it("works over HTTP and requires login", async () => {
    const user = await registerTestUser(app);

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/events/current",
    });
    assert.equal(anonymous.statusCode, 401);

    const current = await app.inject({
      method: "GET",
      url: "/api/events/current",
      headers: bearer(user.token),
    });
    assert.equal(current.statusCode, 200);

    const data = current.json().data;
    assert.equal(data.event.name, "Weekly Light Rush");
    assert.ok(data.event.secondsLeft > 0);
    assert.equal(data.me, null);
    assert.equal(data.rewardTable[0].fromRank, 1);

    const board = await app.inject({
      method: "GET",
      url: `/api/events/${data.event.id}/leaderboard`,
      headers: bearer(user.token),
    });
    assert.equal(board.statusCode, 200);
    assert.ok(Array.isArray(board.json().data.entries));

    const missing = await app.inject({
      method: "GET",
      url: "/api/events/not-a-uuid/leaderboard",
      headers: bearer(user.token),
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "EVENT_NOT_FOUND");

    const badLimit = await app.inject({
      method: "GET",
      url: `/api/events/${data.event.id}/leaderboard?limit=1000`,
      headers: bearer(user.token),
    });
    assert.equal(badLimit.statusCode, 400);
    assert.equal(badLimit.json().error.code, "INVALID_LIMIT");
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import {
  getOrCreateLevel,
  startLevel,
  submitAttempt,
} from "../src/modules/levels/level.service.js";
import {
  getGlobalLeaderboard,
  getLevelLeaderboard,
} from "../src/modules/leaderboards/leaderboard.service.js";
import {
  parseLevelConfiguration,
  starsFor,
} from "../src/modules/levels/lumen-engine.js";
import {
  bearer,
  expectAppError,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

// Level 3 is used only by this file, so its board holds only the
// players created here.
const BOARD_LEVEL = 3;

async function solution(levelNumber: number) {
  const level = await getOrCreateLevel(levelNumber);
  const configuration = parseLevelConfiguration(level.configuration);

  assert.ok(configuration);

  return configuration;
}

async function wasteful(levelNumber: number): Promise<number[]> {
  const { solution: flips, parMoves } = await solution(levelNumber);
  const moves = [...flips];

  while (starsFor(moves.length, parMoves) > 1) {
    moves.push(flips[0], flips[0]);
  }

  return moves;
}

async function completeBefore(userId: string, last: number): Promise<void> {
  const levelIds: string[] = [];

  for (let number = 1; number < last; number += 1) {
    levelIds.push((await getOrCreateLevel(number)).id);
  }

  await prisma.playerProgress.createMany({
    data: levelIds.map((levelId) => ({
      userId,
      levelId,
      completed: true,
      stars: 3,
    })),
  });
}

async function play(
  userId: string,
  levelNumber: number,
  moves: number[],
  takesMs: number,
) {
  const started = await startLevel(userId, levelNumber);

  return submitAttempt(
    userId,
    started.attemptId,
    moves,
    new Date(Date.now() + takesMs),
  );
}

async function nameUser(userId: string, prefix: string): Promise<string> {
  const displayName = `${prefix}-${randomUUID().slice(0, 8)}`;

  await prisma.playerProfile.update({
    where: { userId },
    data: { displayName },
  });

  return displayName;
}

describe("leaderboards", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  it("ranks a level by score, then by time", async () => {
    const fast = await registerTestUser(app);
    const slow = await registerTestUser(app);
    const poor = await registerTestUser(app);
    const nameless = await registerTestUser(app);

    const fastName = await nameUser(fast.userId, "fast");
    const slowName = await nameUser(slow.userId, "slow");
    const poorName = await nameUser(poor.userId, "poor");

    for (const user of [fast, slow, poor, nameless]) {
      await completeBefore(user.userId, BOARD_LEVEL);
    }

    const { solution: flips } = await solution(BOARD_LEVEL);

    await play(slow.userId, BOARD_LEVEL, flips, 120_000);
    await play(fast.userId, BOARD_LEVEL, flips, 60_000);
    await play(poor.userId, BOARD_LEVEL, await wasteful(BOARD_LEVEL), 60_000);
    await play(nameless.userId, BOARD_LEVEL, flips, 300_000);

    const board = await getLevelLeaderboard(fast.userId, BOARD_LEVEL, 100);

    const names = board.entries.map((entry) => entry.displayName);
    const rankOf = (name: string) => names.indexOf(name);

    assert.ok(rankOf(fastName) >= 0 && rankOf(slowName) >= 0);
    assert.ok(rankOf(fastName) < rankOf(slowName), "faster wins a tie on score");
    assert.ok(rankOf(slowName) < rankOf(poorName), "more stars beat fewer");

    const namelessEntry = board.entries.find((entry) =>
      entry.displayName.startsWith(`Player ${nameless.userId.slice(0, 6)}`),
    );
    assert.ok(namelessEntry, "a player without a name gets a neutral name");

    board.entries.forEach((entry, index) => {
      assert.equal(entry.rank, index + 1);
    });

    for (let i = 1; i < board.entries.length; i += 1) {
      const before = board.entries[i - 1];
      const entry = board.entries[i];

      assert.ok(before.score >= entry.score);
    }

    assert.equal(board.entries.filter((entry) => entry.isYou).length, 1);
    assert.equal(board.you?.rank, board.entries.find((e) => e.isYou)?.rank);
    assert.equal(board.you?.stars, 3);

    const poorView = await getLevelLeaderboard(poor.userId, BOARD_LEVEL, 1);

    assert.equal(poorView.entries.length, 1);
    assert.equal(poorView.entries.some((entry) => entry.isYou), false);
    assert.equal(poorView.you?.stars, 1);
    assert.ok((poorView.you?.rank ?? 0) > 1, "own rank is found outside the top");

    const expected =
      board.entries.findIndex((entry) => entry.displayName === poorName) + 1;
    assert.equal(poorView.you?.rank, expected);
  });

  it("shows no personal result to a player who has not finished the level", async () => {
    const newcomer = await registerTestUser(app);
    const board = await getLevelLeaderboard(newcomer.userId, BOARD_LEVEL, 5);

    assert.equal(board.you, null);
    assert.ok(board.entries.length <= 5);
  });

  it("refuses an unknown level or a bad limit", async () => {
    const { userId } = await registerTestUser(app);

    await expectAppError(
      getLevelLeaderboard(userId, 999_999, 10),
      "LEVEL_NOT_FOUND",
    );
    await expectAppError(getLevelLeaderboard(userId, 0, 10), "INVALID_LEVEL");
    await expectAppError(getLevelLeaderboard(userId, 1, 0), "INVALID_LIMIT");
    await expectAppError(getLevelLeaderboard(userId, 1, 101), "INVALID_LIMIT");
    await expectAppError(getGlobalLeaderboard(userId, 1.5), "INVALID_LIMIT");
  });

  it("ranks the global board by total stars", async () => {
    const climber = await registerTestUser(app);
    const idle = await registerTestUser(app);

    await play(climber.userId, 1, (await solution(1)).solution, 60_000);
    await play(climber.userId, 2, (await solution(2)).solution, 60_000);

    const board = await getGlobalLeaderboard(climber.userId, 100);

    for (let i = 1; i < board.entries.length; i += 1) {
      assert.ok(
        board.entries[i - 1].totalStars >= board.entries[i].totalStars,
      );
    }

    board.entries.forEach((entry, index) => {
      assert.equal(entry.rank, index + 1);
    });

    assert.equal(board.you?.totalStars, 6);
    assert.equal(board.you?.completedLevels, 2);

    // The reported rank must match an independent count over all players.
    const everyone = await prisma.playerProgress.groupBy({
      by: ["userId"],
      where: { completed: true },
      _sum: { stars: true },
    });

    const ordered = everyone
      .map((row) => ({ userId: row.userId, stars: row._sum.stars ?? 0 }))
      .sort((a, b) =>
        b.stars !== a.stars
          ? b.stars - a.stars
          : a.userId < b.userId
            ? -1
            : 1,
      );

    const expected =
      ordered.findIndex((row) => row.userId === climber.userId) + 1;

    assert.equal(board.you?.rank, expected);

    const idleView = await getGlobalLeaderboard(idle.userId, 5);

    assert.equal(idleView.you, null);
    assert.ok(idleView.entries.length <= 5);
  });

  it("works over HTTP, requires sign in and hides ids and e-mail", async () => {
    const user = await registerTestUser(app);
    await play(user.userId, 1, (await solution(1)).solution, 60_000);

    for (const url of [
      "/api/leaderboards/global",
      `/api/leaderboards/levels/${BOARD_LEVEL}`,
    ]) {
      const anonymous = await app.inject({ method: "GET", url });

      assert.equal(anonymous.statusCode, 401, url);
    }

    const global = await app.inject({
      method: "GET",
      url: "/api/leaderboards/global?limit=10",
      headers: bearer(user.token),
    });

    assert.equal(global.statusCode, 200);
    assert.ok(global.json().data.entries.length <= 10);
    assert.equal(global.body.includes(user.email), false);
    assert.equal(global.body.includes(user.userId), false);

    const level = await app.inject({
      method: "GET",
      url: "/api/leaderboards/levels/1",
      headers: bearer(user.token),
    });

    assert.equal(level.statusCode, 200);
    assert.equal(level.json().data.levelNumber, 1);
    assert.equal(level.body.includes(user.userId), false);

    for (const url of [
      "/api/leaderboards/global?limit=0",
      "/api/leaderboards/global?limit=101",
      "/api/leaderboards/global?limit=abc",
      "/api/leaderboards/levels/abc",
    ]) {
      const bad = await app.inject({
        method: "GET",
        url,
        headers: bearer(user.token),
      });

      assert.equal(bad.statusCode, 400, url);
    }

    const missing = await app.inject({
      method: "GET",
      url: "/api/leaderboards/levels/999999",
      headers: bearer(user.token),
    });

    assert.equal(missing.statusCode, 404);
  });
});

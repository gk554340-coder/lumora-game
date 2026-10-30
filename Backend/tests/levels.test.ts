import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import {
  MAX_ATTEMPT_AGE_MS,
  getLevelProgress,
  getOrCreateLevel,
  startLevel,
  submitAttempt,
} from "../src/modules/levels/level.service.js";
import {
  parseLevelConfiguration,
  starsFor,
} from "../src/modules/levels/lumen-engine.js";
import {
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

async function levelSolution(levelNumber: number) {
  const level = await getOrCreateLevel(levelNumber);
  const configuration = parseLevelConfiguration(level.configuration);

  assert.ok(configuration);

  return configuration;
}

// The stored solution plus pairs of repeated flips, which cancel out but
// count as moves, until the result is worth only one star.
async function wastefulMoves(levelNumber: number): Promise<number[]> {
  const { solution, parMoves } = await levelSolution(levelNumber);
  const moves = [...solution];

  while (starsFor(moves.length, parMoves) > 1) {
    moves.push(solution[0], solution[0]);
  }

  return moves;
}

function soon(ms: number): Date {
  return new Date(Date.now() + ms);
}

// Starts a level and submits as if the player took a minute.
async function play(userId: string, levelNumber: number, moves: number[]) {
  const started = await startLevel(userId, levelNumber);

  return submitAttempt(userId, started.attemptId, moves, soon(60_000));
}

// Marks every level below `last` as completed so the next one opens.
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

describe("levels", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  it("starts level 1 and never reveals the solution", async () => {
    const { userId } = await registerTestUser(app);
    const started = await startLevel(userId, 1);

    assert.equal(started.level.levelNumber, 1);
    assert.equal(started.bestStars, 0);
    assert.equal(started.level.tiles.length, started.level.width * started.level.height);
    assert.ok(started.level.parMoves >= 2);
    assert.equal("solution" in started.level, false);
    assert.equal(JSON.stringify(started).includes("solution"), false);

    const stored = await prisma.gameLevel.findUniqueOrThrow({
      where: { levelNumber: 1 },
    });

    assert.equal(stored.status, "ACTIVE");
    assert.equal(stored.difficultyTier, 1);
    assert.equal(stored.generationSeed, "lumen:v1:1");
  });

  it("stores each level once, even when requested in parallel", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => getOrCreateLevel(77)),
    );

    assert.equal(new Set(results.map((level) => level.id)).size, 1);
    assert.equal(await prisma.gameLevel.count({ where: { levelNumber: 77 } }), 1);
  });

  it("keeps levels locked until the earlier ones are complete", async () => {
    const { userId } = await registerTestUser(app);

    await expectAppError(startLevel(userId, 2), "LEVEL_LOCKED");
    await expectAppError(startLevel(userId, 0), "INVALID_LEVEL");
    await expectAppError(startLevel(userId, 1.5), "INVALID_LEVEL");
    await expectAppError(startLevel(userId, 5_000_000), "INVALID_LEVEL");

    await play(userId, 1, (await levelSolution(1)).solution);

    const second = await startLevel(userId, 2);
    assert.equal(second.level.levelNumber, 2);

    await expectAppError(startLevel(userId, 3), "LEVEL_LOCKED");
  });

  it("closes the earlier attempt when a level is started again", async () => {
    const { userId } = await registerTestUser(app);
    const first = await startLevel(userId, 1);
    const second = await startLevel(userId, 1);

    const rows = await prisma.levelAttempt.findMany({
      where: { userId },
      orderBy: { attemptNumber: "asc" },
    });

    assert.deepEqual(
      rows.map((row) => [row.attemptNumber, row.status]),
      [
        [1, "ABANDONED"],
        [2, "STARTED"],
      ],
    );

    const { solution } = await levelSolution(1);

    await expectAppError(
      submitAttempt(userId, first.attemptId, solution, soon(60_000)),
      "ATTEMPT_CLOSED",
    );

    const result = await submitAttempt(
      userId,
      second.attemptId,
      solution,
      soon(60_000),
    );

    assert.equal(result.stars, 3);
  });

  it("pays 20 tokens for three stars and records the progress", async () => {
    const { userId } = await registerTestUser(app);
    const { solution, parMoves } = await levelSolution(1);

    const result = await play(userId, 1, solution);

    assert.equal(result.stars, 3);
    assert.equal(result.moves, parMoves);
    assert.equal(result.newBestStars, true);
    assert.equal(result.nextLevel, 2);
    assert.deepEqual(result.rewards, [{ currency: "TOKEN", amount: 20 }]);
    assert.ok(result.score >= 3000);

    const balances = await getWalletBalances(userId);
    assert.equal(balances.tokenBalance, 20);
    assert.equal((await reconcileWallet(userId)).consistent, true);

    const progress = await prisma.playerProgress.findFirstOrThrow({
      where: { userId },
    });

    assert.equal(progress.completed, true);
    assert.equal(progress.stars, 3);
    assert.equal(progress.attemptsCount, 1);
    assert.ok(progress.firstCompletedAt);
    assert.ok(progress.bestTimeMs && progress.bestTimeMs >= 60_000);

    assert.deepEqual(await getLevelProgress(userId), {
      nextLevel: 2,
      completedLevels: 1,
      totalStars: 3,
    });
  });

  it("pays each star once however often a level is replayed", async () => {
    const { userId } = await registerTestUser(app);
    const { solution } = await levelSolution(1);

    const poor = await play(userId, 1, await wastefulMoves(1));

    assert.equal(poor.stars, 1);
    assert.deepEqual(poor.rewards, [{ currency: "TOKEN", amount: 10 }]);

    const sameAgain = await play(userId, 1, await wastefulMoves(1));

    assert.equal(sameAgain.newBestStars, false);
    assert.deepEqual(sameAgain.rewards, []);

    const best = await play(userId, 1, solution);

    assert.equal(best.stars, 3);
    assert.equal(best.newBestStars, true);
    assert.deepEqual(best.rewards, [{ currency: "TOKEN", amount: 10 }]);

    const replay = await play(userId, 1, solution);

    assert.deepEqual(replay.rewards, []);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 20);

    const progress = await prisma.playerProgress.findFirstOrThrow({
      where: { userId },
    });

    assert.equal(progress.stars, 3);
    assert.equal(progress.attemptsCount, 4);
    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("never lowers the best result when a replay is worse", async () => {
    const { userId } = await registerTestUser(app);

    await play(userId, 1, (await levelSolution(1)).solution);
    await play(userId, 1, await wastefulMoves(1));

    const progress = await prisma.playerProgress.findFirstOrThrow({
      where: { userId },
    });

    assert.equal(progress.stars, 3);
    assert.ok(progress.bestScore >= 3000);
  });

  it("rejects submissions that are wrong, invalid, too fast or too late", async () => {
    const { userId } = await registerTestUser(app);
    const { solution, tiles } = await levelSolution(1);

    const started = await startLevel(userId, 1);
    const later = soon(60_000);

    // Flipping a tile twice leaves the board as it started.
    await expectAppError(
      submitAttempt(userId, started.attemptId, [solution[0], solution[0]], later),
      "LEVEL_NOT_SOLVED",
    );

    await expectAppError(
      submitAttempt(userId, started.attemptId, [], later),
      "MOVES_INVALID",
    );

    await expectAppError(
      submitAttempt(userId, started.attemptId, [99_999], later),
      "MOVES_INVALID",
    );

    await expectAppError(
      submitAttempt(userId, started.attemptId, [0.5], later),
      "MOVES_INVALID",
    );

    const emitter = tiles.findIndex((tile) => tile.kind === "EMITTER");

    await expectAppError(
      submitAttempt(userId, started.attemptId, [emitter], later),
      "MOVES_INVALID",
    );

    await expectAppError(
      submitAttempt(userId, started.attemptId, solution, soon(50)),
      "SUBMISSION_TOO_FAST",
    );

    await expectAppError(
      submitAttempt(
        userId,
        started.attemptId,
        solution,
        soon(MAX_ATTEMPT_AGE_MS + 60_000),
      ),
      "ATTEMPT_EXPIRED",
    );

    await expectAppError(
      submitAttempt(userId, "not-a-uuid", solution, later),
      "ATTEMPT_NOT_FOUND",
    );

    // None of the rejections closed the attempt or paid anything.
    assert.equal((await getWalletBalances(userId)).tokenBalance, 0);

    const row = await prisma.levelAttempt.findUniqueOrThrow({
      where: { id: started.attemptId },
    });
    assert.equal(row.status, "STARTED");

    const result = await submitAttempt(userId, started.attemptId, solution, later);
    assert.equal(result.stars, 3);
  });

  it("does not let one player submit another player's attempt", async () => {
    const owner = await registerTestUser(app);
    const other = await registerTestUser(app);
    const started = await startLevel(owner.userId, 1);
    const { solution } = await levelSolution(1);

    await expectAppError(
      submitAttempt(other.userId, started.attemptId, solution, soon(60_000)),
      "ATTEMPT_NOT_FOUND",
    );

    assert.equal((await getWalletBalances(other.userId)).tokenBalance, 0);
  });

  it("accepts an attempt only once and pays once for parallel submissions", async () => {
    const { userId } = await registerTestUser(app);
    const started = await startLevel(userId, 1);
    const { solution } = await levelSolution(1);
    const later = soon(60_000);

    const results = await Promise.allSettled([
      submitAttempt(userId, started.attemptId, solution, later),
      submitAttempt(userId, started.attemptId, solution, later),
      submitAttempt(userId, started.attemptId, solution, later),
    ]);

    const accepted = results.filter((entry) => entry.status === "fulfilled");
    const refused = results.filter((entry) => entry.status === "rejected");

    assert.equal(accepted.length, 1);
    assert.equal(refused.length, 2);

    for (const entry of refused) {
      assert.equal((entry.reason as { code?: string }).code, "ATTEMPT_CLOSED");
    }

    assert.equal((await getWalletBalances(userId)).tokenBalance, 20);
    assert.equal((await reconcileWallet(userId)).consistent, true);

    await expectAppError(
      submitAttempt(userId, started.attemptId, solution, later),
      "ATTEMPT_CLOSED",
    );
  });

  it("pays a milestone every 10th level", async () => {
    const { userId } = await registerTestUser(app);
    await completeBefore(userId, 10);

    const result = await play(userId, 10, (await levelSolution(10)).solution);

    assert.equal(result.stars, 3);
    assert.deepEqual(result.rewards, [{ currency: "TOKEN", amount: 70 }]);
    assert.equal(result.nextLevel, 11);

    const balances = await getWalletBalances(userId);
    assert.equal(balances.tokenBalance, 70);
    assert.equal(balances.gemBalance, 0);

    const replay = await play(userId, 10, (await levelSolution(10)).solution);
    assert.deepEqual(replay.rewards, []);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 70);
  });

  it("pays gems as well every 50th level", async () => {
    const { userId } = await registerTestUser(app);
    await completeBefore(userId, 50);

    const result = await play(userId, 50, (await levelSolution(50)).solution);

    assert.equal(result.stars, 3);
    assert.deepEqual(
      [...result.rewards].sort((a, b) => a.currency.localeCompare(b.currency)),
      [
        { currency: "GEM", amount: 5 },
        { currency: "TOKEN", amount: 70 },
      ],
    );

    const balances = await getWalletBalances(userId);
    assert.equal(balances.tokenBalance, 70);
    assert.equal(balances.gemBalance, 5);
    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("works over HTTP and requires a signed in player", async () => {
    const user = await registerTestUser(app);

    for (const [method, url] of [
      ["GET", "/api/levels/progress"],
      ["POST", "/api/levels/1/start"],
      ["POST", "/api/levels/attempts/00000000-0000-4000-8000-000000000000/submit"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        payload: method === "POST" ? { moves: [1] } : undefined,
      });

      assert.equal(response.statusCode, 401, `${method} ${url}`);
    }

    const start = await app.inject({
      method: "POST",
      url: "/api/levels/1/start",
      headers: bearer(user.token),
    });

    assert.equal(start.statusCode, 201);
    assert.equal(start.body.includes("solution"), false);

    const { attemptId } = start.json().data;
    const { solution } = await levelSolution(1);

    const fast = await app.inject({
      method: "POST",
      url: `/api/levels/attempts/${attemptId}/submit`,
      headers: bearer(user.token),
      payload: { moves: solution },
    });

    assert.equal(fast.statusCode, 422);
    assert.equal(fast.json().error.code, "SUBMISSION_TOO_FAST");

    for (const payload of [{}, { moves: [] }, { moves: "1,2" }, { moves: [-1] }]) {
      const bad = await app.inject({
        method: "POST",
        url: `/api/levels/attempts/${attemptId}/submit`,
        headers: bearer(user.token),
        payload,
      });

      assert.equal(bad.statusCode, 400);
    }

    const badLevel = await app.inject({
      method: "POST",
      url: "/api/levels/abc/start",
      headers: bearer(user.token),
    });

    assert.equal(badLevel.statusCode, 400);

    const locked = await app.inject({
      method: "POST",
      url: "/api/levels/2/start",
      headers: bearer(user.token),
    });

    assert.equal(locked.statusCode, 403);
    assert.equal(locked.json().error.code, "LEVEL_LOCKED");

    const progress = await app.inject({
      method: "GET",
      url: "/api/levels/progress",
      headers: bearer(user.token),
    });

    assert.equal(progress.statusCode, 200);
    assert.deepEqual(progress.json().data, {
      nextLevel: 1,
      completedLevels: 0,
      totalStars: 0,
    });
  });
});

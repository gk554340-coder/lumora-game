import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import { ACHIEVEMENTS } from "../src/modules/achievements/achievement.catalog.js";
import {
  checkAchievements,
  checkAchievementsSafely,
  listAchievements,
} from "../src/modules/achievements/achievement.service.js";
import {
  getOrCreateLevel,
  startLevel,
  submitAttempt,
} from "../src/modules/levels/level.service.js";
import {
  MIN_BASE_TIME_MS,
  MIN_TIME_PER_MOVE_MS,
  parseLevelConfiguration,
} from "../src/modules/levels/lumen-engine.js";
import {
  getWalletBalances,
  reconcileWallet,
} from "../src/modules/wallet/wallet.service.js";
import {
  bearer,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

async function solution(levelNumber: number): Promise<number[]> {
  const level = await getOrCreateLevel(levelNumber);
  const configuration = parseLevelConfiguration(level.configuration);

  assert.ok(configuration);

  return configuration.solution;
}

// Marks every level below `last` as completed with three stars.
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

async function play(userId: string, levelNumber: number): Promise<void> {
  const started = await startLevel(userId, levelNumber);

  await submitAttempt(
    userId,
    started.attemptId,
    await solution(levelNumber),
    new Date(Date.now() + 60_000),
  );
}

describe("achievements", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  it("lists every achievement as locked for a new player", async () => {
    const { userId } = await registerTestUser(app);

    const { achievements, newlyCompleted } = await listAchievements(userId);

    assert.equal(achievements.length, ACHIEVEMENTS.length);
    assert.deepEqual(newlyCompleted, []);

    for (const entry of achievements) {
      assert.equal(entry.status, "LOCKED");
      assert.equal(entry.progress, 0);
      assert.ok(entry.target >= 1);
      assert.ok(entry.reward.length >= 1);
    }

    assert.equal((await getWalletBalances(userId)).tokenBalance, 0);
  });

  it("completes the first achievement and shows progress on the others", async () => {
    const { userId } = await registerTestUser(app);
    await completeBefore(userId, 5);

    const { achievements, newlyCompleted } = await listAchievements(userId);

    assert.deepEqual(
      newlyCompleted.map((entry) => entry.code),
      ["first_light"],
    );
    assert.deepEqual(newlyCompleted[0].rewards, [
      { currency: "TOKEN", amount: 10 },
    ]);

    const byCode = new Map(achievements.map((entry) => [entry.code, entry]));

    assert.equal(byCode.get("first_light")?.status, "COMPLETED");
    assert.equal(byCode.get("pathfinder_10")?.status, "IN_PROGRESS");
    assert.equal(byCode.get("pathfinder_10")?.progress, 4);
    assert.equal(byCode.get("pathfinder_10")?.target, 10);
    assert.equal(byCode.get("star_collector_50")?.progress, 12);
    assert.deepEqual(byCode.get("pathfinder_50")?.reward, [
      { currency: "GEM", amount: 5 },
    ]);

    assert.equal((await getWalletBalances(userId)).tokenBalance, 10);
  });

  it("pays each achievement once as the player progresses", async () => {
    const { userId } = await registerTestUser(app);
    await completeBefore(userId, 10);

    const first = await checkAchievements(userId);

    assert.deepEqual(
      first.map((entry) => entry.code),
      ["first_light"],
    );
    assert.equal((await getWalletBalances(userId)).tokenBalance, 10);

    // Level 10 pays 20 for stars and 50 for the milestone.
    await play(userId, 10);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 80);

    const second = await checkAchievements(userId);

    assert.deepEqual(
      second.map((entry) => entry.code),
      ["pathfinder_10", "perfectionist_10"],
    );
    assert.equal((await getWalletBalances(userId)).tokenBalance, 180);

    assert.deepEqual(await checkAchievements(userId), []);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 180);
    assert.equal((await reconcileWallet(userId)).consistent, true);

    const { achievements } = await listAchievements(userId);
    const completed = achievements
      .filter((entry) => entry.status === "COMPLETED")
      .map((entry) => entry.code);

    assert.deepEqual(completed, [
      "first_light",
      "pathfinder_10",
      "perfectionist_10",
    ]);
  });

  it("remembers the best daily streak after it restarts", async () => {
    const { userId } = await registerTestUser(app);

    await prisma.playerProfile.update({
      where: { userId },
      data: { dailyStreak: 7 },
    });

    const done = await checkAchievements(userId);

    assert.deepEqual(
      done.map((entry) => entry.code),
      ["streak_3", "streak_7"],
    );

    const balances = await getWalletBalances(userId);
    assert.equal(balances.tokenBalance, 30);
    assert.equal(balances.gemBalance, 5);

    await prisma.playerProfile.update({
      where: { userId },
      data: { dailyStreak: 1 },
    });

    const { achievements, newlyCompleted } = await listAchievements(userId);
    const byCode = new Map(achievements.map((entry) => [entry.code, entry]));

    assert.deepEqual(newlyCompleted, []);
    assert.equal(byCode.get("streak_7")?.status, "COMPLETED");
    assert.equal(byCode.get("streak_30")?.status, "IN_PROGRESS");
    assert.equal(byCode.get("streak_30")?.progress, 7);
  });

  it("pays once when checks run in parallel", async () => {
    const { userId } = await registerTestUser(app);
    await completeBefore(userId, 2);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => checkAchievements(userId)),
    );

    const reported = results.flat();

    assert.equal(reported.length, 1);
    assert.equal(reported[0].code, "first_light");
    assert.equal((await getWalletBalances(userId)).tokenBalance, 10);
    assert.equal((await reconcileWallet(userId)).consistent, true);

    const rows = await prisma.playerAchievement.findMany({
      where: { userId, status: "COMPLETED" },
    });
    assert.equal(rows.length, 1);
  });

  it("reports a failed check without throwing", async () => {
    const errors: unknown[] = [];

    const result = await checkAchievementsSafely("not-a-uuid", (error) => {
      errors.push(error);
    });

    assert.deepEqual(result, []);
    assert.equal(errors.length, 1);
  });

  it("works over HTTP, after a real level and a daily claim", async () => {
    const user = await registerTestUser(app);

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/achievements",
    });
    assert.equal(anonymous.statusCode, 401);

    const start = await app.inject({
      method: "POST",
      url: "/api/levels/1/start",
      headers: bearer(user.token),
    });
    assert.equal(start.statusCode, 201);

    const moves = await solution(1);

    // The server measures the time, so wait as long as a person would
    // need at the very least.
    await sleep(MIN_BASE_TIME_MS + moves.length * MIN_TIME_PER_MOVE_MS + 300);

    const submit = await app.inject({
      method: "POST",
      url: `/api/levels/attempts/${start.json().data.attemptId}/submit`,
      headers: bearer(user.token),
      payload: { moves },
    });

    assert.equal(submit.statusCode, 200);
    assert.equal(submit.json().data.stars, 3);
    assert.deepEqual(
      submit.json().data.achievements.map((entry: { code: string }) => entry.code),
      ["first_light"],
    );

    const wallet = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: bearer(user.token),
    });
    assert.equal(wallet.json().data.tokenBalance, 30);

    const list = await app.inject({
      method: "GET",
      url: "/api/achievements",
      headers: bearer(user.token),
    });

    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.achievements.length, ACHIEVEMENTS.length);
    assert.deepEqual(list.json().data.newlyCompleted, []);

    const claim = await app.inject({
      method: "POST",
      url: "/api/rewards/daily/claim",
      headers: bearer(user.token),
    });

    assert.equal(claim.statusCode, 200);
    assert.equal(claim.json().data.claimed, true);
    assert.deepEqual(claim.json().data.achievements, []);
  });
});

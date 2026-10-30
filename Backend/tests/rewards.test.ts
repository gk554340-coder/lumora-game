import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import { claimDailyReward } from "../src/modules/rewards/daily-reward.service.js";
import { REWARD_CODES } from "../src/modules/rewards/reward.catalog.js";
import {
  getRewardDefinition,
  grantReward,
} from "../src/modules/rewards/reward.service.js";
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

const DAY_MS = 86_400_000;
const START = new Date("2026-03-01T10:00:00.000Z");

function day(offset: number): Date {
  return new Date(START.getTime() + offset * DAY_MS);
}

describe("rewards", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  it("pays day 1 and refuses a second claim on the same day", async () => {
    const { userId } = await registerTestUser(app);

    const first = await claimDailyReward(userId, START);

    assert.equal(first.claimed, true);
    assert.equal(first.streak, 1);
    assert.equal(first.cycleDay, 1);
    assert.deepEqual(first.rewards, [{ currency: "TOKEN", amount: 20 }]);

    const later = new Date(START.getTime() + 2 * 3_600_000);
    const second = await claimDailyReward(userId, later);

    assert.equal(second.claimed, false);
    assert.equal(second.streak, 1);
    assert.deepEqual(second.rewards, [{ currency: "TOKEN", amount: 20 }]);

    assert.equal((await getWalletBalances(userId)).tokenBalance, 20);
    assert.equal(await prisma.rewardGrant.count({ where: { userId } }), 1);
  });

  it("follows the seven day cycle and starts over on day 8", async () => {
    const { userId } = await registerTestUser(app);

    const expectedTokens = [20, 25, 30, 35, 40, 50, 100];

    for (let offset = 0; offset < 7; offset += 1) {
      const result = await claimDailyReward(userId, day(offset));

      assert.equal(result.claimed, true);
      assert.equal(result.streak, offset + 1);
      assert.equal(result.cycleDay, offset + 1);

      const tokens = result.rewards.find((r) => r.currency === "TOKEN");
      assert.equal(tokens?.amount, expectedTokens[offset]);
    }

    let balances = await getWalletBalances(userId);
    assert.equal(balances.tokenBalance, 300);
    assert.equal(balances.gemBalance, 5);

    const eighth = await claimDailyReward(userId, day(7));

    assert.equal(eighth.streak, 8);
    assert.equal(eighth.cycleDay, 1);

    balances = await getWalletBalances(userId);
    assert.equal(balances.tokenBalance, 320);
    assert.equal(balances.gemBalance, 5);

    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("restarts the streak after a missed day", async () => {
    const { userId } = await registerTestUser(app);

    assert.equal((await claimDailyReward(userId, day(0))).streak, 1);
    assert.equal((await claimDailyReward(userId, day(1))).streak, 2);

    const afterGap = await claimDailyReward(userId, day(3));

    assert.equal(afterGap.claimed, true);
    assert.equal(afterGap.streak, 1);
    assert.equal(afterGap.cycleDay, 1);
  });

  it("pays once when many claims arrive at the same time", async () => {
    const { userId } = await registerTestUser(app);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => claimDailyReward(userId, START)),
    );

    const values = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    assert.equal(values.length, 6);
    assert.equal(values.filter((value) => value.claimed).length, 1);

    assert.equal((await getWalletBalances(userId)).tokenBalance, 20);
    assert.equal(await prisma.rewardGrant.count({ where: { userId } }), 1);
    assert.equal(
      await prisma.walletTransaction.count({ where: { userId } }),
      1,
    );
    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("completes a reward left pending by an interrupted claim", async () => {
    const { userId } = await registerTestUser(app);
    const definition = await getRewardDefinition(REWARD_CODES.DAILY);

    // State after a crash: the profile was advanced and the grant row
    // was created, but the wallet was never credited.
    await prisma.rewardGrant.create({
      data: {
        userId,
        rewardDefinitionId: definition.id,
        status: "PENDING",
        sourceType: "BONUS",
        sourceId: "2026-03-01",
      },
    });

    await prisma.playerProfile.update({
      where: { userId },
      data: {
        dailyStreak: 1,
        lastDailyClaimOn: new Date("2026-03-01T00:00:00.000Z"),
      },
    });

    const result = await claimDailyReward(userId, START);

    assert.equal(result.claimed, false);
    assert.deepEqual(result.rewards, [{ currency: "TOKEN", amount: 20 }]);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 20);

    const grant = await prisma.rewardGrant.findFirstOrThrow({
      where: { userId },
    });
    assert.equal(grant.status, "GRANTED");

    // Asking again must not pay again.
    await claimDailyReward(userId, START);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 20);
  });

  it("grants a reward only once per source", async () => {
    const { userId } = await registerTestUser(app);

    const input = {
      userId,
      rewardCode: REWARD_CODES.DAILY,
      sourceType: "BONUS",
      cycleDay: 2,
    } as const;

    const first = await grantReward({ ...input, sourceId: "manual-1" });
    const second = await grantReward({ ...input, sourceId: "manual-1" });

    assert.equal(first.alreadyGranted, false);
    assert.equal(second.alreadyGranted, true);
    assert.equal(second.grantId, first.grantId);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 25);

    const other = await grantReward({ ...input, sourceId: "manual-2" });

    assert.equal(other.alreadyGranted, false);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 50);
  });

  it("rejects unknown rewards, bad cycle days and bad sources", async () => {
    const { userId } = await registerTestUser(app);

    await expectAppError(
      grantReward({
        userId,
        rewardCode: "does.not.exist",
        sourceId: "x-1",
        sourceType: "BONUS",
      }),
      "REWARD_NOT_FOUND",
    );

    await expectAppError(
      grantReward({
        userId,
        rewardCode: REWARD_CODES.DAILY,
        sourceId: "x-2",
        sourceType: "BONUS",
        cycleDay: 9,
      }),
      "INVALID_CYCLE_DAY",
    );

    await expectAppError(
      grantReward({
        userId,
        rewardCode: REWARD_CODES.DAILY,
        sourceId: "not allowed!",
        sourceType: "BONUS",
        cycleDay: 1,
      }),
      "INVALID_SOURCE",
    );

    assert.equal((await getWalletBalances(userId)).tokenBalance, 0);
  });

  it("serves the daily reward over HTTP for signed in players only", async () => {
    const user = await registerTestUser(app);

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/rewards/daily",
    });
    assert.equal(anonymous.statusCode, 401);

    const anonymousClaim = await app.inject({
      method: "POST",
      url: "/api/rewards/daily/claim",
    });
    assert.equal(anonymousClaim.statusCode, 401);

    const before = await app.inject({
      method: "GET",
      url: "/api/rewards/daily",
      headers: bearer(user.token),
    });

    assert.equal(before.statusCode, 200);
    assert.equal(before.json().data.canClaim, true);
    assert.equal(before.json().data.nextCycleDay, 1);

    const claim = await app.inject({
      method: "POST",
      url: "/api/rewards/daily/claim",
      headers: bearer(user.token),
    });

    assert.equal(claim.statusCode, 200);
    assert.equal(claim.json().data.claimed, true);

    const again = await app.inject({
      method: "POST",
      url: "/api/rewards/daily/claim",
      headers: bearer(user.token),
    });

    assert.equal(again.json().data.claimed, false);

    const wallet = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: bearer(user.token),
    });

    assert.equal(wallet.json().data.tokenBalance, 20);

    const after = await app.inject({
      method: "GET",
      url: "/api/rewards/daily",
      headers: bearer(user.token),
    });

    assert.equal(after.json().data.claimedToday, true);
    assert.equal(after.json().data.canClaim, false);
  });

  it("cannot be used to change balances directly", async () => {
    const user = await registerTestUser(app);

    for (const url of [
      "/api/rewards/grant",
      "/api/rewards",
      "/api/rewards/daily/grant",
    ]) {
      const attempt = await app.inject({
        method: "POST",
        url,
        headers: bearer(user.token),
        payload: { amount: 1000 },
      });

      assert.equal(attempt.statusCode, 404);
    }

    assert.equal((await getWalletBalances(user.userId)).tokenBalance, 0);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import {
  HINT_COST_TOKENS,
  MAX_HINTS_PER_ATTEMPT,
  requestHint,
} from "../src/modules/levels/hint.service.js";
import {
  getOrCreateLevel,
  startLevel,
  submitAttempt,
} from "../src/modules/levels/level.service.js";
import { parseLevelConfiguration } from "../src/modules/levels/lumen-engine.js";
import {
  creditWallet,
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

async function levelOne() {
  const level = await getOrCreateLevel(1);
  const configuration = parseLevelConfiguration(level.configuration);

  assert.ok(configuration);

  return configuration;
}

async function fund(userId: string, tokens: number): Promise<void> {
  await creditWallet({
    userId,
    currency: "TOKEN",
    source: "BONUS",
    amount: tokens,
  });
}

describe("hints", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  it("charges nothing and gives nothing when the player cannot pay", async () => {
    const { userId } = await registerTestUser(app);
    const started = await startLevel(userId, 1);

    await expectAppError(
      requestHint(userId, started.attemptId, []),
      "INSUFFICIENT_FUNDS",
    );

    assert.equal((await getWalletBalances(userId)).tokenBalance, 0);
  });

  it("names a solution tile, charges once and repeats the answer for free", async () => {
    const { userId } = await registerTestUser(app);
    const { solution, width } = await levelOne();
    const started = await startLevel(userId, 1);
    await fund(userId, 100);

    const first = await requestHint(userId, started.attemptId, []);

    assert.ok(solution.includes(first.tile));
    assert.equal(first.x, first.tile % width);
    assert.equal(first.y, Math.floor(first.tile / width));
    assert.equal(first.cost, HINT_COST_TOKENS);
    assert.equal(first.tokenBalance, 100 - HINT_COST_TOKENS);
    assert.equal(first.hintsUsed, 1);
    assert.equal(first.hintsRemaining, MAX_HINTS_PER_ATTEMPT - 1);

    const again = await requestHint(userId, started.attemptId, []);

    assert.equal(again.tile, first.tile);
    assert.equal(again.cost, 0);
    assert.equal(again.tokenBalance, 100 - HINT_COST_TOKENS);
    assert.equal(again.hintsUsed, 1);

    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("leads the player to a solved level one hint at a time", async () => {
    const { userId } = await registerTestUser(app);
    const { solution } = await levelOne();
    const started = await startLevel(userId, 1);
    await fund(userId, 1000);

    const moves: number[] = [];

    for (let step = 0; step < solution.length; step += 1) {
      const hint = await requestHint(userId, started.attemptId, moves);

      assert.ok(solution.includes(hint.tile));
      assert.equal(moves.includes(hint.tile), false);

      moves.push(hint.tile);
    }

    await expectAppError(
      requestHint(userId, started.attemptId, moves),
      "HINT_NOT_NEEDED",
    );

    assert.equal(
      (await getWalletBalances(userId)).tokenBalance,
      1000 - solution.length * HINT_COST_TOKENS,
    );

    const result = await submitAttempt(
      userId,
      started.attemptId,
      moves,
      new Date(Date.now() + 60_000),
    );

    assert.equal(result.stars, 3);
    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("skips tiles the player has already flipped", async () => {
    const { userId } = await registerTestUser(app);
    const { solution } = await levelOne();
    const started = await startLevel(userId, 1);
    await fund(userId, 100);

    const hint = await requestHint(userId, started.attemptId, [solution[0]]);

    assert.notEqual(hint.tile, solution[0]);
    assert.ok(solution.includes(hint.tile));
  });

  it("rejects invalid moves, other players, closed attempts and bad ids", async () => {
    const owner = await registerTestUser(app);
    const other = await registerTestUser(app);
    const started = await startLevel(owner.userId, 1);
    const { solution } = await levelOne();
    await fund(owner.userId, 100);
    await fund(other.userId, 100);

    await expectAppError(
      requestHint(owner.userId, started.attemptId, [99_999]),
      "MOVES_INVALID",
    );

    await expectAppError(
      requestHint(owner.userId, started.attemptId, [0.5]),
      "MOVES_INVALID",
    );

    await expectAppError(
      requestHint(other.userId, started.attemptId, []),
      "ATTEMPT_NOT_FOUND",
    );

    await expectAppError(
      requestHint(owner.userId, "not-a-uuid", []),
      "ATTEMPT_NOT_FOUND",
    );

    await expectAppError(
      requestHint(
        owner.userId,
        started.attemptId,
        [],
        new Date(Date.now() + 25 * 3_600_000),
      ),
      "ATTEMPT_EXPIRED",
    );

    await submitAttempt(
      owner.userId,
      started.attemptId,
      solution,
      new Date(Date.now() + 60_000),
    );

    await expectAppError(
      requestHint(owner.userId, started.attemptId, []),
      "ATTEMPT_CLOSED",
    );

    // Nothing was charged by any of the rejected requests.
    assert.equal((await getWalletBalances(owner.userId)).tokenBalance, 100 + 20);
    assert.equal((await getWalletBalances(other.userId)).tokenBalance, 100);
  });

  it("charges once when the same hint is requested in parallel", async () => {
    const { userId } = await registerTestUser(app);
    const started = await startLevel(userId, 1);
    await fund(userId, 100);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        requestHint(userId, started.attemptId, []),
      ),
    );

    assert.equal(new Set(results.map((entry) => entry.tile)).size, 1);
    assert.equal(
      (await getWalletBalances(userId)).tokenBalance,
      100 - HINT_COST_TOKENS,
    );
    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("works over HTTP and requires a signed in player", async () => {
    const user = await registerTestUser(app);
    const started = await startLevel(user.userId, 1);
    await fund(user.userId, 100);

    const url = `/api/levels/attempts/${started.attemptId}/hint`;

    const anonymous = await app.inject({
      method: "POST",
      url,
      payload: { moves: [] },
    });

    assert.equal(anonymous.statusCode, 401);

    const response = await app.inject({
      method: "POST",
      url,
      headers: bearer(user.token),
      payload: { moves: [] },
    });

    assert.equal(response.statusCode, 200);

    const data = response.json().data;

    assert.equal(typeof data.tile, "number");
    assert.equal(data.cost, HINT_COST_TOKENS);
    assert.equal(data.tokenBalance, 100 - HINT_COST_TOKENS);
    assert.equal(response.body.includes("solution"), false);

    for (const payload of [{}, { moves: "x" }, { moves: [-1] }]) {
      const bad = await app.inject({
        method: "POST",
        url,
        headers: bearer(user.token),
        payload,
      });

      assert.equal(bad.statusCode, 400);
    }
  });
});

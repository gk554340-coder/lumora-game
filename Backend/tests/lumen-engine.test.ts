import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_MOVES,
  MIN_BASE_TIME_MS,
  MIN_TIME_PER_MOVE_MS,
  applyMoves,
  difficultyFor,
  generateLevel,
  isRotatable,
  parseLevelConfiguration,
  simulate,
  starsFor,
  verifySolution,
  type Board,
  type LevelConfiguration,
  type Tile,
} from "../src/modules/levels/lumen-engine.js";

// Builds a small board from rows of letters:
//   . empty   # blocker   T target
//   > ^ < v   emitter facing east, north, west, south
//   / \       mirror      A "/" splitter   B "\" splitter
function boardFrom(rows: string[]): Board {
  const height = rows.length;
  const width = rows[0].length;
  const tiles: Tile[] = [];

  for (const row of rows) {
    assert.equal(row.length, width);

    for (const symbol of row) {
      switch (symbol) {
        case ".":
          tiles.push({ kind: "EMPTY" });
          break;
        case "#":
          tiles.push({ kind: "BLOCKER" });
          break;
        case "T":
          tiles.push({ kind: "TARGET" });
          break;
        case "^":
          tiles.push({ kind: "EMITTER", direction: 0 });
          break;
        case ">":
          tiles.push({ kind: "EMITTER", direction: 1 });
          break;
        case "v":
          tiles.push({ kind: "EMITTER", direction: 2 });
          break;
        case "<":
          tiles.push({ kind: "EMITTER", direction: 3 });
          break;
        case "/":
          tiles.push({ kind: "MIRROR", state: 0 });
          break;
        case "\\":
          tiles.push({ kind: "MIRROR", state: 1 });
          break;
        case "A":
          tiles.push({ kind: "SPLITTER", state: 0 });
          break;
        case "B":
          tiles.push({ kind: "SPLITTER", state: 1 });
          break;
        default:
          assert.fail(`unknown symbol ${symbol}`);
      }
    }
  }

  return { width, height, tiles };
}

function at(board: Board, x: number, y: number): number {
  return y * board.width + x;
}

function rotatableIndexes(board: Board): number[] {
  return board.tiles.flatMap((tile, index) =>
    isRotatable(tile) ? [index] : [],
  );
}

function toBoard(level: LevelConfiguration): Board {
  return { width: level.width, height: level.height, tiles: level.tiles };
}

describe("lumen engine: beams", () => {
  it("lights a target in a straight line", () => {
    const board = boardFrom([
      ">.T.",
      "....",
      "....",
      "....",
    ]);

    const result = simulate(board);

    assert.equal(result.solved, true);
    assert.equal(result.lit[at(board, 2, 0)], true);
  });

  it("turns the beam at a mirror", () => {
    const board = boardFrom([
      ">.\\.",
      "....",
      "..T.",
      "....",
    ]);

    assert.equal(simulate(board).solved, true);

    // Flipping the mirror sends the beam north, away from the target.
    const flipped = applyMoves(board, [at(board, 2, 0)]);
    assert.ok(flipped);
    assert.equal(simulate(flipped).solved, false);
  });

  it("reflects in all four directions", () => {
    // East into "/" turns north.
    const eastToNorth = boardFrom([
      "..T.",
      "....",
      ">./.",
      "....",
    ]);
    assert.equal(simulate(eastToNorth).solved, true);

    // East into "\\" turns south.
    const eastToSouth = boardFrom([
      "....",
      ">.\\.",
      "....",
      "..T.",
    ]);
    assert.equal(simulate(eastToSouth).solved, true);

    // West into "/" turns south.
    const westToSouth = boardFrom([
      "....",
      "./.<",
      "....",
      ".T..",
    ]);
    assert.equal(simulate(westToSouth).solved, true);

    // West into "\\" turns north.
    const westToNorth = boardFrom([
      ".T..",
      "....",
      ".\\.<",
      "....",
    ]);
    assert.equal(simulate(westToNorth).solved, true);

    // South into "/" turns west.
    const southToWest = boardFrom([
      "..v.",
      "....",
      "T./.",
      "....",
    ]);
    assert.equal(simulate(southToWest).solved, true);

    // South into "\\" turns east.
    const southToEast = boardFrom([
      ".v..",
      "....",
      ".\\.T",
      "....",
    ]);
    assert.equal(simulate(southToEast).solved, true);

    // North into "/" turns east.
    const northToEast = boardFrom([
      "./.T",
      "....",
      ".^..",
      "....",
    ]);
    assert.equal(simulate(northToEast).solved, true);

    // North into "\\" turns west.
    const northToWest = boardFrom([
      "T.\\.",
      "....",
      "..^.",
      "....",
    ]);
    assert.equal(simulate(northToWest).solved, true);
  });

  it("stops at a blocker", () => {
    const board = boardFrom([
      ">#T.",
      "....",
      "....",
      "....",
    ]);

    assert.equal(simulate(board).solved, false);
  });

  it("lets a beam pass through a target and keep going", () => {
    const board = boardFrom([
      ">TT.",
      "....",
      "....",
      "....",
    ]);

    const result = simulate(board);

    assert.equal(result.targetCount, 2);
    assert.equal(result.solved, true);
  });

  it("splits a beam in two", () => {
    // "A" is a "/" splitter. East becomes east plus north.
    const board = boardFrom([
      "..T.",
      ">.AT",
      "....",
      "....",
    ]);

    const result = simulate(board);

    assert.equal(result.targetCount, 2);
    assert.equal(result.solved, true);
  });

  it("ends when beams loop", () => {
    // Mirrors at the corners of a rectangle send a beam round and round.
    // The splitter feeds the loop, so the same cells are reached again
    // and again. The visit check must stop it instead of running forever.
    const board = boardFrom([
      "..v..",
      "./B\\.",
      "..T..",
      ".\\./.",
      ".....",
    ]);

    const result = simulate(board);

    assert.equal(result.solved, true);
    assert.equal(result.lit[at(board, 2, 2)], true);
  });

  it("ignores a board with no emitter", () => {
    const board = boardFrom([
      "T...",
      "....",
      "....",
      "....",
    ]);

    assert.equal(simulate(board).solved, false);
  });
});

describe("lumen engine: moves", () => {
  it("rejects moves that are not mirrors or splitters", () => {
    const board = boardFrom([
      ">./T",
      "....",
      "....",
      "....",
    ]);

    assert.equal(applyMoves(board, [at(board, 1, 0)]), null);
    assert.equal(applyMoves(board, [-1]), null);
    assert.equal(applyMoves(board, [999]), null);
    assert.equal(applyMoves(board, [1.5]), null);
    assert.equal(applyMoves(board, [Number.NaN]), null);
    assert.ok(applyMoves(board, [at(board, 2, 0)]));
  });

  it("does not change the original board", () => {
    const board = boardFrom([
      ">./T",
      "....",
      "....",
      "....",
    ]);

    const before = JSON.stringify(board);
    applyMoves(board, [at(board, 2, 0)]);

    assert.equal(JSON.stringify(board), before);
  });

  it("flips the same tile back with two moves", () => {
    const board = boardFrom([
      ">./T",
      "....",
      "....",
      "....",
    ]);

    const twice = applyMoves(board, [at(board, 2, 0), at(board, 2, 0)]);

    assert.deepEqual(twice?.tiles, board.tiles);
  });
});

describe("lumen engine: difficulty", () => {
  it("grows with the level number and never ends", () => {
    const early = difficultyFor(1);
    const later = difficultyFor(200);
    const far = difficultyFor(1_000_000);

    assert.equal(early.tier, 1);
    assert.ok(later.size > early.size);
    assert.ok(later.targets > early.targets);
    assert.ok(far.tier > later.tier);
    assert.ok(far.size <= 9);
  });

  it("rejects an invalid level number", () => {
    assert.throws(() => difficultyFor(0), RangeError);
    assert.throws(() => difficultyFor(-3), RangeError);
    assert.throws(() => difficultyFor(1.5), RangeError);
  });
});

describe("lumen engine: generation", () => {
  it("makes the same level every time", () => {
    for (const number of [1, 7, 42, 250]) {
      const first = generateLevel(number);
      const second = generateLevel(number);

      assert.deepEqual(first.configuration, second.configuration);
      assert.equal(first.seed, second.seed);
    }
  });

  it("makes different levels for different numbers", () => {
    const one = JSON.stringify(generateLevel(1).configuration.tiles);
    const two = JSON.stringify(generateLevel(2).configuration.tiles);

    assert.notEqual(one, two);
  });

  it("always makes a solvable puzzle that is not solved at the start", () => {
    const started = Date.now();
    let relaxedCount = 0;

    for (let number = 1; number <= 1500; number += 1) {
      const generated = generateLevel(number);
      const level = generated.configuration;
      const board = toBoard(level);

      if (generated.relaxed) {
        relaxedCount += 1;
      }

      assert.equal(simulate(board).solved, false, `level ${number} starts solved`);

      const solved = applyMoves(board, level.solution);
      assert.ok(solved, `level ${number} solution is invalid`);
      assert.equal(simulate(solved).solved, true, `level ${number} not solvable`);

      assert.equal(level.parMoves, level.solution.length);
      assert.ok(level.parMoves >= 2, `level ${number} par too small`);
      assert.equal(new Set(level.solution).size, level.solution.length);

      const emitters = level.tiles.filter((t) => t.kind === "EMITTER");
      const targets = level.tiles.filter((t) => t.kind === "TARGET");
      assert.equal(emitters.length, 1);
      assert.ok(targets.length >= 1);

      assert.equal(level.width, difficultyFor(number).size);
      assert.ok(parseLevelConfiguration(level), `level ${number} not parseable`);
    }

    assert.equal(relaxedCount, 0, "some levels needed the relaxed fallback");
    assert.ok(Date.now() - started < 20_000, "generation is too slow");
  });

  it("adds splitters from the second tier on", () => {
    let withSplitter = 0;

    for (let number = 11; number <= 60; number += 1) {
      const level = generateLevel(number).configuration;

      if (level.tiles.some((tile) => tile.kind === "SPLITTER")) {
        withSplitter += 1;
      }
    }

    assert.equal(withSplitter, 50);

    const first = generateLevel(1).configuration;
    assert.equal(first.tiles.some((tile) => tile.kind === "SPLITTER"), false);
  });

  it("never needs more moves than the stored solution", () => {
    // Brute force the true minimum on small levels.
    for (let number = 1; number <= 40; number += 1) {
      const level = generateLevel(number).configuration;
      const board = toBoard(level);
      const rotatable = rotatableIndexes(board);

      if (rotatable.length > 12) {
        continue;
      }

      let best = Number.POSITIVE_INFINITY;

      for (let mask = 0; mask < 1 << rotatable.length; mask += 1) {
        const moves = rotatable.filter((_, bit) => (mask >> bit) & 1);

        if (moves.length >= best) {
          continue;
        }

        const result = applyMoves(board, moves);

        if (result && simulate(result).solved) {
          best = moves.length;
        }
      }

      assert.ok(best <= level.parMoves, `level ${number}: ${best} > ${level.parMoves}`);
      assert.ok(best >= 1);
    }
  });
});

describe("lumen engine: verification", () => {
  const level = generateLevel(5).configuration;
  const slowEnough = (moves: number) =>
    MIN_BASE_TIME_MS + moves * MIN_TIME_PER_MOVE_MS + 1;

  it("accepts the stored solution with three stars", () => {
    const result = verifySolution(
      level,
      level.solution,
      slowEnough(level.solution.length),
    );

    assert.deepEqual(result, {
      ok: true,
      moves: level.parMoves,
      parMoves: level.parMoves,
      stars: 3,
    });
  });

  it("accepts the moves in any order", () => {
    const reversed = [...level.solution].reverse();
    const result = verifySolution(level, reversed, slowEnough(reversed.length));

    assert.equal(result.ok, true);
  });

  it("gives fewer stars for wasted moves", () => {
    const wasted = [...level.solution, level.solution[0], level.solution[0]];
    const result = verifySolution(level, wasted, slowEnough(wasted.length));

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.equal(result.stars, starsFor(wasted.length, level.parMoves));
      assert.ok(result.stars < 3);
    }
  });

  it("rejects moves that do not solve the level", () => {
    const partial = level.solution.slice(1);
    const result = verifySolution(level, partial, slowEnough(partial.length + 5));

    assert.deepEqual(result, { ok: false, reason: "NOT_SOLVED" });
  });

  it("rejects a solution that arrives faster than a person can play", () => {
    const result = verifySolution(level, level.solution, 50);

    assert.deepEqual(result, { ok: false, reason: "TOO_FAST" });

    assert.deepEqual(
      verifySolution(level, level.solution, Number.NaN),
      { ok: false, reason: "TOO_FAST" },
    );
  });

  it("rejects invalid or oversized move lists", () => {
    assert.deepEqual(verifySolution(level, [], 100_000), {
      ok: false,
      reason: "TOO_MANY_MOVES",
    });

    assert.deepEqual(
      verifySolution(level, new Array(MAX_MOVES + 1).fill(0), 10_000_000),
      { ok: false, reason: "TOO_MANY_MOVES" },
    );

    assert.deepEqual(verifySolution(level, [-1], 100_000), {
      ok: false,
      reason: "INVALID_MOVE",
    });

    assert.deepEqual(verifySolution(level, [0.5], 100_000), {
      ok: false,
      reason: "INVALID_MOVE",
    });

    const emitter = level.tiles.findIndex((tile) => tile.kind === "EMITTER");
    assert.deepEqual(verifySolution(level, [emitter], 100_000), {
      ok: false,
      reason: "INVALID_MOVE",
    });
  });

  it("awards stars by the distance from par", () => {
    assert.equal(starsFor(4, 4), 3);
    assert.equal(starsFor(3, 4), 3);
    assert.equal(starsFor(5, 4), 2);
    assert.equal(starsFor(7, 4), 2);
    assert.equal(starsFor(8, 4), 1);
    assert.equal(starsFor(100, 4), 1);
  });
});

describe("lumen engine: stored configuration", () => {
  const level = generateLevel(12).configuration;

  it("accepts a generated level", () => {
    assert.deepEqual(parseLevelConfiguration(JSON.parse(JSON.stringify(level))), level);
  });

  it("rejects damaged data", () => {
    const clone = (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(level)) as Record<string, unknown>;

    assert.equal(parseLevelConfiguration(null), null);
    assert.equal(parseLevelConfiguration("text"), null);
    assert.equal(parseLevelConfiguration([]), null);

    assert.equal(parseLevelConfiguration({ ...clone(), version: 99 }), null);
    assert.equal(parseLevelConfiguration({ ...clone(), width: 1000 }), null);
    assert.equal(parseLevelConfiguration({ ...clone(), tiles: [] }), null);
    assert.equal(parseLevelConfiguration({ ...clone(), parMoves: 0 }), null);
    assert.equal(parseLevelConfiguration({ ...clone(), solution: [] }), null);

    const badTile = clone();
    (badTile.tiles as unknown[])[0] = { kind: "LASER" };
    assert.equal(parseLevelConfiguration(badTile), null);

    const badSolution = clone();
    (badSolution.solution as number[])[0] = 0;
    const firstTile = (badSolution.tiles as Tile[])[0];

    if (!isRotatable(firstTile)) {
      assert.equal(parseLevelConfiguration(badSolution), null);
    }
  });
});

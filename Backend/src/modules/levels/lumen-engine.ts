/**
 * Lumen Paths engine.
 *
 * Pure game logic with no database or HTTP code, so the server can
 * generate levels, replay a player's moves and decide the result.
 *
 * Rules
 *  - The board is a grid. An emitter sends a beam of light in one
 *    direction. Mirrors turn the beam, splitters pass it on and also
 *    turn a copy, blockers stop it, targets light up when a beam passes
 *    through them and let it continue.
 *  - Mirrors and splitters have two states (0 = "/", 1 = "\"). One move
 *    flips one of them.
 *  - A level is solved when every target is lit.
 *
 * Levels are generated from the level number, so every player sees the
 * same level N. The generated board is stored by the caller, so later
 * changes to the generator never alter an existing level.
 */

export const LEVEL_GENERATOR_VERSION = 1;

/** 0 = north, 1 = east, 2 = south, 3 = west. */
export type Direction = 0 | 1 | 2 | 3;
export type TileState = 0 | 1;
export type TileKind =
  | "EMPTY"
  | "EMITTER"
  | "MIRROR"
  | "SPLITTER"
  | "BLOCKER"
  | "TARGET";

export type Tile = {
  kind: TileKind;
  direction?: Direction;
  state?: TileState;
};

export type Board = {
  width: number;
  height: number;
  tiles: Tile[];
};

export type LevelConfiguration = {
  version: number;
  width: number;
  height: number;
  tiles: Tile[];
  parMoves: number;
  solution: number[];
};

export type Difficulty = {
  tier: number;
  size: number;
  targets: number;
  pathLength: number;
  minTurns: number;
  splitters: number;
  decoyMirrors: number;
  blockers: number;
  minPar: number;
};

export type GeneratedLevel = {
  levelNumber: number;
  tier: number;
  difficultyScore: number;
  seed: string;
  configuration: LevelConfiguration;
  attempts: number;
  relaxed: boolean;
};

export type SimulationResult = {
  lit: boolean[];
  targetCount: number;
  litTargets: number;
  solved: boolean;
};

export type VerifyFailure =
  | "TOO_MANY_MOVES"
  | "INVALID_MOVE"
  | "NOT_SOLVED"
  | "TOO_FAST";

export type VerifyResult =
  | { ok: false; reason: VerifyFailure }
  | { ok: true; moves: number; parMoves: number; stars: 1 | 2 | 3 };

export const MAX_MOVES = 400;
export const MIN_BASE_TIME_MS = 600;
export const MIN_TIME_PER_MOVE_MS = 120;

const MIN_BOARD_SIZE = 3;
const MAX_BOARD_SIZE = 12;
const STRICT_ATTEMPTS = 80;
const RELAXED_ATTEMPTS = 80;

const DX: readonly number[] = [0, 1, 0, -1];
const DY: readonly number[] = [-1, 0, 1, 0];

// REFLECT[state][incoming direction] = outgoing direction.
// State 0 is "/", state 1 is "\".
const REFLECT: readonly (readonly Direction[])[] = [
  [1, 0, 3, 2],
  [3, 2, 1, 0],
];

function reflect(direction: Direction, state: TileState): Direction {
  return REFLECT[state][direction];
}

function turnRight(direction: Direction): Direction {
  return ((direction + 1) % 4) as Direction;
}

function turnLeft(direction: Direction): Direction {
  return ((direction + 3) % 4) as Direction;
}

function stateTurning(
  incoming: Direction,
  outgoing: Direction,
): TileState | null {
  if (reflect(incoming, 0) === outgoing) {
    return 0;
  }

  if (reflect(incoming, 1) === outgoing) {
    return 1;
  }

  return null;
}

// ---------------------------------------------------------------------
// Random numbers (deterministic)
// ---------------------------------------------------------------------

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

export type Rng = {
  next: () => number;
  int: (limit: number) => number;
  chance: (probability: number) => boolean;
  shuffle: <T>(items: readonly T[]) => T[];
};

export function createRng(seed: string): Rng {
  let state = hashSeed(seed) | 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (limit: number): number => Math.floor(next() * limit);

  const chance = (probability: number): boolean => next() < probability;

  const shuffle = <T>(items: readonly T[]): T[] => {
    const result = [...items];

    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      const held = result[i];
      result[i] = result[j];
      result[j] = held;
    }

    return result;
  };

  return { next, int, chance, shuffle };
}

// ---------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------

export function isRotatable(tile: Tile): boolean {
  return tile.kind === "MIRROR" || tile.kind === "SPLITTER";
}

/**
 * Follows every beam through the board. Each (cell, direction) pair is
 * visited at most once, so loops always end.
 */
export function simulate(board: Board): SimulationResult {
  const { width, height, tiles } = board;
  const lit = new Array<boolean>(tiles.length).fill(false);
  const seen = new Uint8Array(tiles.length * 4);
  const stack: number[] = [];

  const push = (index: number, direction: Direction): void => {
    const x = (index % width) + DX[direction];
    const y = Math.floor(index / width) + DY[direction];

    if (x < 0 || y < 0 || x >= width || y >= height) {
      return;
    }

    stack.push((y * width + x) * 4 + direction);
  };

  tiles.forEach((tile, index) => {
    if (tile.kind === "EMITTER" && tile.direction !== undefined) {
      push(index, tile.direction);
    }
  });

  while (stack.length > 0) {
    const code = stack.pop() as number;

    if (seen[code] === 1) {
      continue;
    }

    seen[code] = 1;

    const index = code >> 2;
    const direction = (code & 3) as Direction;
    const tile = tiles[index];

    switch (tile.kind) {
      case "EMPTY":
        push(index, direction);
        break;
      case "TARGET":
        lit[index] = true;
        push(index, direction);
        break;
      case "MIRROR":
        push(index, reflect(direction, tile.state ?? 0));
        break;
      case "SPLITTER":
        push(index, direction);
        push(index, reflect(direction, tile.state ?? 0));
        break;
      default:
        // Emitters and blockers stop the beam.
        break;
    }
  }

  let targetCount = 0;
  let litTargets = 0;

  tiles.forEach((tile, index) => {
    if (tile.kind === "TARGET") {
      targetCount += 1;

      if (lit[index]) {
        litTargets += 1;
      }
    }
  });

  return {
    lit,
    targetCount,
    litTargets,
    solved: targetCount > 0 && litTargets === targetCount,
  };
}

/**
 * Flips the tiles named by the moves. Returns null if any move is not a
 * whole number that points at a mirror or splitter.
 */
export function applyMoves(
  board: Board,
  moves: readonly number[],
): Board | null {
  const tiles = board.tiles.map((tile) => ({ ...tile }));

  for (const move of moves) {
    if (!Number.isSafeInteger(move) || move < 0 || move >= tiles.length) {
      return null;
    }

    const tile = tiles[move];

    if (!isRotatable(tile)) {
      return null;
    }

    tile.state = tile.state === 1 ? 0 : 1;
  }

  return { width: board.width, height: board.height, tiles };
}

// ---------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------

export function difficultyFor(levelNumber: number): Difficulty {
  if (!Number.isSafeInteger(levelNumber) || levelNumber < 1) {
    throw new RangeError("levelNumber must be a positive whole number.");
  }

  const tier = 1 + Math.floor((levelNumber - 1) / 10);
  const size = Math.min(4 + Math.floor(tier / 2), 9);
  const cells = size * size;

  return {
    tier,
    size,
    targets: Math.min(1 + Math.floor(tier / 2), 5),
    pathLength: Math.min(size + 2 + tier, Math.floor(cells * 0.6)),
    minTurns: Math.min(2 + Math.floor(tier / 2), 8),
    splitters: tier >= 2 ? Math.min(Math.floor(tier / 2), 3) : 0,
    decoyMirrors: Math.min(
      Math.floor(cells * 0.08) + Math.floor(tier / 2),
      Math.floor(cells * 0.25),
    ),
    blockers: tier >= 3 ? Math.min(Math.floor(tier / 3), 4) : 0,
    minPar: Math.min(2 + Math.floor(tier / 3), 8),
  };
}

// ---------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------

type PathCell = {
  index: number;
  travel: Direction;
  turned: boolean;
};

function tryGenerate(
  difficulty: Difficulty,
  rng: Rng,
): { configuration: LevelConfiguration; score: number } | null {
  const size = difficulty.size;
  const cells = size * size;

  const inBounds = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < size && y < size;

  const tiles: Tile[] = Array.from({ length: cells }, () => ({
    kind: "EMPTY" as TileKind,
  }));
  const occupied = new Array<boolean>(cells).fill(false);

  // Emitter on an edge, facing inward.
  const side = rng.int(4);
  const along = rng.int(size);
  let x = 0;
  let y = 0;
  let direction: Direction = 1;

  if (side === 0) {
    x = along;
    y = 0;
    direction = 2;
  } else if (side === 1) {
    x = size - 1;
    y = along;
    direction = 3;
  } else if (side === 2) {
    x = along;
    y = size - 1;
    direction = 0;
  } else {
    x = 0;
    y = along;
    direction = 1;
  }

  const emitterIndex = y * size + x;
  tiles[emitterIndex] = { kind: "EMITTER", direction };
  occupied[emitterIndex] = true;

  // Walk the beam path, turning at random.
  const path: PathCell[] = [];

  while (path.length < difficulty.pathLength) {
    const nextX = x + DX[direction];
    const nextY = y + DY[direction];

    if (!inBounds(nextX, nextY)) {
      break;
    }

    const nextIndex = nextY * size + nextX;

    if (occupied[nextIndex]) {
      break;
    }

    const travel = direction;
    let outgoing: Direction = direction;
    let turned = false;

    const aheadX = nextX + DX[direction];
    const aheadY = nextY + DY[direction];
    const blockedAhead =
      !inBounds(aheadX, aheadY) || occupied[aheadY * size + aheadX];

    if (blockedAhead || rng.chance(0.45)) {
      const options = rng.shuffle<Direction>([
        turnLeft(direction),
        turnRight(direction),
      ]);

      for (const option of options) {
        const sideX = nextX + DX[option];
        const sideY = nextY + DY[option];

        if (inBounds(sideX, sideY) && !occupied[sideY * size + sideX]) {
          outgoing = option;
          turned = true;
          break;
        }
      }
    }

    occupied[nextIndex] = true;
    path.push({ index: nextIndex, travel, turned });

    if (turned) {
      const state = stateTurning(travel, outgoing);

      if (state === null) {
        return null;
      }

      tiles[nextIndex] = { kind: "MIRROR", state };
    }

    x = nextX;
    y = nextY;
    direction = outgoing;
  }

  const criticalIndexes: number[] = path
    .filter((cell) => cell.turned)
    .map((cell) => cell.index);

  const straightCells = path.filter((cell) => !cell.turned);

  if (
    criticalIndexes.length < difficulty.minTurns ||
    straightCells.length < difficulty.targets + difficulty.splitters
  ) {
    return null;
  }

  // Targets on straight cells of the path.
  const shuffledStraight = rng.shuffle(straightCells);
  const targetCells = shuffledStraight.slice(0, difficulty.targets);

  for (const cell of targetCells) {
    tiles[cell.index] = { kind: "TARGET" };
  }

  // Splitters on other straight cells, each with a short side branch
  // that ends in an extra target.
  const splitterCandidates = shuffledStraight.slice(difficulty.targets);
  let splitterCount = 0;

  for (const cell of splitterCandidates) {
    if (splitterCount >= difficulty.splitters) {
      break;
    }

    const splitterX = cell.index % size;
    const splitterY = Math.floor(cell.index / size);
    const sides = rng.shuffle<Direction>([
      turnLeft(cell.travel),
      turnRight(cell.travel),
    ]);

    let placed = false;

    for (const sideDirection of sides) {
      const length = 1 + rng.int(3);
      const branch: number[] = [];

      for (let step = 1; step <= length; step += 1) {
        const bx = splitterX + DX[sideDirection] * step;
        const by = splitterY + DY[sideDirection] * step;

        if (!inBounds(bx, by) || occupied[by * size + bx]) {
          break;
        }

        branch.push(by * size + bx);
      }

      if (branch.length !== length) {
        continue;
      }

      const state = stateTurning(cell.travel, sideDirection);

      if (state === null) {
        continue;
      }

      for (const branchIndex of branch) {
        occupied[branchIndex] = true;
      }

      tiles[branch[branch.length - 1]] = { kind: "TARGET" };
      tiles[cell.index] = { kind: "SPLITTER", state };
      criticalIndexes.push(cell.index);
      placed = true;
      break;
    }

    if (placed) {
      splitterCount += 1;
    }
  }

  if (splitterCount < difficulty.splitters) {
    return null;
  }

  // Decoys and blockers on free cells. None of them touch the solved
  // beam path, so they never change the answer, only the look of the
  // puzzle and where a wrong beam can end up.
  const freeCells: number[] = [];

  for (let i = 0; i < cells; i += 1) {
    if (!occupied[i]) {
      freeCells.push(i);
    }
  }

  const shuffledFree = rng.shuffle(freeCells);
  let cursor = 0;

  for (let i = 0; i < difficulty.decoyMirrors && cursor < shuffledFree.length; i += 1) {
    const state: TileState = rng.chance(0.5) ? 1 : 0;
    tiles[shuffledFree[cursor]] = { kind: "MIRROR", state };
    cursor += 1;
  }

  for (let i = 0; i < difficulty.blockers && cursor < shuffledFree.length; i += 1) {
    tiles[shuffledFree[cursor]] = { kind: "BLOCKER" };
    cursor += 1;
  }

  const solvedBoard: Board = { width: size, height: size, tiles };

  if (!simulate(solvedBoard).solved) {
    return null;
  }

  // Scramble some of the tiles the beam path depends on.
  const minPar = Math.min(difficulty.minPar, criticalIndexes.length);
  const wanted = Math.round(
    criticalIndexes.length * (0.5 + rng.next() * 0.5),
  );
  const scrambleCount = Math.min(
    criticalIndexes.length,
    Math.max(minPar, wanted),
  );

  const solution = rng
    .shuffle(criticalIndexes)
    .slice(0, scrambleCount)
    .sort((a, b) => a - b);

  const initialTiles: Tile[] = tiles.map((tile) => ({ ...tile }));

  for (const index of solution) {
    const tile = initialTiles[index];
    tile.state = tile.state === 1 ? 0 : 1;
  }

  const initialBoard: Board = {
    width: size,
    height: size,
    tiles: initialTiles,
  };

  if (simulate(initialBoard).solved) {
    return null;
  }

  const targetTotal = tiles.filter((tile) => tile.kind === "TARGET").length;

  return {
    configuration: {
      version: LEVEL_GENERATOR_VERSION,
      width: size,
      height: size,
      tiles: initialTiles,
      parMoves: solution.length,
      solution,
    },
    score:
      difficulty.tier * 100 + criticalIndexes.length * 5 + targetTotal,
  };
}

function relaxedDifficulty(strict: Difficulty): Difficulty {
  return {
    ...strict,
    targets: 1,
    pathLength: Math.min(strict.pathLength, 10),
    minTurns: 2,
    splitters: 0,
    decoyMirrors: 0,
    blockers: 0,
    minPar: 2,
  };
}

/**
 * Generates level N. The same number always gives the same level.
 */
export function generateLevel(levelNumber: number): GeneratedLevel {
  const strict = difficultyFor(levelNumber);
  const seed = `lumen:v${LEVEL_GENERATOR_VERSION}:${levelNumber}`;

  for (let attempt = 0; attempt < STRICT_ATTEMPTS; attempt += 1) {
    const result = tryGenerate(strict, createRng(`${seed}:${attempt}`));

    if (result) {
      return {
        levelNumber,
        tier: strict.tier,
        difficultyScore: result.score,
        seed,
        configuration: result.configuration,
        attempts: attempt + 1,
        relaxed: false,
      };
    }
  }

  const relaxed = relaxedDifficulty(strict);

  for (let attempt = 0; attempt < RELAXED_ATTEMPTS; attempt += 1) {
    const result = tryGenerate(
      relaxed,
      createRng(`${seed}:relaxed:${attempt}`),
    );

    if (result) {
      return {
        levelNumber,
        tier: strict.tier,
        difficultyScore: result.score,
        seed,
        configuration: result.configuration,
        attempts: STRICT_ATTEMPTS + attempt + 1,
        relaxed: true,
      };
    }
  }

  throw new Error(`Could not generate level ${levelNumber}.`);
}

// ---------------------------------------------------------------------
// Stored configuration
// ---------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseTile(value: unknown): Tile | null {
  if (!isRecord(value)) {
    return null;
  }

  const { kind, direction, state } = value;

  switch (kind) {
    case "EMPTY":
    case "BLOCKER":
    case "TARGET":
      return { kind };
    case "EMITTER":
      if (
        direction === 0 ||
        direction === 1 ||
        direction === 2 ||
        direction === 3
      ) {
        return { kind, direction };
      }

      return null;
    case "MIRROR":
    case "SPLITTER":
      if (state === 0 || state === 1) {
        return { kind, state };
      }

      return null;
    default:
      return null;
  }
}

/**
 * Checks a level configuration read from storage and returns a clean
 * copy, or null if anything about it is wrong. Stored data is validated
 * instead of trusted.
 */
export function parseLevelConfiguration(
  value: unknown,
): LevelConfiguration | null {
  if (!isRecord(value)) {
    return null;
  }

  const { version, width, height, tiles, parMoves, solution } = value;

  if (version !== LEVEL_GENERATOR_VERSION) {
    return null;
  }

  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_BOARD_SIZE ||
    height < MIN_BOARD_SIZE ||
    width > MAX_BOARD_SIZE ||
    height > MAX_BOARD_SIZE
  ) {
    return null;
  }

  if (!Array.isArray(tiles) || tiles.length !== width * height) {
    return null;
  }

  const parsedTiles: Tile[] = [];

  for (const entry of tiles as unknown[]) {
    const tile = parseTile(entry);

    if (!tile) {
      return null;
    }

    parsedTiles.push(tile);
  }

  const emitters = parsedTiles.filter((tile) => tile.kind === "EMITTER");
  const targets = parsedTiles.filter((tile) => tile.kind === "TARGET");

  if (emitters.length === 0 || targets.length === 0) {
    return null;
  }

  if (
    typeof parMoves !== "number" ||
    !Number.isSafeInteger(parMoves) ||
    parMoves < 1 ||
    parMoves > MAX_MOVES
  ) {
    return null;
  }

  if (!Array.isArray(solution) || solution.length !== parMoves) {
    return null;
  }

  const seenMoves = new Set<number>();

  for (const move of solution as unknown[]) {
    if (
      typeof move !== "number" ||
      !Number.isSafeInteger(move) ||
      move < 0 ||
      move >= parsedTiles.length ||
      !isRotatable(parsedTiles[move]) ||
      seenMoves.has(move)
    ) {
      return null;
    }

    seenMoves.add(move);
  }

  return {
    version,
    width,
    height,
    tiles: parsedTiles,
    parMoves,
    solution: [...seenMoves],
  };
}

// ---------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------

export function starsFor(moves: number, parMoves: number): 1 | 2 | 3 {
  if (moves <= parMoves) {
    return 3;
  }

  if (moves <= Math.ceil(parMoves * 1.5) + 1) {
    return 2;
  }

  return 1;
}

/**
 * Replays a player's moves on the stored level and decides the result.
 *
 * elapsedMs must be measured by the server (time since the attempt
 * started), never taken from the client.
 *
 * A finished board cannot be faked: the result is computed here from the
 * moves. The time floor only rejects submissions that are faster than a
 * person can tap.
 */
export function verifySolution(
  level: LevelConfiguration,
  moves: readonly number[],
  elapsedMs: number,
): VerifyResult {
  if (moves.length === 0 || moves.length > MAX_MOVES) {
    return { ok: false, reason: "TOO_MANY_MOVES" };
  }

  const board: Board = {
    width: level.width,
    height: level.height,
    tiles: level.tiles,
  };

  const finished = applyMoves(board, moves);

  if (!finished) {
    return { ok: false, reason: "INVALID_MOVE" };
  }

  if (!simulate(finished).solved) {
    return { ok: false, reason: "NOT_SOLVED" };
  }

  const minimumTime =
    MIN_BASE_TIME_MS + moves.length * MIN_TIME_PER_MOVE_MS;

  if (!Number.isFinite(elapsedMs) || elapsedMs < minimumTime) {
    return { ok: false, reason: "TOO_FAST" };
  }

  return {
    ok: true,
    moves: moves.length,
    parMoves: level.parMoves,
    stars: starsFor(moves.length, level.parMoves),
  };
}

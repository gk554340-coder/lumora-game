# LUMORA Game Design and Economy

Status: approved design baseline. Numbers in the economy tables are
starting values. They live in reward definitions (data), not in code,
and are tuned from real play data.

## 1. Core puzzle: Lumen Paths

The player rotates mirrors and prisms on a grid to route a beam of light
from an emitter to every target node.

- A level is a grid of tiles: emitter, mirror, prism (splitter), blocker,
  target. Rotating a tile is one move.
- Levels are endless. Each level is generated from a seed. Difficulty
  grows in tiers:
  - Tier 1: 4x4, mirrors only.
  - Tier 2: 5x5, adds prisms that split the beam.
  - Tier 3: adds colored beams and filters.
  - Tier 4: adds portals.
  - Tier 5 and above: limited moves, larger grids, combined mechanics.
- Every 10th level is a milestone level. Every 50th level is a major
  milestone.
- A level takes 30 to 90 seconds. Restarting is instant. There are no
  lives, no energy and no waiting timers.

## 2. Server-authoritative play

The client is never trusted with results.

1. The client asks to start a level. The server records a LevelAttempt.
2. The client submits the ordered list of moves it made.
3. The server rebuilds the level from its seed, replays the moves, and
   checks that every target is lit.
4. The server rejects physically impossible submissions: fewer moves than
   the known optimum, or a completion time below the minimum plausible
   time for that move count.
5. The server computes stars from moves versus the optimum, then grants
   rewards. The client never sends a score, a star count or a reward.

## 3. Engagement loops

- Session loop: fast levels, instant restart, a visible next goal.
- Daily loop: a 7-day reward streak and a daily puzzle.
- Collection loop: levels award Lumen shards. Completing a prism set
  unlocks a permanent cosmetic and a small gem reward.
- Weekly loop (later): events and weekly star leaderboards.

## 4. Player protection

The audience includes children and teenagers.

- No randomized rewards that can be bought with real money.
- Every paid product shows exactly what it contains.
- No forced waiting and no lives system.
- Notifications are never sent during quiet hours.
- Rewarded ads are always optional and never block progress.

## 5. Currencies

- TOKEN: soft currency. Earned by playing. Spent on hints, boosters and
  common cosmetics.
- GEM: premium currency. Earned slowly and rarely in play, mainly
  purchased through Google Play Billing. Spent on special cosmetics.
- COIN exists in the database but is unused and must not be used.

## 6. Economy rules

1. Level rewards are paid on first completion only. A replay pays only
   the difference when it earns more stars than before.
2. Because income is bound to progression, it cannot grow faster than the
   player advances. This is the main inflation control.
3. All amounts live in reward definitions, so they can change without a
   release.
4. Wallet changes are ledger entries, applied at most once per
   idempotency key.
5. A reward is identified by (user, reward definition, source id). The
   database enforces that this combination exists only once.

### Starting values

| Source | Reward |
| --- | --- |
| First clear, 1 star | 10 tokens |
| First clear, 2 stars | 15 tokens |
| First clear, 3 stars | 20 tokens |
| Every 10th level | +50 tokens |
| Every 50th level | +5 gems |
| Daily reward, day 1 to 6 | 20, 25, 30, 35, 40, 50 tokens |
| Daily reward, day 7 | 100 tokens and 5 gems |

| Sink | Cost |
| --- | --- |
| Hint | 15 tokens |
| Booster | 40 tokens |

A player who clears 10 new levels in a day earns roughly 170 tokens plus
the daily reward, and spends a small part on hints. Gems earned for free
come to about 5 per week, so premium content stays worth buying.

## 7. Reward granting flow

1. Compute the deterministic source id (a date such as 2026-10-30 for a
   daily reward, or a level id for a level reward).
2. Insert a RewardGrant row. The unique key (user, definition, source)
   makes a repeat fail, which is the signal that the reward already
   exists.
3. Credit the wallet with idempotency key `reward:<grantId>`.
4. Mark the grant as GRANTED.

If the process stops between steps 2 and 4, a retry finds the pending
grant and completes it. The wallet key prevents a double credit.

## 8. Daily reward rules

- The day boundary is UTC.
- A claim on the day after the last claim continues the streak. A longer
  gap resets the streak to day 1.
- After day 7 the cycle restarts at day 1.
- One claim per day, enforced by the unique source id.

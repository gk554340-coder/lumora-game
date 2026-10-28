# LUMORA — MASTER DEVELOPMENT BLUEPRINT

## 1. Product Vision

LUMORA is a scalable, endless puzzle-adventure game designed for children,
teenagers, adults, and casual players.

Core experience:

Puzzle
→ Endless Levels
→ Increasing Difficulty
→ Discovery
→ Collection
→ Rewards
→ Token Economy
→ Events
→ Long-Term Progression

The game must not have a fixed final level.

After completing one level, the player continuously progresses to the next
level, while difficulty, complexity, challenges, and rewards evolve according
to the game progression system.

---

## 2. Core Product Principles

1. The game must be scalable.
2. Levels must be effectively endless.
3. Difficulty must increase progressively.
4. Game rules must be server-authoritative where required.
5. Rewards must never depend solely on client-side values.
6. Token balances must use an immutable transaction ledger.
7. Payments must be verified server-side.
8. Razorpay payment success must never be trusted directly from the client.
9. Important financial and reward operations must support idempotency.
10. Security and anti-abuse controls must be built into the architecture.
11. Database relationships must be designed before implementation.
12. Existing architecture must not be unnecessarily rewritten.
13. Each module must have a clear responsibility.
14. Future features must be possible without redesigning the core foundation.

---

## 3. Backend Architecture

Canonical startup:

package.json
    ↓
src/index.ts
    ↓
src/app.ts
    ↓
configuration + plugins + routes
    ↓
services
    ↓
database

There must be only one canonical application startup path.

---

## 4. Backend Structure

Backend/
├── prisma/
│   └── schema.prisma
│
├── src/
│   ├── config/
│   │   ├── env.ts
│   │   └── database.ts
│   │
│   ├── errors/
│   │   └── AppError.ts
│   │
│   ├── plugins/
│   │   └── error-handler.ts
│   │
│   ├── routes/
│   │   ├── index.ts
│   │   └── health.ts
│   │
│   ├── types/
│   │   └── index.ts
│   │
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── game/
│   │   ├── levels/
│   │   ├── rewards/
│   │   ├── wallet/
│   │   ├── payments/
│   │   ├── inventory/
│   │   ├── events/
│   │   ├── achievements/
│   │   ├── leaderboard/
│   │   ├── notifications/
│   │   └── admin/
│   │
│   ├── app.ts
│   └── index.ts
│
├── package.json
└── LUMORA_MASTER_BLUEPRINT.md

The obsolete duplicate server entry point must not be retained.

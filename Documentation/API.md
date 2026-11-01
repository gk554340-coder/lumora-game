# LUMORA Backend API

This is the contract between the game client and the server. All paths
start with `/api`. The server decides everything that matters (results,
stars, rewards, prices, ownership). The client only asks.

Admin endpoints are not part of this document. They are described in
`DEPLOYMENT.md`.

## Conventions

### Authentication

Register or log in to get a session token. Send it on every protected
request:

```
Authorization: Bearer <token>
```

- Tokens are valid for the server's session lifetime (7 days by
  default). `expiresAt` tells the client when.
- Without a header, or with a header that does not start with `Bearer `,
  the server answers `401 UNAUTHORIZED`.
- A token that is wrong, expired or revoked, or an account that is not
  active, gives `401 INVALID_SESSION`. The client should send the player
  to the login screen.
- Every protected endpoint can return these two errors, so they are not
  repeated below.

### Responses

Success:

```json
{ "success": true, "data": { } }
```

`POST /api/auth/logout` answers `{ "success": true, "message": "..." }`
with no `data`.

Error:

```json
{ "success": false, "error": { "code": "LEVEL_LOCKED", "message": "..." } }
```

Always act on `code`. Messages are for humans and can change.

| Status | Code                    | Meaning                                              |
| ------ | ----------------------- | ---------------------------------------------------- |
| 400    | `VALIDATION_ERROR`      | The request body or query is malformed. No details.  |
| 429    | `RATE_LIMIT_EXCEEDED`   | Too many requests. Wait and retry.                   |
| 500    | `INTERNAL_SERVER_ERROR` | Server fault. Do not log the player out.             |

Other errors have their own codes, listed per endpoint.

### Formats

- Dates are ISO 8601 strings in UTC, for example
  `2026-11-02T10:15:30.123Z`. Days and weeks are UTC.
- Ids are UUIDs.
- Currencies are `TOKEN` (soft) and `GEM` (premium). Amounts are whole
  numbers.
- Lists that continue use a `cursor`. Send back the `nextCursor` from
  the previous response, exactly as received. `nextCursor` is `null` on
  the last page.

### Limits

| Limit                                  | Value                          |
| -------------------------------------- | ------------------------------ |
| Moves per submission                   | 1 to 400                       |
| Level number                           | 1 to 1,000,000                 |
| Attempt lifetime                       | 24 hours                       |
| Hint cost                              | 15 TOKEN                       |
| Hints per attempt                      | 10                             |
| Register and login                     | 10 per minute per client       |
| Shop purchase, Google Play verify      | 30 per minute per client       |
| Wallet history page size               | default 20, max 100            |
| Leaderboard page size                  | default 20, max 100            |
| Notification page size                 | default 20, max 50             |
| Highest wallet balance                 | 2,147,483,647                  |

## Health

### GET /api/health

No authentication.

```json
{ "status": "ok", "service": "LUMORA Backend", "version": "0.1.0" }
```

## Auth

### POST /api/auth/register

Creates the account and logs the player in. Status `201`.

Body: `email` (valid address, up to 320), `password` (12 to 128
characters), `username` (optional, 3 to 32 of `A-Z a-z 0-9 _`).
Unknown fields are rejected.

```json
{
  "user": { "id": "uuid", "email": "a@b.com", "username": "player_1" },
  "token": "q3Zk...",
  "expiresAt": "2026-11-09T10:15:30.123Z"
}
```

`username` is `null` when it was not given. The email is stored in
lowercase.

Errors: `409 ACCOUNT_ALREADY_EXISTS`, `400 VALIDATION_ERROR`,
`429 RATE_LIMIT_EXCEEDED`.

### POST /api/auth/login

Body: `email`, `password`. Same response as register.

Errors: `401 INVALID_CREDENTIALS` (also for an unknown email),
`403 ACCOUNT_UNAVAILABLE` (suspended or deleted account),
`429 RATE_LIMIT_EXCEEDED`.

### GET /api/auth/me

```json
{
  "id": "uuid",
  "email": "a@b.com",
  "username": "player_1",
  "status": "ACTIVE",
  "createdAt": "2026-10-01T08:00:00.000Z"
}
```

Error: `401 ACCOUNT_UNAVAILABLE` if the account is no longer active.

### POST /api/auth/logout

Ends the current session. Answers `{ "success": true, "message": "Logged out successfully." }`.

## Levels

Play loop: **start** a level, play locally, then **submit** the moves.
The server replays the moves and decides the result. A level can be
opened when its number is at most `nextLevel`.

### GET /api/levels/progress

```json
{ "nextLevel": 12, "completedLevels": 11, "totalStars": 29 }
```

### POST /api/levels/:levelNumber/start

No body. Status `201`. Starting a level closes any older open attempt
of the same level.

```json
{
  "attemptId": "uuid",
  "startedAt": "2026-11-02T10:15:30.123Z",
  "bestStars": 0,
  "level": {
    "levelNumber": 12,
    "tier": 2,
    "width": 5,
    "height": 5,
    "parMoves": 6,
    "tiles": [
      { "kind": "EMITTER", "direction": 1 },
      { "kind": "MIRROR", "direction": 0, "state": 0 },
      { "kind": "EMPTY" }
    ]
  }
}
```

- `bestStars` is 0 to 3 (0 means never completed).
- `tiles` is row by row and has `width * height` entries. The tile at
  index `i` is at `x = i % width`, `y = floor(i / width)`.
- `kind` is one of `EMPTY`, `EMITTER`, `MIRROR`, `SPLITTER`, `BLOCKER`,
  `TARGET`. `direction` (optional) is 0 north, 1 east, 2 south, 3 west.
  `state` (optional) is 0 or 1.
- The solution is never sent.

Errors: `400 INVALID_LEVEL`, `403 LEVEL_LOCKED` (number above
`nextLevel`), `404 LEVEL_NOT_FOUND`, `500 LEVEL_CORRUPT`.

### POST /api/levels/attempts/:attemptId/submit

Body: `{ "moves": [7, 3, 12] }`. Each move is the index of the tile that
was flipped, in order. 1 to 400 moves. The client sends moves only, never
the result.

```json
{
  "levelNumber": 12,
  "moves": 6,
  "parMoves": 6,
  "stars": 3,
  "score": 3094,
  "timeMs": 18423,
  "newBestStars": true,
  "rewards": [ { "currency": "TOKEN", "amount": 20 } ],
  "nextLevel": 13,
  "achievements": [
    {
      "code": "first_light",
      "name": "First Light",
      "rewards": [ { "currency": "TOKEN", "amount": 10 } ]
    }
  ]
}
```

- Stars: 3 if `moves <= parMoves`, 2 if `moves <= ceil(parMoves * 1.5) + 1`,
  otherwise 1. A wrong solution is an error, never 0 stars.
- `score = stars * 1000 + max(0, 100 - moves)`.
- `timeMs` is measured by the server.
- `rewards` lists only what was paid in this call. Each (level, star) pays
  once, so a replay returns `[]`.
- `achievements` lists achievements completed by this submission. It is
  `[]` most of the time.

Errors: `404 ATTEMPT_NOT_FOUND`, `409 ATTEMPT_CLOSED` (already completed
or replaced), `409 ATTEMPT_EXPIRED`, `400 MOVES_INVALID`,
`422 LEVEL_NOT_SOLVED`, `422 SUBMISSION_TOO_FAST`.

### POST /api/levels/attempts/:attemptId/hint

Body: `{ "moves": [7, 3] }`, the moves made so far (may be empty). The
server names the next tile to flip and charges 15 TOKEN.

```json
{
  "tile": 7,
  "x": 2,
  "y": 1,
  "cost": 15,
  "tokenBalance": 185,
  "hintsUsed": 1,
  "hintsRemaining": 9
}
```

Asking again for the same position costs nothing (`cost` is 0). Hints do
not change the stars.

Errors: `404 ATTEMPT_NOT_FOUND`, `409 ATTEMPT_CLOSED`,
`409 ATTEMPT_EXPIRED`, `400 MOVES_INVALID`, `409 HINT_NOT_NEEDED` (the
level is already solved, submit it), `409 HINT_LIMIT_REACHED`,
`409 INSUFFICIENT_FUNDS`.

## Daily reward

The day changes at 00:00 UTC. The cycle is 7 days. Missing a day resets
the streak.

### GET /api/rewards/daily

```json
{
  "claimedToday": false,
  "canClaim": true,
  "streak": 3,
  "nextCycleDay": 4,
  "rewards": [ { "currency": "TOKEN", "amount": 35 } ],
  "resetsAt": "2026-11-03T00:00:00.000Z"
}
```

`rewards` is what the next claim pays. If `claimedToday` is true,
`nextCycleDay` is tomorrow's day.

### POST /api/rewards/daily/claim

No body.

```json
{
  "claimed": true,
  "streak": 4,
  "cycleDay": 4,
  "rewards": [ { "currency": "TOKEN", "amount": 35 } ],
  "resetsAt": "2026-11-03T00:00:00.000Z",
  "achievements": []
}
```

Claiming twice on the same day is not an error. It answers `200` with
`claimed: false` and the amounts that were paid earlier.

Error: `409 DAILY_CLAIM_CONFLICT` (a race that did not settle, retry).

## Wallet

The wallet is read-only for the client. It changes only through
server-side events.

### GET /api/wallet

```json
{ "tokenBalance": 450, "gemBalance": 12 }
```

### GET /api/wallet/transactions

Query (all optional): `limit` (1 to 100), `cursor`, `currency`
(`TOKEN` or `GEM`). Newest first.

```json
{
  "items": [
    {
      "id": "uuid",
      "currency": "TOKEN",
      "type": "DEBIT",
      "source": "GAMEPLAY",
      "amount": 15,
      "balanceAfter": 435,
      "description": "Level hint",
      "createdAt": "2026-11-02T10:20:00.000Z"
    }
  ],
  "nextCursor": null
}
```

- `type` is `CREDIT` or `DEBIT`. `amount` is always positive.
- `source` is one of `GAMEPLAY`, `REWARD`, `PURCHASE`, `BONUS`, `REFUND`,
  `REVERSAL`, `ADMIN`, `EVENT`, `ACHIEVEMENT`, `SYSTEM`.
- `description` can be `null`.

## Leaderboards

`displayName` is the player's display name, else the username, else
`Player` plus the first 6 characters of the id. Emails and ids of other
players are never sent.

### GET /api/leaderboards/global?limit=20

Ranked by total stars.

```json
{
  "entries": [
    { "rank": 1, "displayName": "star_queen", "totalStars": 210, "completedLevels": 78, "isYou": false }
  ],
  "you": { "rank": 342, "totalStars": 29, "completedLevels": 11 }
}
```

`you` is `null` until the player completes a level.

### GET /api/leaderboards/levels/:levelNumber?limit=20

Ranked by best score, then fastest time.

```json
{
  "levelNumber": 12,
  "entries": [
    { "rank": 1, "displayName": "star_queen", "stars": 3, "score": 3098, "timeMs": 9120, "isYou": false }
  ],
  "you": { "rank": 5, "stars": 3, "score": 3094, "timeMs": 18423 }
}
```

`you` is `null` if the player has not completed the level. `timeMs` can
be `null`.

Errors (both): `400 INVALID_LIMIT`. Level board also: `400 INVALID_LEVEL`,
`404 LEVEL_NOT_FOUND`.

## Achievements

### GET /api/achievements

Checks all achievements first, so a reward earned since the last call is
paid by this call. The full list is returned every time.

```json
{
  "achievements": [
    {
      "code": "pathfinder_10",
      "name": "Pathfinder",
      "description": "Complete 10 levels.",
      "status": "IN_PROGRESS",
      "progress": 4,
      "target": 10,
      "reward": [ { "currency": "TOKEN", "amount": 50 } ]
    }
  ],
  "newlyCompleted": [
    {
      "code": "star_collector_50",
      "name": "Star Collector",
      "rewards": [ { "currency": "TOKEN", "amount": 40 } ]
    }
  ]
}
```

- `status` is `LOCKED` (no progress), `IN_PROGRESS` or `COMPLETED`.
- Note the key names: here the list uses `reward`, while `newlyCompleted`
  and the `achievements` array of submit and daily claim use `rewards`.

## Events

One weekly event, "Weekly Light Rush", runs from Monday 00:00 UTC to the
next Monday and is created automatically. The score is the best score for
each level the player completes for the **first time** during the week.
Replaying old levels adds nothing. Rewards are paid after the event ends
and arrive with a notification.

### GET /api/events/current

```json
{
  "event": {
    "id": "uuid",
    "name": "Weekly Light Rush",
    "description": "Complete new levels this week. The best scores win rewards.",
    "startsAt": "2026-11-02T00:00:00.000Z",
    "endsAt": "2026-11-09T00:00:00.000Z",
    "secondsLeft": 512340
  },
  "rewardTable": [
    { "fromRank": 1, "toRank": 1, "rewards": [ { "currency": "GEM", "amount": 50 }, { "currency": "TOKEN", "amount": 300 } ] },
    { "fromRank": 101, "toRank": null, "rewards": [ { "currency": "TOKEN", "amount": 50 } ] }
  ],
  "me": { "rank": 7, "score": 6150, "levels": 3 }
}
```

`toRank: null` means "and everyone below". `me` is `null` if the player
has no score this week.

### GET /api/events/:eventId/leaderboard?limit=20

```json
{
  "event": { "id": "uuid", "name": "Weekly Light Rush", "startsAt": "ISO", "endsAt": "ISO", "status": "ACTIVE" },
  "entries": [
    { "rank": 1, "displayName": "star_queen", "score": 9300, "levels": 5, "isYou": false }
  ],
  "me": { "rank": 7, "displayName": "player_1", "score": 6150, "levels": 3, "isYou": true }
}
```

`status` is one of `DRAFT`, `SCHEDULED`, `ACTIVE`, `COMPLETED`,
`CANCELLED`. `me` is filled even when the player is outside the top
`limit`.

Errors: `400 INVALID_LIMIT`, `404 EVENT_NOT_FOUND`.

## Shop and inventory

Items are cosmetics bought with gems. An item is bought once. Each slot
(`light_color`, `board_theme`) holds one equipped item at a time.

### GET /api/shop

```json
{
  "gemBalance": 120,
  "items": [
    {
      "sku": "board_dawn",
      "name": "Dawn Board",
      "description": "A soft board in sunrise colors.",
      "type": "COSMETIC",
      "slot": "board_theme",
      "gemPrice": 80,
      "owned": false,
      "equipped": false
    }
  ]
}
```

### POST /api/shop/purchase

Body: `{ "sku": "board_dawn" }`.

```json
{ "sku": "board_dawn", "gemPrice": 80, "balances": { "tokenBalance": 450, "gemBalance": 40 } }
```

Errors: `404 ITEM_NOT_FOUND`, `409 ITEM_NOT_FOR_SALE`,
`409 ITEM_ALREADY_OWNED`, `409 INSUFFICIENT_FUNDS`.

### GET /api/inventory

```json
{
  "items": [
    { "sku": "board_dawn", "name": "Dawn Board", "type": "COSMETIC", "slot": "board_theme", "quantity": 1, "equipped": true }
  ]
}
```

### POST /api/inventory/equip

Body: `{ "sku": "board_dawn" }`. The item already equipped in the same slot
is unequipped.

```json
{ "sku": "board_dawn", "slot": "board_theme", "equipped": true }
```

Errors: `404 ITEM_NOT_FOUND`, `403 ITEM_NOT_OWNED`,
`409 ITEM_NOT_EQUIPPABLE`.

### POST /api/inventory/unequip

Body: `{ "slot": "board_theme" }`.

```json
{ "slot": "board_theme", "unequipped": 1 }
```

`unequipped` is 0 when nothing was equipped. That is not an error.

## Notifications

An in-app inbox. The server creates the messages (today: weekly event
results). `type` is one of `SYSTEM`, `REWARD`, `EVENT`, `PROGRESSION`,
`SECURITY`, `PROMOTION`.

### GET /api/notifications

Query (all optional): `limit` (1 to 50), `cursor`, `unreadOnly`
(`true` or `false`). Newest first.

```json
{
  "items": [
    {
      "id": "uuid",
      "type": "EVENT",
      "title": "Weekly Light Rush results",
      "message": "You finished in place 7. Your reward was added to your wallet.",
      "data": { "eventId": "uuid", "rank": 7, "score": 6150 },
      "read": false,
      "createdAt": "2026-11-09T00:05:00.000Z"
    }
  ],
  "nextCursor": null
}
```

`data` is a flat object of strings, numbers, booleans or null. Its keys
depend on the message and it can be empty.

Errors: `400 INVALID_LIMIT`, `400 INVALID_CURSOR`.

### GET /api/notifications/unread-count

```json
{ "unread": 3 }
```

### POST /api/notifications/read-all

```json
{ "updated": 3 }
```

### POST /api/notifications/:id/read

```json
{ "id": "uuid", "read": true }
```

Marking a message that is already read is not an error.

Error: `404 NOTIFICATION_NOT_FOUND` (also for another player's message).

## Payments (Google Play)

The price a player pays is set in Play Console. The server only checks
the purchase with Google and grants the gems once.

Purchase flow:

1. `GET /api/payments/products` to show the products.
2. `GET /api/payments/google-play/account-id`, then pass `accountId` to
   Google as the obfuscated account id when starting the purchase.
3. After Google confirms payment, send the purchase token to
   `POST /api/payments/google-play/verify`.
4. If `consumed` is `false`, send the same token again later. The server
   retries the consume step and never grants the gems twice.

### GET /api/payments/products

```json
{
  "enabled": true,
  "products": [
    {
      "sku": "lumora_gems_60",
      "name": "Handful of Gems",
      "gemAmount": 60,
      "tokenAmount": 0,
      "referencePrice": { "currency": "INR", "minorUnit": 4900 }
    }
  ]
}
```

`enabled` is `false` when payments are not configured on the server.
`referencePrice` is only a reference. Show the price that Google Play
reports.

### GET /api/payments/google-play/account-id

```json
{ "accountId": "k3Jx..." }
```

Error: `503 PAYMENTS_NOT_CONFIGURED`.

### POST /api/payments/google-play/verify

Body: `{ "sku": "lumora_gems_60", "purchaseToken": "<token from Google>" }`.

```json
{
  "purchaseId": "uuid",
  "sku": "lumora_gems_60",
  "status": "COMPLETED",
  "granted": { "gems": 60, "tokens": 0 },
  "balances": { "tokenBalance": 450, "gemBalance": 72 },
  "consumed": true,
  "replayed": false
}
```

`replayed: true` means this token was already processed. The gems are not
granted again.

Errors:

| Status | Code                           | Meaning                                              |
| ------ | ------------------------------ | ---------------------------------------------------- |
| 503    | `PAYMENTS_NOT_CONFIGURED`      | Payments are off on this server.                     |
| 404    | `PRODUCT_NOT_FOUND`            | Unknown product.                                     |
| 409    | `PURCHASE_TOKEN_IN_USE`        | The token belongs to another account.                |
| 422    | `PURCHASE_INVALID`             | Not paid, wrong product, refunded or not accepted.   |
| 409    | `PURCHASE_PENDING`             | Google still shows the payment as pending. Retry.    |
| 403    | `PURCHASE_ACCOUNT_MISMATCH`    | The purchase was made for a different player.        |
| 502    | `PAYMENT_PROVIDER_ERROR`       | Google refused the check.                            |
| 503    | `PAYMENT_PROVIDER_UNAVAILABLE` | Google could not be reached. Retry later.            |

## Other errors you may see

| Status | Code                      | Where                                              |
| ------ | ------------------------- | -------------------------------------------------- |
| 409    | `INSUFFICIENT_FUNDS`      | Hint, shop purchase.                               |
| 409    | `BALANCE_LIMIT_EXCEEDED`  | A reward would pass the highest balance.           |
| 409    | `REWARD_UNAVAILABLE`      | A reward could not be paid. Retry.                 |
| 500    | `REWARD_CONFIGURATION_INVALID` | Server reward setup is wrong. Report it.      |

## Known limitations

- The `rewardTable` of `GET /api/events/current` shows the built-in reward
  amounts. If the amounts are ever changed in the database, the table can
  differ from what is really paid.
- Rewards can be tuned in the database, so the amounts in the examples
  above are the defaults, not guarantees.

# Deployment

The backend ships as one Docker image with two targets:

| Target    | Purpose                                      |
| --------- | -------------------------------------------- |
| `migrate` | Applies database migrations, then exits.     |
| `runtime` | The API server. This is the default target.  |

Both are built from `Backend/Dockerfile`.

## Run everything locally

Requires Docker with Compose.

```bash
cd Backend
docker compose up --build
```

This starts PostgreSQL, applies the migrations, then starts the API.
Check it at `http://localhost:3000/api/health`.

The database password in `docker-compose.yml` is for local use only.

## Environment variables

Set these on the `runtime` container. See `Backend/.env.example` for
the full list.

Only `DATABASE_URL` must always be provided. The image ships safe
defaults for the others, listed below, and each can be overridden.

| Variable                                    | Default in the image | Notes                                                    |
| ------------------------------------------- | -------------------- | -------------------------------------------------------- |
| `DATABASE_URL`                              | none, required       | PostgreSQL connection string. Keep it in a secret store. |
| `NODE_ENV`                                  | `production`         |                                                          |
| `SESSION_TOKEN_BYTES`                       | `32`                 | Random bytes in a session token.                         |
| `SESSION_TTL_SECONDS`                       | `604800` (7 days)    | How long a session lasts.                                |
| `SESSION_MAX_TOKEN_LENGTH`                  | `1024`               | Longest token the server will read.                      |
| `SESSION_LAST_USED_UPDATE_INTERVAL_SECONDS` | `300`                | How often "last used" is saved.                          |
| `RATE_LIMIT_MAX`                            | `100`                | Requests per window per client.                          |
| `RATE_LIMIT_TIME_WINDOW_MS`                 | `60000`              | Length of the rate limit window.                         |
| `AUTH_RATE_LIMIT_MAX`                       | `10`                 | Register and login attempts per window.                  |
| `AUTH_RATE_LIMIT_TIME_WINDOW_MS`            | `60000`              | Window for the stricter auth limit.                      |
| `PORT`                                      | `3000`               |                                                          |
| `CORS_ORIGIN`                               | none                 | Exact origins, comma separated, no trailing slash.       |
| `TRUST_PROXY`                               | `false`              | Set `true` only behind a trusted proxy or load balancer. |
| `LOG_LEVEL`                                 | `info`               |                                                          |
| `ADMIN_API_KEY`                             | none                 | Turns the admin endpoints on. See "Admin access".        |
| `ADMIN_RATE_LIMIT_MAX`                      | `20`                 | Admin requests per minute per client (1 to 10000).       |

Never put secrets in the image or in the repository.

## Google Play payments

Payments are optional. Without the three settings below the server runs
normally and the payment endpoints answer `503 PAYMENTS_NOT_CONFIGURED`.
Set all three together. If only some are set, the server refuses to
start, so a half-configured production never runs by accident.

| Variable                           | Default            | Notes                                                                                                   |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `GOOGLE_PLAY_PACKAGE_NAME`         | none               | Package name of the Android app.                                                                        |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | none               | Service account key, as raw JSON or base64 of the JSON. Keep it in a secret store.                      |
| `GOOGLE_PLAY_ACCOUNT_SECRET`       | none               | Random secret, at least 32 characters. Never change it after launch, or old purchases cannot be matched. |
| `GOOGLE_PLAY_ALLOW_TEST_PURCHASES` | `true` outside production, `false` in production | Accept Google test purchases.                                      |

Setting up Google Play, once:

1. In Play Console, create the in-app products with the same ids as the
   server catalog: `lumora_gems_60`, `lumora_gems_150`,
   `lumora_gems_400`, `lumora_gems_1000`. The price players pay is the
   one set in Play Console.
2. In Google Cloud, create a service account and a JSON key. In Play
   Console, give that account access to the app, with permission to view
   financial data and manage orders.
3. Set the three variables above on the `runtime` container.
4. Make one test purchase with a licensed test account and check that
   the gems arrive.

How a purchase works: the app asks `GET /api/payments/google-play/account-id`
and passes that id to Google when it starts the purchase. After paying,
the app sends the purchase token to `POST /api/payments/google-play/verify`.
The server checks it with Google, adds the gems once and then consumes
the purchase so it can be bought again.

## Scheduled jobs

Three jobs must run on a schedule. Run each one with the same image and
environment as the `runtime` container. Each prints one JSON line with
the counts, exits with code 1 when something failed (so the scheduler can
alert you), and is safe to run any number of times.

| Job                  | Command                                       | How often  |
| -------------------- | --------------------------------------------- | ---------- |
| Event rewards        | `node dist/scripts/finalize-events.js`        | Every hour |
| Refund sync          | `node dist/scripts/sync-voided-purchases.js`  | Every day  |
| Notification cleanup | `node dist/scripts/purge-notifications.js`    | Every day  |

If a job fails, the next run tries again. Nothing is paid, taken back or
deleted twice.

### Event rewards

Weekly events run from Monday to Monday (UTC) and are created
automatically. When an event has ended, this job pays the rank rewards
and sends each player a notification with the result. Without this job,
ended events never pay out.

### Refunds

When Google refunds or charges back a purchase, the gems must be taken
back. The refund sync job asks Google for refunded purchases and takes
back only the gems still in the wallet. What the player already spent is
not recovered, and the missing amount is saved on the payment record
under `metadata.refund` so support can see it. The admin endpoint
`GET /api/admin/refunds/unrecovered` lists these cases.

Optional: `VOIDED_PURCHASES_LOOKBACK_DAYS` (1 to 30, default 28).

### Notification cleanup

Deletes notifications that players have already read and that are older
than the retention period. Unread notifications are never deleted.
Without this job the notification table only grows.

Optional: `NOTIFICATION_RETENTION_DAYS` (1 to 3650, default 90).

## Admin access

Admin endpoints help support: look up a player, suspend or reactivate
an account, adjust a wallet by hand, and list refunds that could not be
taken back in full. They are protected by one secret key.

- Without `ADMIN_API_KEY` the admin endpoints do not exist (they answer
  `404`).
- The key must be at least 32 random characters. A shorter key stops the
  server from starting.
- Send the key in the `x-admin-key` header.
- Every admin change is written to the audit log with its reason.
- Admin requests have their own strict rate limit
  (`ADMIN_RATE_LIMIT_MAX`, default 20 per minute).

Create a key with:

```bash
openssl rand -base64 48
```

Keep the key in a secret store, never in the repository. To change it,
set a new value and restart the server.

Where possible, also allow `/api/admin/` only from your own network at
the reverse proxy, so the admin endpoints are not reachable from the
public internet.

Endpoints:

| Method | Path                                      | Purpose                                  |
| ------ | ----------------------------------------- | ---------------------------------------- |
| GET    | `/api/admin/users/lookup?email=` or `?id=` | Account, wallet and activity summary.    |
| POST   | `/api/admin/users/:id/suspend`            | Suspend and log the player out. Needs `reason`. |
| POST   | `/api/admin/users/:id/reactivate`         | Allow the player to log in again. Needs `reason`. |
| POST   | `/api/admin/users/:id/wallet-adjust`      | Add or remove TOKEN or GEM. Needs `currency`, `direction`, `amount`, `reason`, `requestId`. |
| GET    | `/api/admin/refunds/unrecovered?limit=`   | Refunds that were only partly taken back. |

For a wallet adjustment, send a new unique `requestId` each time. Sending
the same `requestId` again does not apply the change twice, so a retry
after a network error is safe. One adjustment is limited to 100000.

Example:

```bash
curl -X POST https://api.example.com/api/admin/users/<userId>/wallet-adjust \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"currency":"GEM","direction":"CREDIT","amount":25,"reason":"Compensation for a bug","requestId":"fix-2026-11-02-001"}'
```

## Releasing a version

1. Build both images from the same commit.

   ```bash
   docker build --target migrate --tag lumora-migrate:<version> Backend
   docker build --tag lumora-backend:<version> Backend
   ```

2. Take a database backup.
3. Run the `migrate` image once with `DATABASE_URL` set. It must exit
   with code 0.
4. Start the new `runtime` image and wait for `/api/health` to answer.
5. Stop the old `runtime` container. The server finishes in-flight
   requests when it receives `SIGTERM`.

Migrations only move forward. To undo a release, restore the backup or
ship a new migration that reverses the change. Write migrations so that
the previous version of the server keeps working while they are applied.

## Notes

- Terminate HTTPS at a reverse proxy or load balancer in front of the
  API, and set `TRUST_PROXY=true` there so rate limits use the real
  client address.
- The image has a built-in health check that calls `/api/health`.
- Run more than one API container for availability. The server keeps no
  state of its own, so all of them can share one database.
- `package-lock.json` is committed. CI and Docker both use `npm ci`, so
  every build installs exactly the same packages. To refresh the lock
  file, run the "Generate package-lock" workflow from the Actions tab.

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

### Refunds

When Google refunds or charges back a purchase, the gems must be taken
back. Run this once a day, using the same image and environment as the
`runtime` container:

```bash
node dist/scripts/sync-voided-purchases.js
```

It prints one JSON line with the counts, and exits with code 1 if it
fails. It is safe to run any number of times. It takes back only the
gems still in the wallet. What the player already spent is not
recovered, and the missing amount is saved on the payment record under
`metadata.refund` so support can see it.

Optional: `VOIDED_PURCHASES_LOOKBACK_DAYS` (1 to 30, default 28).

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


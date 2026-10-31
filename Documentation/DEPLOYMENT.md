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

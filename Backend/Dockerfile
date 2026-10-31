# syntax=docker/dockerfile:1

# LUMORA backend image.
#
# Targets
#   migrate  applies database migrations, then exits
#   runtime  the API server (default, last stage)
#
#   docker build --target migrate -t lumora-migrate .
#   docker build -t lumora-backend .

FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Full dependencies, compiled application and the Prisma tools.
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
# Generating the Prisma client reads the config but never connects, so a
# placeholder URL is enough here. It is not kept in the image.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npm run build

# Applies migrations. DATABASE_URL must be provided when it runs.
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# Production dependencies only.
FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run as the unprivileged user that ships with the Node image.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Start node directly so it receives SIGTERM and shuts down gracefully.
CMD ["node", "dist/index.js"]

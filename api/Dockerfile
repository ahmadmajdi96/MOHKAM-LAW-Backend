# syntax=docker/dockerfile:1.9

# ---------------------------------------------------------------- deps stage
# Split from the build so dependency layers cache across source edits.
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

FROM oven/bun:1.2-alpine AS deps-full
WORKDIR /app
COPY package.json bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# --------------------------------------------------------------- build stage
FROM deps-full AS build
WORKDIR /app
COPY . .
RUN bun run typecheck

# --------------------------------------------------------------- run stage
FROM oven/bun:1.2-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# curl is used by nothing at runtime; the healthcheck is a bun script instead,
# keeping the image free of a shell-accessible HTTP client.
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .

USER app
EXPOSE 3000

# Bun handles SIGTERM; the app drains connections in its shutdown hook.
STOPSIGNAL SIGTERM

CMD ["bun", "src/index.ts"]

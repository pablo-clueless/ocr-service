# syntax=docker/dockerfile:1
#
# Multi-stage build for the Heirs OCR service.
# One image, two runnable process types (12-factor VIII — concurrency):
#   web    → node build/index.js    (default CMD)
#   worker → node build/worker.js    (override the command; see docker-compose.yml)
#
# Config is supplied at runtime via the environment (12-factor III). No .env is
# baked in — see .env.example for the full set validated by src/config/env.ts.

# ---- base: Node + pnpm via corepack --------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---- build: full deps + compile TypeScript -------------------------------
FROM base AS build
# Manifests + the preinstall guard first, so the install layer is cached until
# dependencies actually change. pnpm-workspace.yaml carries the build-script
# allowlist (allowBuilds) needed by tesseract.js / msgpackr-extract.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# ---- prod-deps: production-only node_modules -----------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --prod

# ---- runtime: minimal image, non-root ------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

# Only production deps and the compiled output — no toolchain, no source.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/build        ./build
# Static admin console (served by the app at /admin).
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./

# Run as the image's built-in unprivileged user.
USER node
EXPOSE 8080

# Liveness probe hits the app's own /healthz using Node (no curl in -slim).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Default process type is the API server. Run the worker by overriding the command:
#   docker run --rm ocr-service node build/worker.js
CMD ["node", "build/index.js"]

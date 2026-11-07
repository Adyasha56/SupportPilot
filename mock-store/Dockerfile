# syntax=docker/dockerfile:1
#
# Demo-profile only (docker-compose.yml's `demo` profile) - never part of the
# API image (apps/api/Dockerfile deliberately never copies or builds
# mock-store at all). Mirrors that Dockerfile's own multi-stage pattern
# exactly, built from its own package so the API image's production
# surface never grows just to support a local demo.

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY mock-store/package.json mock-store/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY mock-store mock-store
RUN pnpm --filter @supportpilot/shared run build
RUN pnpm --filter @supportpilot/mock-store run build
RUN pnpm --filter @supportpilot/mock-store deploy --prod /app/deploy/mock-store

FROM base AS runtime
RUN addgroup -S nodejs && adduser -S mockstore -G nodejs
COPY --from=build /app/deploy/mock-store ./
USER mockstore
EXPOSE 4100
CMD ["node", "dist/server.js"]

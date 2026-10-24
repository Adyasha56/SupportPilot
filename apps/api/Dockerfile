# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN pnpm --filter @supportpilot/api run build
RUN pnpm --filter @supportpilot/api deploy --prod /app/deploy/api

FROM base AS runtime
RUN addgroup -S nodejs && adduser -S nestjs -G nodejs
COPY --from=build /app/deploy/api ./
USER nestjs
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/main.js"]

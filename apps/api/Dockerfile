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
RUN echo "--- apps/api/dist after build ---" && find apps/api/dist -type f || echo "apps/api/dist MISSING after build"
RUN pnpm --filter @supportpilot/api deploy --prod /app/deploy/api
RUN echo "--- /app/deploy/api/dist after deploy ---" && find /app/deploy/api/dist -type f || echo "/app/deploy/api/dist MISSING after deploy"

FROM base AS runtime
RUN addgroup -S nodejs && adduser -S nestjs -G nodejs
COPY --from=build /app/deploy/api ./
USER nestjs
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/main.js"]

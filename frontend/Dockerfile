# syntax=docker/dockerfile:1
FROM node:22-slim AS base
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PNPM_VERSION=10.33.0
ENV npm_config_registry=${NPM_REGISTRY}
RUN --mount=type=cache,target=/root/.npm npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
# NEXT_PUBLIC_* 在构建时写进产物，所以它们是构建参数；构建阶段拿不到任何密钥，BACKEND_JWT_SECRET 等由 compose 在运行时提供
ARG NEXT_PUBLIC_DEFAULT_THEME=system
ARG NEXT_PUBLIC_LOCALE_DETECTION=true
ENV NEXT_PUBLIC_DEFAULT_THEME=$NEXT_PUBLIC_DEFAULT_THEME \
    NEXT_PUBLIC_LOCALE_DETECTION=$NEXT_PUBLIC_LOCALE_DETECTION
RUN pnpm build

FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]

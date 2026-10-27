FROM node:22-bookworm-slim AS build

# Build metadata. CI passes the git short hash; local builds can use
#   DROPIT_COMMIT=$(git rev-parse --short HEAD) docker compose build
ARG DROPIT_VERSION=
ARG DROPIT_COMMIT=
ARG DROPIT_BUILD_DATE=
ARG DROPIT_INSTALL=docker

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/cli/package.json apps/cli/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @dropit/web build \
  && pnpm --filter @dropit/server build \
  && pnpm --filter @dropit/server deploy --prod --legacy /out \
  && cp apps/server/build-info.json /out/build-info.json

FROM node:22-bookworm-slim AS runtime

ARG DROPIT_VERSION=
ARG DROPIT_COMMIT=
ARG DROPIT_BUILD_DATE=
ARG DROPIT_INSTALL=docker
LABEL org.opencontainers.image.title="dropit" \
      org.opencontainers.image.description="Self-hosted clipboard and file drop" \
      org.opencontainers.image.source="https://github.com/lthero-big/dropit" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${DROPIT_VERSION}" \
      org.opencontainers.image.revision="${DROPIT_COMMIT}" \
      org.opencontainers.image.created="${DROPIT_BUILD_DATE}"

WORKDIR /app
ENV DROPIT_VERSION=${DROPIT_VERSION} \
    DROPIT_COMMIT=${DROPIT_COMMIT} \
    DROPIT_BUILD_DATE=${DROPIT_BUILD_DATE} \
    DROPIT_INSTALL=${DROPIT_INSTALL} \
    NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    STATIC_DIR=/app/public

COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /app/apps/web/dist ./public
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

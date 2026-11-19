FROM node:22-bookworm-slim AS web-build

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
  && node -e 'require("fs").writeFileSync("/build-info.json",JSON.stringify({version:process.env.DROPIT_VERSION,commit:process.env.DROPIT_COMMIT,buildDate:process.env.DROPIT_BUILD_DATE,install:process.env.DROPIT_INSTALL}))'

FROM rust:1.94-trixie AS rust-build
RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config libdav1d-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY rust/server/Cargo.toml rust/server/Cargo.lock rust/server/rust-toolchain.toml ./rust/server/
COPY rust/server/src ./rust/server/src
RUN cargo build --manifest-path rust/server/Cargo.toml --locked --release

FROM debian:trixie-slim AS runtime

ARG DROPIT_VERSION=
ARG DROPIT_COMMIT=
ARG DROPIT_BUILD_DATE=
ARG DROPIT_INSTALL=docker
LABEL org.opencontainers.image.title="dropit" \
      org.opencontainers.image.description="Self-hosted clipboard and file drop (Rust)" \
      org.opencontainers.image.source="https://github.com/lthero-big/dropit" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${DROPIT_VERSION}" \
      org.opencontainers.image.revision="${DROPIT_COMMIT}" \
      org.opencontainers.image.created="${DROPIT_BUILD_DATE}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libdav1d7 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1000 dropit \
  && useradd --system --uid 1000 --gid dropit --home-dir /app --no-create-home dropit \
  && mkdir -p /app/public /data \
  && chown -R dropit:dropit /app /data \
  && chmod 700 /data

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

COPY --from=rust-build /src/rust/server/target/release/dropit-server /usr/local/bin/dropit-server
COPY --from=web-build /build-info.json /usr/local/bin/build-info.json
RUN ln -s dropit-server /usr/local/bin/dropit-admin
COPY --from=web-build --chown=dropit:dropit /app/apps/web/dist /app/public

USER dropit
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:${PORT:-8787}/healthz >/dev/null || exit 1

CMD ["/usr/local/bin/dropit-server"]

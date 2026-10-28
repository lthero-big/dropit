---
title: Development and contributing
---

## Environment

- Node.js 22+, pnpm 11 (`packageManager: pnpm@11.1.0`)

```bash
pnpm install
cp .env.example .env
pnpm dev            # starts @dropit/web (5173) and @dropit/server (8787) in parallel
```

## Checks

```bash
pnpm lint           # oxlint
pnpm typecheck
pnpm test           # vitest for web, tsx --test for server and cli; the backend uses mock OAuth and covers real HTTP, WebSocket, SQLite, disk and security cases
pnpm build
```

Run a single package: `pnpm --filter @dropit/server test`, `pnpm --filter @dropit/web test`, `pnpm --filter @dropit/cli test`.

Automated tests need no real OAuth credentials. `scripts/` also contains browser and Docker acceptance scripts.

## Docs site

The docs site sources live in `site/` (Starlight); preview locally with `cd site && npm ci && npm run dev`. Pushes to `main` that change `site/` are published to GitHub Pages by `.github/workflows/docs.yml`. English pages live under `site/src/content/docs/en/` with the same file names as the Chinese pages.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request:

1. `pnpm install --frozen-lockfile` → lint → typecheck → test → build
2. Builds the Docker image separately

## Contribution workflow

1. Create a branch from `main`; never commit directly to `main`.
2. When changing the API or configuration, update `docs/api.md`, `docs/backend-config.md` and the relevant pages in the docs site `site/` (both Chinese and English) accordingly.
3. Once lint / typecheck / test / build pass locally, open a Pull Request.

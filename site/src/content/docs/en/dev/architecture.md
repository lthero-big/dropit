---
title: Architecture
---

## Repository layout

```
apps/
  server/   Backend: Hono 4 + @hono/node-server 2.x (built-in WebSocket), better-sqlite3, sharp
  web/      Frontend: React 19 + React Router + Vite + Tailwind CSS 4
  cli/      CLI: @dropit/cli (command dropit)
docs/       API contract (api.md), backend config (backend-config.md), Wiki sources
site/       Docs site (Starlight, published to GitHub Pages)
scripts/    Browser and Docker acceptance scripts
Dockerfile  Multi-stage build: builds frontend and backend; the runtime image contains only production deps and static files
```

A pnpm workspace manages the three packages; `pnpm lint / typecheck / test / build` at the root run recursively.

## Backend modules (apps/server/src)

| File | Responsibility |
| --- | --- |
| `index.ts` | Process entry: loads config, starts the HTTP/WebSocket server, serves static files |
| `backend.ts` | Composition root and route definitions |
| `config.ts` / `limits.ts` | Environment variable parsing and validation; runtime limit policy, hard caps and overrides |
| `service.ts` | `ClipboardService` business logic: permissions, quotas, items, sharing |
| `uploads.ts` | Chunked upload sessions |
| `repository.ts` / `migrations.ts` | SQLite access (all SQL lives here) and `user_version` migrations |
| `files.ts` | Local disk file storage |
| `events.ts` | WebSocket broadcasting |
| `media.ts` | Thumbnails, previews and media file-header detection |
| `oauth.ts` | GitHub / Google OAuth (state + PKCE) |
| `rate-limit.ts` | Fixed-window rate limiting |
| `domain.ts` | Domain types |

`ClipboardService` depends on three interfaces — `Repository`, `FileStorage` and `Broadcaster` — so implementations can be swapped in tests.

## Data

- The SQLite (WAL) file `DATA_DIR/dropit.sqlite` lives in `DATA_DIR` alongside uploaded files.
- Migrations run atomically in a transaction; runtime limits and their audit log, upload sessions, etc. were all added via migrations.
- A periodic job (`CLEANUP_INTERVAL_MS`) deletes expired items, rooms and upload sessions, retries failed file deletions and reclaims orphaned files older than one hour.

## Frontend

- Routes: `/` (clipboard), `/login`, `/invite/:token`, `/rooms/:token`, `/s/:token` (share page), `/admin`, `/settings`, `/device`.
- Receives a snapshot and incremental events over WebSocket, reconnecting with exponential backoff.
- Large files are uploaded in chunks and interrupted uploads can be resumed.

## Deployment model

Single process, single instance. Rate limits, broadcasts, online counts and upload concurrency counters live in memory; multiple instances sharing a data directory are not supported.

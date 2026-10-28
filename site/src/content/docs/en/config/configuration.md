---
title: Configuration
---

All configuration comes from process environment variables (in development mode the repository-root `.env` is read as well). At startup `loadConfig()` validates every value; any invalid value or cross-field conflict makes the process refuse to start. For the full reference table see [docs/backend-config.md](../backend-config/) in the repository.

## Basics

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables Secure cookies and HSTS and requires HTTPS |
| `APP_ORIGIN` | `http://localhost:$PORT` | The exact origin the browser uses, without a path |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | repository `data/`; image `/data` | SQLite and file directory |
| `STATIC_DIR` | `apps/web/dist`; image `/app/public` | Built frontend assets |
| `TRUST_PROXY` | empty | Trusted reverse-proxy IPs/CIDRs, comma-separated; `loopback` allowed |

## Update checks

| Variable | Default | Description |
| --- | --- | --- |
| `UPDATE_CHECK` | `true` | `false` / `0` / `off` disables it; once disabled no outbound requests are made |
| `UPDATE_CHECK_HOURS` | `12` | Check interval, 6–168 hours |
| `UPDATE_IMAGE` | `lthero1/dropit` | Docker Hub image checked for Docker installs |
| `UPDATE_REPO` | `lthero-big/dropit` | GitHub repository used to compare commits and read Releases for source installs |
| `UPDATE_BRANCH` | `main` | Upstream branch compared for source installs |
| `DROPIT_VERSION` / `DROPIT_COMMIT` / `DROPIT_BUILD_DATE` | written at build time | Override the version info in `/api/version`; normally set automatically by Docker build-args or `pnpm build` |
| `DROPIT_INSTALL` | image `docker`; compose build `docker-build`; otherwise `source` | Determines which upgrade command the admin panel shows |

## Sign-in

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | GitHub sign-in is enabled only when both are set |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Google sign-in is enabled only when both are set |
| `ADMIN_EMAILS` | empty | Optional comma-separated verified emails that become admin on registration |
| `SESSION_HOURS` | 168 | Absolute session lifetime |

## Content limits

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_FILE_BYTES` | 26214400 (25 MiB) | Per-file limit |
| `MAX_TEXT_BYTES` | 65536 | UTF-8 bytes per text item |
| `MAX_ITEMS` | 1000 | Items per space; rooms use min(100, MAX_ITEMS) |
| `USER_QUOTA_BYTES` | 1073741824 (1 GiB) | Default per-user quota; admins can override per user |
| `RETENTION_HOURS` | 168 | Retention for space items |
| `ROOM_MAX_FILE_BYTES` | 5242880 (5 MiB) | Per-file limit in rooms; must be smaller than `MAX_FILE_BYTES` |
| `ROOM_QUOTA_BYTES` | 52428800 (50 MiB) | Total per room; must be smaller than `USER_QUOTA_BYTES` |
| `ROOM_RETENTION_HOURS` | 24 | ≤ 24 and ≤ `RETENTION_HOURS` |
| `CLEANUP_INTERVAL_MS` | 60000 | Cleanup job interval |

## Rate limiting

| Variable | Default | Description |
| --- | --- | --- |
| `RATE_WINDOW_MS` | 60000 | Fixed window length |
| `RATE_GENERAL` | 240 | Ordinary requests per IP / account / window |
| `RATE_AUTH` | 20 | Auth requests; must be smaller than `RATE_GENERAL` |
| `RATE_INVITE` | 10 | Invitation requests; must be smaller than `RATE_GENERAL` |
| `RATE_UPLOAD` | 30 | Upload / write requests; also the room access limit |
| `RATE_ROOM` | 10 | Room creation / write requests; must be smaller than `RATE_UPLOAD` |
| `RATE_TOKEN` | 120 | Additional ordinary-request allowance per personal access token |
| `RATE_CHUNK` | 2000 | Separate allowance for chunk PUTs |

## Chunked uploads

| Variable | Default | Description |
| --- | --- | --- |
| `UPLOAD_CHUNK_BYTES` | 8388608 (8 MiB) | Chunk size, 64 KiB–24 MiB |
| `UPLOAD_CHUNK_TIMEOUT_MS` | 120000 | Body timeout for a single chunk request |
| `UPLOAD_CHUNKS_PER_SESSION` | 3 | Concurrent chunks per upload session |
| `UPLOAD_CHUNKS_PER_USER` | 6 | Concurrent chunks per account (anonymous: per room) |
| `UPLOAD_CHUNKS_GLOBAL` | 16 | Concurrent chunks in the process |
| `UPLOAD_SESSIONS_PER_USER` | 8 | Unfinished sessions per account (anonymous: per room) |
| `UPLOAD_SESSIONS_GLOBAL` | 128 | Unfinished sessions globally |

## Runtime overrides

Admins can change 23 of the limits above (content limits / rate limiting / chunked uploads / sessions) in the admin panel (or via `PATCH /api/admin/limits`):

- Precedence: **SQLite runtime override > environment default**; setting a key to `null` restores the environment default.
- Changes apply to new requests immediately without a restart; every change is recorded in the `/api/admin/limits/audit` audit log.
- Retention changes only affect new items and new rooms; lowering a quota does not delete existing content.
- Hard caps (e.g. 1 GiB per file, 100 GiB quota, 365-day retention, 24-hour room retention) apply equally to environment variables and overrides.
- `APP_ORIGIN`, `TRUST_PROXY`, `DATA_DIR`, `ADMIN_EMAILS`, OAuth credentials, `RATE_TOKEN`, ports and the cleanup interval are read only at startup.

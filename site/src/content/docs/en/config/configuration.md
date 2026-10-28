---
title: Configuration
---

All configuration comes from process environment variables (in development mode the repository-root `.env` is read as well). At startup `loadConfig()` validates every value; any invalid value or cross-field conflict makes the process refuse to start. For the full reference table see [docs/backend-config.md](../backend-config/) in the repository.

## Basics

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development`; image `production` | With `production` and an https site address, enables Secure cookies and HSTS; an http site address only logs a warning instead of refusing to start |
| `APP_ORIGIN` | empty | The origin the browser uses (scheme + host or IP + port, no path). Empty means each request's own address is used. Can be changed in “Admin → Site address”; the admin setting wins |
| `RESET_APP_ORIGIN` | unset | `1` clears the site address saved in the admin panel at startup (for when a wrong value locks you out; remove it afterwards) |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | repository `data/`; image `/data` | SQLite and file directory |
| `STATIC_DIR` | `apps/web/dist`; image `/app/public` | Built frontend assets |
| `TRUST_PROXY` | empty | Trusted reverse-proxy IPs/CIDRs, comma-separated; `loopback` allowed |

## Site address (APP_ORIGIN)

Precedence: **“Admin → Site address” > `APP_ORIGIN` env > the request's own address**.

- When a site address is set, the `Origin` of write requests and WebSockets must match it exactly, and OAuth callbacks, invite / share links and `/device` links are generated from it.
- When unset, `Origin` must match the request's own address (scheme from the connection — `X-Forwarded-Proto` / `X-Forwarded-Host` are used only from `TRUST_PROXY` peers; host from the `Host` header), and links use that address. Good for quick starts and LANs.
- A value saved in the admin panel takes effect immediately without a restart. Saving a value that differs from the address you are using requires confirmation so you cannot lock yourself out by accident; if you do, start once with `RESET_APP_ORIGIN=1`.
- On a mismatch, the login page and error messages name both the current address and APP_ORIGIN and say what to change.
- The startup log prints `dropit APP_ORIGIN: ...` with its source, and `dropit warning: ...` when production runs on an http site address or the admin setting overrides the env value; the admin panel shows the same warnings.

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
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | unset | Optional, set both. While the database has no account, the server creates this admin at startup and skips `/setup`; ignored once any account exists. Password 8–256 characters; invalid values stop startup |
| `ADMIN_EMAILS` | empty | Optional comma-separated emails: OAuth identities whose email the provider **verified** become admin on registration. Does not apply to password sign-up (unverified email) |
| `SESSION_HOURS` | 168 | Absolute session lifetime |

Email + password sign-in is always available and needs no configuration. While no account exists, the startup log prints `dropit setup code: XXXX-XXXX`; use it at `/setup` to create the first admin. The registration policy (closed / invite-only / open, default invite-only) is set under “Admin → Registration” and stored in the database; there is no environment variable for it. Password sign-in and `/setup` share the `RATE_AUTH` limit (plus a separate per-email counter).

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
| `RATE_AUTH` | 20 | Auth requests (also the number of wrong room codes/PINs allowed per IP and per code); must be smaller than `RATE_GENERAL` |
| `PIN_LOCK_FAILURES` | 10 | Wrong PINs one room code may collect in total (from any IP) before it is locked |
| `PIN_LOCK_MINUTES` | 15 | How long a locked room code answers `429` to every PIN attempt (also the window in which the failures are counted); max 10080 |
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
- `TRUST_PROXY`, `DATA_DIR`, `ADMIN_EMAILS`, `RATE_TOKEN`, ports and the cleanup interval are read only at startup; the site address (`APP_ORIGIN`) can be changed in “Admin → Site address” and applies immediately.

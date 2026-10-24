# Backend environment

Load `.env` into the process using your process manager / Compose; the backend
does not read a secrets file itself. `loadConfig()` validates settings at startup.
Run a single Node 22+ process. Local HTTP is supported; production requires HTTPS
at `APP_ORIGIN` (typically terminated by a trusted reverse proxy).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | development | `production` enables Secure cookies and HSTS |
| `APP_ORIGIN` | `http://localhost:$PORT` | Exact browser origin, no path; example uses 5173 for Vite |
| `PORT` | 8787 | Listen port |
| `HOST` | `0.0.0.0` | Listen address (example uses loopback for local development) |
| `DATA_DIR` | repository `data/` | Persistent SQLite and file directory; image sets `/data` |
| `STATIC_DIR` | `apps/web/dist` | Built frontend directory; image sets `/app/public` |
| `ADMIN_EMAILS` | empty | Optional comma-separated verified emails that are also created as admins. The first sign-in on an empty users table is admin whether or not this is set |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | Enables GitHub login only when both are set |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Enables Google login only when both are set |
| `TRUST_PROXY` | empty | Comma-separated trusted proxy CIDRs/IPs (`loopback` allowed); never blindly trust every address |
| `MAX_FILE_BYTES` | 26214400 | 25 MiB per file |
| `USER_QUOTA_BYTES` | 1073741824 | 1 GiB default across a user's uploads and text. Admins may set a per-user override; `null` keeps this default |
| `RETENTION_HOURS` | 168 | Private/shared entry retention |
| `ROOM_MAX_FILE_BYTES` | 5242880 | 5 MiB, must be smaller than MAX_FILE_BYTES |
| `ROOM_QUOTA_BYTES` | 52428800 | 50 MiB, must be smaller than USER_QUOTA_BYTES |
| `ROOM_RETENTION_HOURS` | 24 | Must be <=24 and <=RETENTION_HOURS |
| `SESSION_HOURS` | 168 | Absolute server session lifetime |
| `CLEANUP_INTERVAL_MS` | 60000 | Expired content/deletion queue cleanup |
| `MAX_TEXT_BYTES` | 65536 | UTF-8 text bytes |
| `MAX_ITEMS` | 1000 | Entries per space; rooms cap at min(100, MAX_ITEMS) |
| `RATE_WINDOW_MS` | 60000 | Fixed rate window |
| `RATE_GENERAL` | 240 | Requests/IP and account/window |
| `RATE_AUTH` | 20 | Auth requests/IP/window; smaller than RATE_GENERAL |
| `RATE_INVITE` | 10 | Invite requests/IP and account/window; smaller than RATE_GENERAL |
| `RATE_UPLOAD` | 30 | Upload/write requests/IP and account/window; also room access limit |
| `RATE_ROOM` | 10 | Room creation/write requests/IP and account/window; smaller than RATE_UPLOAD |

Numeric settings are positive integers. Raising room limits above private-space
limits or retention above 24 hours is rejected. Session/OAuth/room/invite secrets
are cryptographically random; session/invite/room secrets are stored only as hashes.

Use `pnpm --filter @dropit/server test` for mock OAuth, HTTP/SQLite/disk integration
and actual WebSocket tests; `typecheck` and `build` validate server TypeScript.
See [API contract](api.md) for exact frontend calls and event/reconnection semantics.

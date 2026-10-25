# Backend environment

Load `.env` into the process using your process manager / Compose; the backend
does not read a secrets file itself. `loadConfig()` validates environment defaults
at startup; persisted runtime overrides then take precedence.
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
| `RATE_TOKEN` | 120 | Additional ordinary requests per PAT/window; chunk PUT uses RATE_CHUNK instead |
| `UPLOAD_CHUNK_BYTES` | 8388608 | New upload chunk size, 64 KiB–24 MiB; default 8 MiB fits nginx client_max_body_size 30m |
| `UPLOAD_CHUNK_TIMEOUT_MS` | 120000 | Per-PUT body deadline; no whole-file deadline |
| `UPLOAD_CHUNKS_PER_SESSION` | 3 | Concurrent chunk writes per upload |
| `UPLOAD_CHUNKS_PER_USER` | 6 | Concurrent chunk writes per authenticated account (anonymous: per room) |
| `UPLOAD_CHUNKS_GLOBAL` | 16 | Concurrent chunk writes in this process |
| `UPLOAD_SESSIONS_PER_USER` | 8 | Unfinished sessions per account (anonymous: per room) |
| `UPLOAD_SESSIONS_GLOBAL` | 128 | Unfinished sessions globally |
| `RATE_CHUNK` | 2000 | Independent chunk PUT requests/IP/account/PAT/window; bypasses ordinary request/write buckets |

Numeric settings are positive integers. Raising room limits above private-space
limits or retention above 24 hours is rejected. Session/OAuth/room/invite secrets
are cryptographically random; session/invite/room secrets are stored only as hashes.

Use `pnpm --filter @dropit/server test` for mock OAuth, HTTP/SQLite/disk integration
and actual WebSocket tests; `typecheck` and `build` validate server TypeScript.
See [API contract](api.md) for exact frontend calls and event/reconnection semantics.

## Runtime overrides and hard ceilings

Admins can read/change/reset runtime limits using `/api/admin/limits`; audit
history is at `/api/admin/limits/audit`. Both accept admin sessions/PATs, but
read-only Bearers cannot PATCH. See [API contract](api.md#runtime-limit-policy)
for payloads, cross-field rules, pagination and effective-time semantics.

Precedence is **SQLite runtime override > environment default**. Removing an
override (`null`) restores the environment default loaded at the current process
startup. Changing the environment still requires a restart; existing overrides
keep taking precedence. The API reports the current value, environment default,
override state and bounds per key. No secret/path/OAuth/proxy setting is exposed.

Migration v7 adds `runtime_limits` and append-only `limit_audit` to
`DATA_DIR/dropit.sqlite`; audit rows and override changes share one transaction.
Mount the same persistent data volume for process/container restarts and container
recreation (the image uses `/data`, Compose uses the `dropit-data` volume).
Back up the database together with its audit trail. Deleting the volume removes
overrides, audits and content. Run one server process; overrides are held in memory
after loading and this is not a multi-instance synchronization mechanism.

All editable values are positive safe integers, with minimum 1 except
`uploadChunkBytes` (minimum 65536). The following
code-level ceilings apply to environment defaults **and** runtime overrides;
they are fixed safeguards, not a measurement of available disk space. Operators
must still provision enough disk and monitor usage. Cross-field constraints may
make an individual ceiling unattainable (room limits stay strictly below user
limits, sensitive rate limits strictly below general limits).

| Runtime key | Environment default source | Hard maximum |
| --- | --- | --- |
| `maxFileBytes` | `MAX_FILE_BYTES` | 1 GiB (1073741824 bytes) |
| `maxTextBytes` | `MAX_TEXT_BYTES` | 1 MiB (1048576 bytes) |
| `maxItems` | `MAX_ITEMS` | 100000 |
| `userQuotaBytes` | `USER_QUOTA_BYTES` | 100 GiB (107374182400 bytes) |
| `retentionMs` | `RETENTION_HOURS` × 3600000 | 365 days (31536000000 ms) |
| `roomQuotaBytes` | `ROOM_QUOTA_BYTES` | 100 GiB (107374182400 bytes) |
| `roomMaxFileBytes` | `ROOM_MAX_FILE_BYTES` | 1 GiB (1073741824 bytes) |
| `roomRetentionMs` | `ROOM_RETENTION_HOURS` × 3600000 | 24 hours (86400000 ms) |
| `rateWindowMs` | `RATE_WINDOW_MS` | 1 hour (3600000 ms) |
| `rateGeneral`, `rateAuth`, `rateInvite`, `rateUpload`, `rateRoom` | Corresponding `RATE_*` variable | 1000000 each |
| `sessionMs` | `SESSION_HOURS` × 3600000 | 365 days (31536000000 ms) |
| `uploadChunkBytes` | `UPLOAD_CHUNK_BYTES` | 24 MiB (25165824 bytes); minimum 64 KiB |
| `uploadChunkTimeoutMs` | `UPLOAD_CHUNK_TIMEOUT_MS` | 1 hour (3600000 ms) |
| `uploadChunksPerSession` | `UPLOAD_CHUNKS_PER_SESSION` | 16 |
| `uploadChunksPerUser` | `UPLOAD_CHUNKS_PER_USER` | 64 |
| `uploadChunksGlobal` | `UPLOAD_CHUNKS_GLOBAL` | 256 |
| `uploadSessionsPerUser` | `UPLOAD_SESSIONS_PER_USER` | 1000 |
| `uploadSessionsGlobal` | `UPLOAD_SESSIONS_GLOBAL` | 10000 |
| `rateChunk` | `RATE_CHUNK` | 1000000 |

Startup fails if environment defaults or the merged persisted configuration
violate policy. In particular, changing environment defaults can conflict with
an existing coupled override: restore the previous valid environment, then reset
or update those overrides through the API before changing the environment again.
Overrides are never silently discarded or clamped.

Changes take effect for new requests without restarting. Decreasing file size,
item count or quota does not remove existing content; existing per-user quotas
still take priority over the installation default. A running upload retains its
starting file-size cap but must pass current quotas/counts when committing.
Retention changes only affect **new** entries/rooms: existing `expiresAt` values
and cleanup schedules stay unchanged. Existing room expiry still bounds entries
added to it. Session lifetime changes affect only new OAuth sessions, not current
sessions or PATs. Rate threshold changes retain current counts; window changes
retain active reset deadlines and apply the new duration to new buckets.

Startup-only settings include `APP_ORIGIN`, `TRUST_PROXY`, `DATA_DIR`,
`ADMIN_EMAILS`, OAuth credentials, `RATE_TOKEN`, ports, cleanup interval and all
other settings outside the editable list. Any externally managed
`SESSION_SECRET` also remains outside this API; the backend uses random
server-stored opaque sessions and has no editable session signing secret.

## Upload sessions and cleanup

Migration v8 adds `uploads` and `upload_chunks`. Sessions and received indices
survive restart using the same DATA_DIR volume; disk chunks use opaque storage
keys and are protected from orphan sweeping while referenced. No frontend change
is required for the existing single-request endpoint. Clients can opt into the
[session protocol](api.md#resumable-file-uploads).

Creation reserves declared bytes and an item slot atomically. Reservations count
against the same user/room quota as normal items. Thumbnails add actual bytes at
complete, so a file that fills the quota exactly can still fail complete. `/me`
adds `reservedBytes` separately from usedBytes. Cancellation, disable and room
expiry release reservations and queue chunk deletion. Sessions expire after an
absolute 24 hours (or earlier room expiry); activity does not extend the deadline.
Maintenance runs every CLEANUP_INTERVAL_MS, removes expired sessions and retries
queued file deletions. A process crash during a chunk write can leave an
unreferenced file, reclaimed by the existing one-hour orphan sweep. Temporary
assembly may need up to another file's size on disk; reservations are logical
quota accounting, not filesystem capacity reservations.

All eight new upload/rate controls are exposed in the existing admin limit editor,
with the same persistence, reset and audit behavior. New chunk size applies to
new sessions only. Timeout and concurrency changes apply to new PUTs; existing
requests retain their deadlines, and reducing caps does not abort active work.
Other current file/quota/item limits are rechecked at complete. The effective
concurrency is bounded by every applicable cap; the caps are independent.

The HTTP server's 120-second whole-request timeout is removed. Each chunk body
has its own configured deadline. Reverse proxies can impose their own idle/body
timeouts; keep nginx body size above the chunk size (the current 30m accommodates
the 24 MiB hard ceiling). Do not increase the chunk size to the whole-file limit.
Chunk PUTs have independent rate buckets, including a separate PAT bucket, so
ordinary RATE_GENERAL/RATE_UPLOAD/RATE_ROOM/RATE_TOKEN thresholds do not cap the
number of chunks. Control requests retain ordinary limits. Concurrency counters
and runtime limit state are process-local; keep the documented single-process
model.

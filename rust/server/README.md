# Rust password, text and browser service

RHEA-227 adds the first runnable Rust slice of the migration. The HTTP reference is
the TS server at commit 37ce06ebfab2cd98b81e49ce54fb24ec5daeec68. Source contracts are
in ../CONTRACT.md, ../DECISIONS.md and ../MAP.md.

The implemented routes are GET /healthz, POST /api/auth/password/login,
POST /api/auth/logout, GET /api/me, GET /api/spaces, GET /api/spaces/:space,
GET /api/spaces/:space/items and POST /api/spaces/:space/items/text.
RHEA-230 adds GET /api/site, /api/version, /api/auth/providers, /api/setup
and GET /api/spaces/:space/ws.

Existing password hashes, user/space IDs, browser sessions, membership roles,
quota overrides, persisted limits, text, groups and device metadata retain the TS
representation. Private-space access from another account returns 404.
Viewer writes return READ_ONLY. Temporary-password sessions retain the
PASSWORD_CHANGE_REQUIRED restriction. Password verification applies NFKC and
scrypt, with constant-time derived-key comparison and dummy work for missing
accounts. Session secrets are random 32-byte base64url strings, stored as
base64url SHA-256 hashes.

## Build and validate

Rust 1.94.0 is pinned in rust-toolchain.toml. A C compiler is required for bundled
SQLite. Node 22, pnpm, git and tar are required to generate the reference fixtures
and run the compatibility tests. The baseline Git object must be available locally.
The Rust executable runs independently of Node.

AVIF decode links the system dav1d library. The build needs pkg-config and a
dav1d.pc that reports at least 1.3.0. On Debian and Ubuntu, install those
packages before the Cargo commands:

~~~sh
sudo apt-get update
sudo apt-get install -y pkg-config libdav1d-dev
pkg-config --exists 'dav1d >= 1.3.0'
~~~

The Rust CI job installs the same packages before fmt, clippy, build, and test.

Run from the repository root.

~~~sh
pnpm install --frozen-lockfile --filter @dropit/server...
pnpm --filter @dropit/server build
cd rust/server
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked -- --nocapture
~~~

cargo test runs tests/http.rs, which launches tests/compat.mjs with the built Rust
binary. It also runs tests/files-http.rs, which launches tests/files-compat.mjs.
The same harnesses can be invoked from the repository root with
node rust/server/tests/compat.mjs and node rust/server/tests/files-compat.mjs.
RUST_SERVER_BIN can select a release build.

The harness generates schema 19 using the original SqliteRepository,
hashPasswordSync, ClipboardService and session creation code. Each implementation
gets a separate copy of that TS-generated fixture. It starts real HTTP processes,
checks status/JSON/security headers/cookies, then kills and restarts each process
against its original files. It also starts TS on the Rust-written database,
reads Rust sessions/text, writes through TS again, and reads those writes through
Rust. Before generating fixtures, the harness uses git archive to extract the fixed
baseline commit's apps/server, package.json, pnpm-workspace.yaml and pnpm-lock.yaml
into its temporary directory. It installs that reference with
pnpm install --frozen-lockfile --prefer-offline --filter @dropit/server... and builds
it there. Fixtures, HTTP processes and database inspection all use those archived
sources and dependencies. Current frontend lockfile additions therefore allow the
same fixed backend reference to run. pnpm uses cached packages where available and
downloads missing baseline packages when necessary.

Only random session values, new item IDs, new item timestamps and snapshot
serverTime are normalized during comparison. The test independently checks the
new item's ID format, exact text, UTF-8 byte size, user ID, timestamp relationships
and retention interval. Existing TS IDs and timestamps remain exact.

Temporary test databases live under rust/server/data/compat-*. Each test process
uses a loopback socket, its own port and explicit environment. The harness closes
its own child processes and removes its temporary databases in finally blocks.
The test credentials are synthetic and are defined in tests/fixture.mjs.

## Recorded validation

On 2026-11-18, Rust 1.94.0, Node 22.22.0 and pnpm 11.1.0 were used on
x86_64 Linux. cargo fmt --check, cargo build --locked and
cargo clippy --locked --all-targets -- -D warnings passed. cargo test --locked --
--nocapture passed its one process-level integration test, checking 199 real HTTP
responses across TS and Rust. The cases include wrong and missing credentials,
JSON/body limits, CSRF, disabled and pending users, viewer/temporary-password
restrictions, Unicode metadata, logout, an abrupt process restart, bidirectional
TS/Rust data and sessions, eight concurrent quota-limited writes, item capacity,
production cookies, trusted-proxy origin, auth rate limits and session expiry.

## First review regressions

The candidate includes integration commit ebf9b876da9c3918757d2c956d33f63d1948a97b
and its frontend Playwright additions. The original whole-lockfile equality
assertion failed on that candidate before any HTTP process started. Building the
isolated fixed reference restores the original 139 HTTP checks on this candidate.

The space, items and text routes now handle Path extraction rejection inside the
handler after require_auth. Invalid UTF-8 and malformed percent parameters return
the TS JSON error shape with 401 for unauthenticated requests and 404 for
authenticated requests. Regression cases cover %FF, %C3%28, %GG and % on all three
routes with and without a session.

serde_json's arbitrary_precision feature accepts valid JSON numeric literals such
as 1e400 in ignored fields, matching the TS handlers. Tests check successful login
followed by me and successful text creation followed by a snapshot, including
nested overflow numbers. Overflow numbers in required string fields still produce
INVALID_INPUT. Existing JSON syntax and body-limit tests remain in the suite.

The review also observed a difference for a JSON string containing an unpaired
U+D800 code unit between a and b. TS accepts that input and Rust returns
INVALID_JSON. The full TS write/read/restart behavior for that boundary remains
unverified and is deferred to the coordinator's complete-migration contract.
Normal Unicode roundtrip remains covered by the process test.

## Run locally

Create a new isolated fixture from the repository root after building TS.

~~~sh
node rust/server/tests/fixture.mjs rust/server/data/manual
cd rust/server
HOST=127.0.0.1 PORT=18787 APP_ORIGIN=http://127.0.0.1:18787 \
  DATA_DIR="$PWD/data/manual" cargo run --locked
~~~

The fixture contains alice@example.test and bob@example.test, with the synthetic
password Password-é-🔐. Alice also has an existing TS text, session and private
space. fixture.json in the generated directory lists their identities and IDs.
Send Origin matching APP_ORIGIN on POST requests and retain the returned session
cookie. Ctrl-C stops the local process.

The service opens DATA_DIR/dropit.sqlite read/write and accepts schema 19. It
requires an existing fixture and reports a startup error for a missing database or
another schema version. DATA_DIR defaults to ./data relative to the working
directory. HOST defaults to loopback and PORT defaults to 8787. The loopback
default is a local-slice implementation choice.

APP_ORIGIN and TRUST_PROXY have the reference meanings, including the stored
appOrigin setting taking precedence, optional request-origin fallback and
RESET_APP_ORIGIN. NODE_ENV=production selects __Host-dropit_session plus Secure
when the effective origin uses HTTPS. Login and logout retain HttpOnly,
SameSite=Lax, Path=/ and Max-Age semantics.

The supported limit environment variables are MAX_FILE_BYTES, MAX_TEXT_BYTES,
MAX_ITEMS, USER_QUOTA_BYTES, RETENTION_HOURS, SESSION_HOURS, RATE_WINDOW_MS,
RATE_GENERAL, RATE_AUTH, RATE_UPLOAD, RATE_CHUNK, UPLOAD_CHUNK_BYTES,
UPLOAD_CHUNK_TIMEOUT_MS, UPLOAD_CHUNKS_PER_SESSION, UPLOAD_CHUNKS_PER_USER,
UPLOAD_CHUNKS_GLOBAL, UPLOAD_SESSIONS_PER_USER and UPLOAD_SESSIONS_GLOBAL.
UPLOAD_CHUNK_BYTES stays in the 64 KiB–24 MiB range. Corresponding runtime_limits
entries override them at startup. Account quota overrides and active upload
reservations contribute to capacity checks. Expired items are excluded from snapshots.

## SQLite and blocking work

Cargo.lock pins rusqlite 0.37.0 with bundled SQLite 3.50.2, Axum 0.8.9,
Tokio 1.54.1 and scrypt 0.11.0. rusqlite maps the existing synchronous SQL and
BEGIN IMMEDIATE behavior directly. Bundling SQLite makes local builds independent
of the host's SQLite installation.

The connection uses WAL, foreign_keys=ON and busy_timeout=5000, matching TS.
Permission, session validity, disabled state, current quota, reservations and item
capacity are checked in the write transaction. Item insertion commits atomically.
A named group is committed before item-capacity checks, preserving the TS behavior
that the group remains after a rejected item. Login rechecks the account and hash
after scrypt work before creating a session, including invite consumption and
pending-account activation.

A semaphore admits one SQLite operation before spawn_blocking. The connection
mutex is held within that blocking operation. This avoids parking Tokio workers
or many blocking threads behind a connection lock. Cancellation retains the permit
until the blocking operation finishes. Password verification uses a separate
four-permit semaphore and spawn_blocking. This serial SQLite connection bounds the
initial slice's database concurrency. A measured throughput requirement can
justify a connection pool later.

[rusqlite connection documentation](https://docs.rs/rusqlite/0.37.0/rusqlite/struct.Connection.html)
and [transaction behavior](https://docs.rs/rusqlite/0.37.0/rusqlite/enum.TransactionBehavior.html)
describe the underlying API choices.

## Existing file reads

Private-space download, stored thumbnail, and media reads are in
src/downloads.rs. The routes are GET and HEAD
/api/spaces/:space/items/:id/download, /thumbnail, and /media. They reuse the
existing cookie session, private-space membership, and expiresAt filter. A
viewer may read. A temporary-password session still receives
PASSWORD_CHANGE_REQUIRED. The file key comes from the item row, never from the
client path.

Download uses application/octet-stream and an attachment disposition. Media
sniffs the stored prefix and sets Cache-Control: private, no-store. Thumbnail
streams the stored WebP with Content-Type: image/webp and does not re-encode.
Range follows parseByteRange. A single satisfiable range is 206. A start at or
above the file size, including a non-safe integer that Number still compares as
at least the size, is 416 with Content-Range: bytes */size. An absent,
malformed, multi-range, or unsafe suffix header is a full 200. Leading zeros
do not change the numeric value, so bytes=00000000000000000- is the whole file.
HEAD returns the same status and headers with an empty body. Dropping the
response body closes the file.

cargo test also runs tests/files-http.rs. That test launches
tests/files-compat.mjs with the built binary. The script archives the same
fixed TS commit, generates a schema-19 fixture, inserts file rows, writes
objects under files/, and compares status, the listed headers, and body bytes.
The direct command from rust/server is:

~~~sh
cargo test --locked --test files-http -- --nocapture
~~~

On 2026-11-18 that comparison passed 228 HTTP responses. The cases cover
download, thumbnail, and media for the seeded types, single and suffix ranges,
leading-zero ranges, ranges at and above the safe-integer limit, out-of-bounds
ranges, HEAD, anonymous, cross-account, viewer, temporary-password, empty
filename, missing file key, expired records, and a client abort. After the
abort, /proc/<pid>/fd no longer listed the stored file, /healthz stayed 200,
and a later bytes=0-1 read returned the first two stored bytes.

A recorded file key whose disk object is missing makes the TS createReadStream
path drop the socket. Rust returns the JSON 404. The harness records that
difference and still requires the Rust 404. Hyper adds Content-Length: 0 on an
empty 416 body, and Axum sets Content-Length on JSON errors. Hono leaves both
unset. The compared bytes are empty or identical, and the harness normalizes
those two length headers.

Share links, rooms, and PAT/bearer authentication remain outside this slice.
Direct upload, preview, and retract are in the RHEA-233 section. Private-space
chunk sessions are below. An Authorization header still selects the unsupported
bearer path.

## Chunk sessions (RHEA-237)

Private-space chunk sessions use the same cookie session and writable-member
checks as direct upload. The routes are POST /api/spaces/:space/uploads,
GET and DELETE /api/spaces/:space/uploads/:id, PUT
/api/spaces/:space/uploads/:id/chunks/:index, and POST
/api/spaces/:space/uploads/:id/complete. Room upload routes are not in this slice.

Create returns 201 with uploadId, chunkSize, expiresAt, and received. chunkSize
is frozen from uploadChunkBytes. expiresAt is the earlier of 24 hours and the
space expiry. The declared size is reserved against the account quota, the item
count, and the live session caps. A full quota is 413 QUOTA_EXCEEDED. A full
item count is 413 ITEM_LIMIT. Too many live sessions is 429 UPLOAD_SESSION_LIMIT.
GET /api/me reservedBytes includes unexpired sessions.

Chunk writes use the chunk rate bucket. The index must be a safe integer with
no leading zero and must be inside the declared size. A short body is 400
CHUNK_SIZE_MISMATCH. A body past the expected length is 413 FILE_TOO_LARGE. An
empty body is 400 EMPTY_FILE. X-Chunk-SHA256 must be 64 hex digits. A mismatch
is 400 CHECKSUM_MISMATCH. An identical retry is 204 and keeps the first copy.
A different stored body is 409 CHUNK_CONFLICT. A write that exceeds the per
session, per account, or global in-process cap is 429 CHUNK_BUSY. A stalled
write returns 400 UPLOAD_TIMEOUT. Lowering a cap does not abort a write that
already started.

Complete assembles the stored chunks in order. A gap or size mismatch is 400
UPLOAD_INCOMPLETE and the session is deleted. A second complete while chunks or
another complete are in flight is 409 UPLOAD_IN_PROGRESS. Two overlapping
completes produce one item and one 409. A later complete is 404. Session
complete rejects an image/svg+xml MIME and a body whose prefix matches
/<svg[\s/>]/i with 415 INVALID_IMAGE. Legacy POST /items/file does not apply
that prefix rule. Raster checks, the 16,777,216 pixel cap, EXIF rotation, and
the 320-pixel WebP thumbnail are the same path as direct upload. A successful
commit publishes groups and item.created. Garbage cleanup after that commit
does not turn 201 into an error.

DELETE removes the session, aborts an in-flight chunk or complete, and flushes
queued garbage. The aborted write surfaces as 404. Restart keeps received
indices because they live in upload_chunks.

JPEG, PNG, GIF, WebP, and 8-bit still AVIF are decoded. HEIC, HEIF that is not
sniffed as AVIF, 10-bit and 12-bit frames, animated AVIF, and the imir box stay
unsupported and download-only when they are not rejected as INVALID_IMAGE.
Thumbnail WebP is lossless, so its bytes differ from the Sharp quality-75
reference. Dimensions and orientation are the comparison.

DROPIT_SWEEP_ON_SPACES=1 runs expiry and garbage sweep from GET /api/spaces.
DROPIT_SWEEP_OLDER_THAN sets the unreferenced-file cutoff in milliseconds.
That hook is for the comparison harness. There is no public maintenance route.

The comparison is tests/uploads-compat.mjs, launched by tests/uploads-http.rs.
On 2026-11-18 it passed 353 HTTP responses, including the earlier direct-upload
cases and chunk create, resume, identical retry, conflict, checksum, bounds,
image thumbnail, download Range, SVG and corrupt rejection, 4096-pixel accept,
auth, overlapping complete, cancel, quota reservation, session limit, chunk
busy, expiry cleanup, and restart resume.

## Coverage boundary

OAuth, PAT/device-code authentication, registration/setup writes, password changes,
session-management APIs, room APIs, room chunk uploads, sharing, admin APIs,
static web hosting,
update endpoints and historical schema upgrades remain outside this
slice. Unsupported routes return the existing JSON NOT_FOUND form. An
Authorization header selects the unsupported bearer path and returns
UNAUTHENTICATED with WWW-Authenticate instead of falling back to a cookie.

Live admin-setting updates remain pending. Expired item records are filtered
from reads. Upload-session expiry and unreferenced file sweep run through the
test hook in the RHEA-237 section, not through a public route. The slice
requires a schema-19 fixture and provides no first-run database bootstrap.

The tests establish the documented password/private-text HTTP flow and
bidirectional database compatibility for synthetic schema-19 data. Existing-account Web login, text, realtime and reconnect are covered below.
Complete migration, historical upgrades and production performance remain unverified.

## Browser and realtime slice (RHEA-230)

`src/browser.rs` reads registration/setup/provider state from the same schema-19
settings/users/OAuth tables. Public `/api/site` uses the already-resolved origin
and trusted proxy rules. `/api/version` follows DROPIT_VERSION, DROPIT_COMMIT,
DROPIT_BUILD_DATE and DROPIT_INSTALL; optional build-info.json beside the executable
supplies stored metadata. Build dates accept RFC3339/ISO timestamps (the format
used by existing builds), returned as UTC milliseconds. Non-ISO JavaScript
Date.parse inputs are not supported. Without build metadata, development commits
come from git and the version defaults to 0.0.0. Rust release packaging is still
pending. Reporting a configured OAuth provider does not implement its login flow.

`src/realtime.rs` serves private spaces only. Every connection gets an authoritative
snapshot, followed by item.created, groups (including group creation before a
rejected text write), and presence events. Named devices are deduplicated in
presence while devices counts sockets; unnamed sockets are others. A shared gate
orders subscription snapshots and text commits/broadcasts, preventing a write
between subscription and snapshot from being missed. Session device tags are
persisted using the original columns.

Origin, membership and browser authentication precede upgrade. Limits are eight
connections per IP/user and 256 total, including upgrade reservations. Reservations
are released on failed upgrades, errors and closes. Authorization is checked every
second and before each event delivery; session expiry/revocation, disabled users
and removed members close with 1008 / Authorization expired. Application writes to
the channel close with 1008 / Read-only channel. Incoming payloads are limited to
1024 bytes (1009 on overflow). Ping/pong runs every 30 seconds; a missing pong
terminates the socket at the next heartbeat. A bounded per-client queue holds at
most 1 MiB of payloads, with a five-second send deadline. Overflow or a blocked
writer closes with 1013 / Slow consumer; publishers never await network consumers.
The bounded queue also has a 256-message ceiling for tiny payload floods.

### Reproduce

After the existing dependency/build setup, run from the repository root:

```sh
(cd rust/server && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings)
(cd rust/server && cargo build --locked && cargo test --locked -- --nocapture)
node rust/server/tests/browser.mjs
pnpm --filter @dropit/web smoke
```

`tests/realtime.rs` runs a second real-process reference harness, independently
archiving/building fixed TS commit 37ce06ebfab2cd98b81e49ce54fb24ec5daeec68.
It compares bootstrap state, WS upgrade status, snapshot content versus HTTP,
Unicode device names/session tags, groups/text events, deduplicated presence,
reconnect, writes racing snapshots, read-only and payload limits, revoked/expired
sessions, disabled users, removed members and the eight-socket cap with slot reuse.
It also pauses a real TCP reader and sends 180 near-limit texts, checking 1013,
then checks two actual 30-second heartbeat intervals and no-pong termination.
Both implementations run against separate TS-generated fixtures and all children,
sockets and temporary data are removed. TS's Node upgrade adapter discards error
response bodies, so failed-upgrade comparisons require status and compare JSON
codes only when a body is available. Successful HTTP responses retain full JSON
assertions. The original 199-response harness remains unchanged.

`tests/browser.mjs` builds no fake backend: it uses the built current TS code only
to generate the fixture, starts Rust on 18878, and invokes the existing Web smoke
against that explicit target. Playwright starts Vite, which sends all HTTP/WS to
Rust; no TS server runs. The browser checks login/text/reload/logout plus independent
cookie jars, named devices, cross-browser item.created delivery and a real socket
reconnect snapshot after offline writes. The TS-only short-download assertion is
intentionally skipped for Rust. The same smoke runs unchanged against TS by
omitting the explicit backend target. These tests require free local ports 15173
and 18878 (18787 for the default TS smoke).

## Direct upload, preview, and retract (RHEA-233)

Private-space `POST /api/spaces/:space/items/file` streams the body onto disk
with exclusive create, mode `0o600`, and SHA-256. The async request thread does
not perform the image decode. A disconnect, empty body, or over-limit write
removes the staged original and any thumbnail. Declared `image/jpeg`,
`image/png`, `image/webp`, `image/gif`, and `image/avif` receive a 320-edge
WebP thumbnail. SVG and HTML declared as themselves stay download-only. A
declared raster whose bytes are not an allowed still or AVIF, including SVG
bytes labeled `image/png`, is 415. The commit transaction rechecks the session,
membership, quota including upload reservations, and the item cap. A named
group is committed before that capacity check.

`GET /api/spaces/:space/items/:id/preview` derives a 2048-edge WebP in memory.
It does not write a file or change quota, then rechecks that the item is still
live. `DELETE /api/spaces/:space/items/:id` retracts text and files. The author
or owner may delete. Another editor receives FORBIDDEN. A viewer receives
READ_ONLY. After delete, download, thumbnail, and preview are 404, and both
stored keys are removed.

AVIF is rejected from the `ispe` pixel product before `dav1d` allocates a
picture. The decoder also sets a frame-size limit and counts allocations. An
8-bit still AVIF is converted locally. 10-bit, 12-bit, and animated AVIF are
not decoded. Successful creation publishes `groups` when a group was added,
then `item.created`. Retract publishes `item.deleted`. Both hold the existing
realtime snapshot gate. Chunk sessions are not implemented, so the
session-complete SVG prefix rule is not applied here.

`cargo test --locked` runs `tests/uploads-http.rs`, which launches
`tests/uploads-compat.mjs` against archived commit
37ce06ebfab2cd98b81e49ce54fb24ec5daeec68. On 2026-11-18, Rust 1.94.0, Node
22.22.0, and pnpm 12.18.0, that comparison passed 168 HTTP responses. The same
run also passed the existing 228 file-read responses, 199 login/text responses,
and 526 realtime checks. Commands from `rust/server`:

~~~sh
cargo fmt --all
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked -- --nocapture --test-threads=1
~~~

The CI dependency repair reran `cargo fmt --check`, strict locked clippy,
locked build, and the same test command. That run passed 7 unit tests, 228
file-read responses, 199 login/text responses, 528 realtime checks, and 168
upload responses.

The image fixtures are real decodable files: a 500x400 PNG, an orientation-6
3000x1500 JPEG, a two-frame GIF whose first pixel is red, an 8x4 AVIF, a
4096-edge PNG, and a small-`ispe` container carrying a 4097-edge AV1 payload.
The harness compares status, JSON, dimensions, orientation, stripped metadata,
and first-frame color. Lossless WebP bytes differ from Sharp quality 75.

The oversized AVIF paths logged `avif picture allocations=0 reason=ispe` and
`avif picture allocations=0 reason=dav1d Unknown error -34`. Preview of a
stored TS thumbnail did not add a file or change quota. Concurrent uploads
stopped at the quota. A client disconnect left no item. Restart preserved the
uploaded file.

Room and share preview, HEIC decode, AVIF mirror, 10/12-bit and animated AVIF,
and a public maintenance route remain out of scope. Private-space chunk
sessions are covered above. The
1 MiB thumbnail write cap is checked and was not reached by a 320-edge image.
A clean body shorter than Content-Length returns UPLOAD_INCOMPLETE; an
HTTP/1.1 close of a short Content-Length is a stream error and returns 404.
The upload harness does not open a WebSocket. File create and delete use the
same publish calls as text.

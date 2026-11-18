# Rust password, machine-access, text and browser service

RHEA-227 adds the first runnable Rust slice of the migration. The HTTP reference is
the TS server at commit 37ce06ebfab2cd98b81e49ce54fb24ec5daeec68. Source contracts are
in ../CONTRACT.md, ../DECISIONS.md and ../MAP.md.

The implemented routes include GET /healthz, password login/logout, browser
account and private-space text routes, PAT management under /api/tokens,
device authorization under /api/auth/device, and the one-time WebView handoff
under /api/app-session. Existing file reads and the private-space WebSocket
are also retained.
RHEA-230 adds GET /api/site, /api/version, /api/auth/providers, /api/setup
and GET /api/spaces/:space/ws.

Existing password hashes, user/space IDs, browser sessions, membership roles,
quota overrides, persisted limits, text, groups and device metadata retain the TS
representation. Private-space access from another account returns 404.
Viewer writes return READ_ONLY. Temporary-password sessions retain the
PASSWORD_CHANGE_REQUIRED restriction. Password verification applies NFKC and
scrypt, with constant-time derived-key comparison and dummy work for missing
accounts. Session secrets are random 32-byte base64url strings, stored as
base64url SHA-256 hashes. Machine credentials use the same 32-byte base64url
format. Only token digests are stored in access_tokens and
device_authorizations. Bearer authentication takes precedence over a cookie,
enforces read/write scopes before routing, and does not use browser Origin
checks. Browser-only token administration and device approval still require a
cookie session. Revocation, expiry and account disablement are rechecked for
writes and live WebSocket connections.

## Build and validate

Rust 1.94.0 is pinned in rust-toolchain.toml. A C compiler is required for bundled
SQLite. Node 22, pnpm, git and tar are required to generate the reference fixtures
and run the compatibility tests. The baseline Git object must be available locally.
The Rust executable runs independently of Node.

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
binary. It also runs tests/files-http.rs and tests/machine-auth.rs, which launch
the fixed TypeScript fixture and exercise file and machine-access compatibility.
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
cargo clippy --locked --all-targets -- -D warnings passed. The fixed-history
HTTP harness checked 199 real responses, the file harness checked 228 responses,
and the machine-auth harness checked PAT scopes and precedence, device approval,
concurrent one-time consumption, one-time WebView tickets and disablement. The
cases include wrong and missing credentials,
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
RATE_GENERAL, RATE_AUTH, RATE_UPLOAD and RATE_TOKEN. Corresponding runtime_limits entries
override them at startup. Account quota overrides and active upload reservations
contribute to capacity checks. Expired items are excluded from snapshots.

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

Upload, chunked upload, preview, dynamic image re-encode, AVIF decode, share
links and rooms remain outside this slice.

## Machine access slice (RHEA-234)

`src/machine.rs` ports the schema-19 access token and device authorization
records. `POST /api/tokens` returns a raw PAT once; listing, renaming, revoking,
purging and the admin token list never return it. `read` is required for safe
requests and `write` for mutations. `POST /api/auth/device/authorize` is public
for CLI clients, while the user-code page and approve/deny actions require a
browser session. Polling preserves pending, slow_down, denied and expired
responses, and an immediate SQLite transaction allows only one concurrent poll
to consume an approved flow.

`POST /api/app-session/ticket` accepts only a live bearer token with `web`; the
hashed ticket is kept in memory for 60 seconds and is consumed before the token
is checked again. A valid ticket creates a normal browser cookie only when the
request has no browser session or currently has a bearer session. This keeps an
existing browser account from being replaced by an app token.

The independent machine harness is:

~~~sh
cargo test --locked --test machine-auth -- --nocapture
~~~

It builds the fixed TS reference, generates a schema-19 fixture, creates and
reads credentials on both implementations, exercises cookie/Bearer precedence,
scope failures, concurrent device consumption, a one-time WebView ticket and
account disablement, and checks that raw credentials are absent from SQLite.
The disablement case updates the synthetic fixture directly; this slice does not
add an incomplete admin-user API. The same harness runs the existing CLI's
`login`, `whoami`, `send` and `ls` commands against the Rust process.

## Coverage boundary

OAuth, registration/setup writes, password changes, session-management APIs,
room APIs, file and chunked uploads, sharing, the remaining admin APIs, static web hosting,
update endpoints and historical schema upgrades remain outside this
slice. Unsupported routes return the existing JSON NOT_FOUND form. An invalid
Authorization header returns UNAUTHENTICATED with WWW-Authenticate instead of
falling back to a cookie.

Periodic expiration/garbage collection and live admin-setting updates are also
pending. Expired records are filtered from reads but are retained in storage and
capacity totals until the TS maintenance implementation cleans them. The slice
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

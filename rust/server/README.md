# Rust password and text service

RHEA-227 adds the first runnable Rust slice of the migration. The HTTP reference is
the TS server at commit 37ce06ebfab2cd98b81e49ce54fb24ec5daeec68. Source contracts are
in ../CONTRACT.md, ../DECISIONS.md and ../MAP.md.

The implemented routes are GET /healthz, POST /api/auth/password/login,
POST /api/auth/logout, GET /api/me, GET /api/spaces, GET /api/spaces/:space,
GET /api/spaces/:space/items and POST /api/spaces/:space/items/text.

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
SQLite. Node 22 and pnpm are required to generate the reference fixtures and run
the compatibility tests. The Rust executable runs independently of Node.

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
binary. The same harness can be invoked from the repository root with
node rust/server/tests/compat.mjs. RUST_SERVER_BIN can select a release build.

The harness generates schema 19 using the original SqliteRepository,
hashPasswordSync, ClipboardService and session creation code. Each implementation
gets a separate copy of that TS-generated fixture. It starts real HTTP processes,
checks status/JSON/security headers/cookies, then kills and restarts each process
against its original files. It also starts TS on the Rust-written database,
reads Rust sessions/text, writes through TS again, and reads those writes through
Rust. The original TS sources and pnpm lock are checked against the recorded
baseline before running.

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
--nocapture passed its one process-level integration test, checking 139 real HTTP
responses across TS and Rust. The cases include wrong and missing credentials,
JSON/body limits, CSRF, disabled and pending users, viewer/temporary-password
restrictions, Unicode metadata, logout, an abrupt process restart, bidirectional
TS/Rust data and sessions, eight concurrent quota-limited writes, item capacity,
production cookies, trusted-proxy origin, auth rate limits and session expiry.

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
RATE_GENERAL, RATE_AUTH and RATE_UPLOAD. Corresponding runtime_limits entries
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

## Coverage boundary

OAuth, PAT/device-code authentication, registration/setup, password changes,
session-management APIs, room APIs, WebSocket broadcasts/revocation, file and
chunked uploads, downloads/Range/media, sharing, admin APIs, static web hosting,
version/update endpoints and historical schema upgrades remain outside this
slice. Unsupported routes return the existing JSON NOT_FOUND form. An
Authorization header selects the unsupported bearer path and returns
UNAUTHENTICATED with WWW-Authenticate instead of falling back to a cookie.

Periodic expiration/garbage collection and live admin-setting updates are also
pending. Expired records are filtered from reads but are retained in storage and
capacity totals until the TS maintenance implementation cleans them. The slice
requires a schema-19 fixture and provides no first-run database bootstrap.

The tests establish the documented password/private-text HTTP flow and
bidirectional database compatibility for synthetic schema-19 data. Browser
readiness, complete migration, historical upgrades and production performance
remain unverified.

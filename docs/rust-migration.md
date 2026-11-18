# Rust migration runtime boundary

The Rust candidate opens `DATA_DIR/dropit.sqlite` with the TypeScript schema as
its compatibility target.  A new or historical database is upgraded atomically
through schema 19 before the listener starts.  Databases below schema 17 are
copied with `VACUUM INTO` beside the original file before migration 16 rebuilds
the spaces table.  The backup name is
`dropit.sqlite.pre-v<old-version>-<timestamp>.bak`; keep it until the new
process has passed the isolated compatibility checks.

Startup loads `appOrigin`, all persisted `runtime_limits`, OAuth provider rows,
and the existing audit tables.  Persisted runtime limits take precedence over
environment defaults and are validated with the same cross-field constraints as
the TypeScript service.  OAuth credentials remain in SQLite in their existing
schema and are only used for the provider availability read; OAuth login and
the management write APIs are not part of this candidate.

Maintenance runs once before serving and then every `CLEANUP_INTERVAL_MS`
(default 60 seconds).  It removes expired items, rooms, sessions, flows, device
authorizations, invites, and upload sessions in one transaction.  Content and
chunk keys are first inserted into `garbage`; unlink failures remain queued for
the next pass.  An unreferenced valid storage object older than one hour is
removed after the database pass.  The database queue and referenced-key check
make cleanup safe across process restarts.

`/healthz` performs a SQLite probe and returns `{"status":"ok"}` only while the
process and its database are usable.  SIGINT and SIGTERM stop accepting work,
close live WebSockets, finish the maintenance task, and run one final cleanup
pass.  Logs are written to stdout/stderr for Docker or systemd collection.

## Rust candidate image

`Dockerfile.rust` builds the React static files and the Rust binary in separate
stages.  The runtime image contains the Rust executable, static Web output, the
AVIF runtime library, `/data` owned by an unprivileged `dropit` user, and a
database-backed healthcheck.  `compose.rust.yml` uses a separate project,
container, port, and volume so acceptance cannot touch production data:

```sh
docker compose -f compose.rust.yml build
docker compose -f compose.rust.yml up -d
docker inspect --format '{{.State.Health.Status}}' dropit-rust
```

Use a copy of a synthetic schema-19 fixture for compatibility checks.  Before
any real deployment, back up the complete data volume (SQLite plus `files/`),
build the image in isolation, check `/healthz` and volume permissions, and keep
the previous image available for rollback.  The existing `Dockerfile` and
`compose.prod.yml` still run the TypeScript service until the final client and
container acceptance task approves the switch.

## Deliberate migration boundary

The Rust candidate does not claim the TypeScript administration surface.  The
following remain outside this delivery and must stay on the explicit migration
gap list: OAuth login/callback and setup/registration writes, `/api/admin/site`,
`/api/admin/oauth`, `/api/admin/limits` mutation/audit reads, user/session
management, update distribution, and the `dropit-admin` CLI.  Existing rows and
settings are preserved so a later Rust slice can consume them without a schema
rewrite.

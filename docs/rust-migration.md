# Rust runtime and release handoff

The standard `Dockerfile` now builds React static Web and the Rust server in
separate stages. Node/pnpm remain build and reference-test tools; the runtime
contains no Node. `Dockerfile.rust` is a compatibility symlink to `Dockerfile`.
`docker-compose.yml`, the repository reference `compose.prod.yml`, CI image
verification and gated main/tag publishing all use this standard build.
The deployed host's untracked compose file is a separate release-owner concern.
This change neither publishes an image nor approves a production switch.

The image installs `dropit-server` and `dropit-admin` (a symlink selecting the
offline entry point in the same executable). Admin dispatch happens before
configuration/bootstrap/listeners/maintenance, so it needs only `DATA_DIR`.
Existing invocation remains:

```sh
docker exec dropit dropit-admin list-users
docker exec dropit dropit-admin reset-password admin@example.com
```

Help/exit codes, tab-separated account state and password reset behavior follow
TS `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`. Temporary passwords use the same
12-character readable alphabet and 4-4-4 grouping, scrypt/NFKC, force a password
change and revoke account sessions. Disabled accounts remain disabled. Password
and session changes commit together. Protect the command's terminal output.
For local execution, create a `dropit-admin` symlink beside `dropit-server`;
without `DATA_DIR`, source execution defaults to the repository `data` directory.

## Data and implemented behavior

`DATA_DIR/dropit.sqlite` upgrades atomically through schema 19 before listening.
Pre-17 nonempty databases receive a `VACUUM INTO` snapshot beside the database,
`dropit.sqlite.pre-v<version>-<timestamp>.bak`. This DB-only snapshot does **not**
replace a complete volume backup. Uploaded objects and `files/` remain unchanged.
OAuth/setup/registration, account management, site/limits/provider management,
update distribution and the original offline CLI are now implemented. See
`rust/MAP.md` for each independently accepted slice and its limitations.

Persisted settings override environment defaults. `/healthz` probes SQLite.
Maintenance removes expired rows transactionally and queues object cleanup in
`garbage`, retrying unlink failures. SIGTERM/SIGINT close the listener and live
sockets, finish maintenance and perform final cleanup. Logs go to stdout/stderr.
`PORT=8787`, `HOST=0.0.0.0`, `DATA_DIR=/data`, `STATIC_DIR=/app/public` remain the
image defaults; build metadata is available through `/api/version` and OCI labels.

The runtime user `dropit` has UID/GID **1000:1000**, matching the previous Node
image's `node` user. This preserves access to old 0700 data directories without
a root entrypoint or recursive ownership change. Earlier candidate images used
10001:10001: test those copies explicitly; they are not automatically compatible.
For a custom historical UID, the release owner must verify ownership and
configure a matching UID/GID or migrate a **copy** first. Never chmod data 0777.

## Isolated verification

```sh
cargo fmt --manifest-path rust/server/Cargo.toml --check
cargo clippy --manifest-path rust/server/Cargo.toml --locked --all-targets -- -D warnings
cargo build --manifest-path rust/server/Cargo.toml --locked
cargo test --manifest-path rust/server/Cargo.toml --locked --test admin -- --nocapture
# Full fixed-TS HTTP/WebSocket regression is also available through cargo test.
# Metadata must be valid semver, a 7–40 digit hex revision and an RFC3339 date.
docker build -t dropit:rust-check --build-arg DROPIT_VERSION=0.1.0+246 \
  --build-arg DROPIT_COMMIT="$(git rev-parse --short=7 HEAD)" \
  --build-arg DROPIT_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
sh scripts/check-rust-image.sh dropit:rust-check
```

The admin harness archives the fixed TS commit, builds it with its frozen lock,
creates disposable SQLite fixtures, compares outputs/exits and validates Rust
password hashes using TS. It tests actual login/forced-change/session revocation.
For a repeatable full-volume rehearsal (requires a saved TS image), run:

```sh
ADMIN_FIXTURE_OUT="$PWD/rust/server/data/volume-fixture" \
  cargo test --manifest-path rust/server/Cargo.toml --locked --test admin -- --nocapture
python3 scripts/check-rust-volume.py rust/server/data/volume-fixture \
  dropit:rust-check <saved-TS-image-or-digest>
```

It creates/deletes only uniquely named test containers/volumes, checks real TS
schema-15 migration and its backup, restores every file with matching SHA256,
and tests TS→Rust→TS text/file read/write plus image-installed password recovery.
`compose.rust.yml` offers a separate project/port/volume for additional checks;
use a checkout with no real `.env`, and supply only synthetic credentials.

## Release and rollback runbook (release owner only)

Do not run the following against production from a development/acceptance task.
Before rollout, RHEA-243 upload concurrency and RHEA-245 Unicode compatibility
must be resolved and integrated, followed by final regression on the combined
head and image. This packaging delivery alone is **not** full migration acceptance.
Keep the old immutable TS image digest and a complete backup until acceptance.
Disable automatic updates while validating the migration.

Set `container`, `volume`, `old_image` and `new_image` from the reviewed actual
host configuration. Never assume the host compose matches the repository copy.
Record its resolved config securely (it can contain credentials), image digest,
UID/GID and volume identity. First rehearse these steps with synthetic data:

```sh
# Stop writers before backing up SQLite + WAL/SHM + all uploaded files.
docker stop "$container"
mkdir -p backups
backup="dropit-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
docker run --rm --user 0 --entrypoint sh \
  -v "$volume":/source:ro -v "$PWD/backups":/backup "$old_image" \
  -ec 'cd /source; tar czpf "/backup/$1" .' sh "$backup"
# Restore to a NEW volume; never overlay/partially restore a live volume.
restore_volume="${volume}-restore-check"
docker volume create "$restore_volume"
docker run --rm --user 0 --entrypoint sh \
  -v "$restore_volume":/restore -v "$PWD/backups":/backup:ro "$old_image" \
  -ec 'cd /restore; tar xzpf "/backup/$1"' sh "$backup"
```

Use the restored copy with the new image under a unique container name and
loopback port, synthetic OAuth configuration and automatic update checks off.
Verify non-root read/write, old accounts/text/files, schema, admin recovery,
static Web, build metadata, health and graceful stop. Reopen that same copy
with the saved TS image and verify existing and new text/file read/write.
For actual rollout after authorization, use the established host deployment
procedure with the reviewed immutable new image. Verify readiness before nginx
traffic resumes, then repeat login/upload/download and backup checks.

If rollback is needed, stop the Rust container, preserve its volume for diagnosis,
and run the saved TS image with the pre-cutover restored volume and the saved
host config. Never run two servers on one SQLite volume. Writes made after the
backup require an explicit recovery decision: restoring that backup loses them.
Do not run `compose up --build` for rollback: it would rebuild the Rust Dockerfile.
Use the saved TS image/digest and a compose override without a build invocation.

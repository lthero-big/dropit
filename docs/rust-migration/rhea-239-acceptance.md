## RHEA-239 Rust migration acceptance

Date: 2026-11-18

Integration branch: `migration/rhea-226-rust`

Tested commit: `541d59a3f903241c1e6b5595ab493d9164c4b3cf`
Environment: Node 22.22.0, pnpm 11.1.0, Rust/Cargo 1.94.0, Docker 29.1.2

This report uses isolated fixtures and local containers only. No production data, credentials, merge to `main`, or deployment was used.

### Evidence that passed

- Rust: `cargo fmt --all -- --check`, strict locked clippy, and locked build passed.
- Rust compatibility: the serialized locked suite passed 10 unit tests, 228 file HTTP responses, 199 login/text responses, 527 realtime HTTP/WebSocket checks, 316 room/share checks, and 353 upload/preview/retract/chunk checks. The checks use the fixed TypeScript reference commit `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`, including TS→Rust and Rust→TS persistence cases.
- Web: Rust browser smoke passed 3 tests; the one TS-only provider test was skipped. Web tests passed 248/248 with two workers.
- Clients: CLI tests passed 42/42; Android client protocol tests passed 13/13.
- Repository checks: `pnpm lint` and `pnpm typecheck` passed. Lint emitted existing warnings in the TS server and Web files; no lint error occurred. The Rust image build also completed the production Web build.
- Docker build: `docker build -f Dockerfile.rust -t dropit:rust-rhea239 ...` passed. The candidate runtime health endpoint returned 200, the process ran as UID/GID 10001 (`dropit`), `/data` was mode 700 and writable by that user, static Web content was served, and SIGTERM produced exit code 0 with no OOM kill.

The integrated authentication and maintenance work was also present in this run. RHEA-240's mock OAuth and account lifecycle evidence is recorded in `rust/MAP.md`; the current Rust suite includes its expanded authentication surface and migration tests.

### Reproduce

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
cd rust/server
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked -- --nocapture --test-threads=1
cd ../..
node rust/server/tests/browser.mjs
pnpm --filter @dropit/web test --maxWorkers=2
pnpm --filter @lthero-big/dropit-cli test
(cd mobile && npm test)
docker build -f Dockerfile.rust -t dropit:rust-rhea239 --build-arg DROPIT_COMMIT="$(git rev-parse --short=7 HEAD)" .
```

### Release decision and remaining gaps

The Rust candidate image is operationally ready for isolated acceptance, but the production cutover remains **no-go**. `compose.prod.yml` still selects the existing TypeScript `Dockerfile`; changing production to `compose.rust.yml` is a separate release decision. The latest migration record still lists item editing/labels/groups, share presets, room chunk sessions, and update distribution as compatibility gaps. The Rust README also records the unpaired-U+D800 JSON difference as an unverified boundary. The Android result is protocol-level unit coverage; no emulator or signed APK release test was run.

Keep the existing TS image and data volume until those protocol gaps are explicitly accepted and the release owner approves the Rust compose cutover. No production data, credentials, main merge, or deployment was used in this acceptance.

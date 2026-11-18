## RHEA-239 Rust migration acceptance

Date: 2026-11-18  
Integration branch: `migration/rhea-226-rust`  
Tested commit: `b9f8e1ae74f5582015e1cda97027c022f5546d07`  
Environment: Node 22.22.0, pnpm 11.1.0, Rust/Cargo 1.94.0, Docker 29.1.2

This report uses isolated fixtures and local containers only. No production data, credentials, merge to `main`, or deployment was used.

### Evidence that passed

- Rust: `cargo fmt --check`, strict locked clippy, and locked build passed.
- Rust compatibility: the serialized locked suite passed 7 unit tests, 228 file HTTP responses, 199 login/text responses, 526 realtime HTTP/WebSocket checks, 316 room/share checks, and 353 upload/preview/retract/chunk checks. The checks use the fixed TypeScript reference commit `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`, including TS→Rust and Rust→TS persistence cases.
- Web: Rust browser smoke passed 3 tests; the one TS-only provider test was skipped. The existing TS service passed 213/213 server tests and 248/248 Web tests with two workers.
- Clients: CLI tests passed 42/42; Android client protocol tests passed 13/13.
- Repository checks: `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed. Lint emitted existing warnings in the TS server and Web files; no lint error occurred.
- Docker build: `docker build -t dropit:rhea-239 ...` passed. The runtime image health endpoint returned 200, the process ran as UID/GID 1000 (`node`), `/data` was writable by that user, and SIGTERM produced exit code 0 with no OOM kill.
- Docker black-box checks: after updating the stale room capability assertion, all checks in `scripts/acceptance-docker.mjs` passed, including CSP/security headers, loopback publishing, room capability and expiry, file/download safety, rate limits, WebSocket origin/realtime, and SPA fallback.

The first serialized Rust suite run hit the existing file-stream timing assertion (`stream should hold the file while the body is open`). The isolated `files-http` rerun passed all 228 responses, and the following serialized full suite passed. The failure is retained as a host scheduling signal; it is not counted as a product compatibility difference.

### Change in this acceptance PR

`scripts/acceptance-docker.mjs` now validates the current room capability contract (`UUID.proof` plus a six-character room code). The previous assertion decoded the capability as an old 32-byte base64url token and produced a false failure against the integrated RHEA-236 protocol. No product runtime code changed.

### Reproduce

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
cd rust/server
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cargo test --locked -- --nocapture --test-threads=1
cd ../..
node rust/server/tests/browser.mjs
pnpm --filter @dropit/server test
pnpm --filter @dropit/web test --maxWorkers=2
pnpm --filter @lthero-big/dropit-cli test
(cd mobile && npm test)
docker build -t dropit:rhea-239 --build-arg DROPIT_COMMIT="$(git rev-parse --short=7 HEAD)" .
DROPIT_IMAGE=dropit:rhea-239 node scripts/acceptance-docker.mjs acceptance/rhea-239/docker-blackbox
```

### Release decision and remaining gaps

The current commit is **not ready to switch the production container to Rust**. `Dockerfile` still builds the Node/TypeScript server and starts `node dist/index.js`; it does not compile, package, or start `rust/server`. The passing Docker evidence therefore proves the current TS image's container contract, not a Rust release image.

The Rust candidate also still has explicit migration boundaries for OAuth/account setup writes, full administration, historical schema upgrades, scheduled maintenance/cleanup, and final release packaging. Historical data migration, maintenance, backup/recovery rehearsal, and Rust image packaging remain owned by RHEA-238, which was still running during this acceptance. The Android result is protocol-level unit coverage; no emulator or signed APK release test was run.

Recommended fallback is to keep the existing TS image and data volume while RHEA-238 completes the Rust migration/maintenance and image packaging evidence. Re-run this report from the resulting integration commit before considering a Rust cutover.

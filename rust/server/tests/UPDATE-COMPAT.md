# RHEA-244 update compatibility

Repair of PR #94 review head 8079cee. Implementation/test commit: d342a2297383546935fdc4f1391581aa4b04105b.

The existing Web admin report, Android manifest and server build-info contracts remain the targets. The CLI has no separate updater/version feed in the TS baseline; its existing protocol suite is the regression surface. Android publishes one operator-selected APK, not a platform/CPU artifact matrix. Unknown platforms keep the TS 404 behavior. The optional Android force/minimum policy is advisory to old clients that predate these fields, and enforced by the updated shell. It is not a server-wide minimum-client-version gate.

## Repairs

- Parse GitHub owner/repo case independently from lowercase Docker image names, trim configured sources, apply defaults to empty sources, and accept finite fractional hours within the TS 6–168 hour interval.
- Forced/minimum-code offers override stored skipped versions. Actual startup/click handlers are exercised with a minimal DOM/native bridge; both dismissal handlers also refuse a forced offer.
- Validate manifest types, first filename/version characters and UTF-16 lengths as TS, including null/default behavior. Unknown APK names return `NO_RELEASE`. Integer JSON numbers with decimal notation remain valid.
- Disabled checking ignores cache and reports no next check. Concurrent checks coalesce even on errors, manual checks reuse recent successful results, different builds invalidate persisted cache, and unavailable Docker compare responses retain `available` / `COMPARE_UNAVAILABLE`.
- APK bodies use `ReaderStream`, preserving backpressure and dropping the file when the reader disconnects. The 200 MiB slow-read regression limits RSS growth to 64 MiB and checks `/proc/<pid>/fd` after abort.
- Network test URLs and clocks are injected only inside Rust unit tests. Production source hosts remain fixed GitHub/Docker Hub endpoints.

## Reproduction

From the repository root:

```sh
cargo fmt --manifest-path rust/server/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/server/Cargo.toml --locked --all-targets -- -D warnings
cargo build --manifest-path rust/server/Cargo.toml --locked
cargo test --manifest-path rust/server/Cargo.toml --locked -- --nocapture --test-threads=1
pnpm --filter @dropit/server exec tsc --noEmit
pnpm --filter @dropit/server exec tsx --test test/rhea190-app-update.test.ts test/update-check.test.ts
pnpm --filter @dropit/web test --maxWorkers=2
pnpm --filter @lthero-big/dropit-cli test
node --test mobile/test/*.test.js
```

The Rust update HTTP test launches an actual Rust process against the TS backend at this checkout, using isolated data, public/admin requests, manifest boundaries, build/config inputs and a slow/aborted 200 MiB download. Existing migration harnesses retain their fixed historical TS reference 37ce06eb.

For an isolated container check, after a locked build:

```sh
RUST_UPDATE_CONTAINER_IMAGE=dropit:rust-rhea239-review \
RUST_SERVER_BIN="$PWD/rust/server/target/debug/dropit-server" \
node apps/server/node_modules/tsx/dist/cli.mjs rust/server/tests/update-http.mts
```

This tests the current binary mounted read-only in the previously accepted non-root Rust runtime image (ID `sha256:de7e6c06ba77419e4c3ccf9c9eb2b4230c81b02cb04e9af12ae71d43b94c3072`). It is a runtime compatibility test, not a new image publication or a repeat of Docker packaging acceptance. Only fresh temporary data and ephemeral loopback ports are used; all child processes/containers and test data are removed.

The Android server validates SHA-256 metadata format and manifest size. The native installer verifies downloaded bytes against that hash before installation; the server does not recompute an APK hash on every request.

## Local results (2026-11-19)

- fmt check, strict all-target locked clippy and locked build passed.
- Complete serialized locked cargo test passed: 12 unit tests, auth/mock OAuth, 228 file HTTP responses, 199 auth/text responses, machine-auth/CLI, 526 realtime HTTP/WS checks, 316 room/share checks, new update HTTP comparisons and 353 upload/chunk responses.
- Targeted controlled-network/clock update tests also passed after adding TIMEOUT and NETWORK failure assertions.
- Container update fixture: all comparison cases identical, zero differences; permissions, SHA metadata/exact bytes, 200 MiB slow read, abort and file-handle release passed.
- Server typecheck and update tests 13/13; full Web 248/248 (2 workers); CLI 42/42; Android JS 15/15 including both forced-startup interaction cases.
- No production data, credentials or deployment were used. No image was published and no branch was merged.

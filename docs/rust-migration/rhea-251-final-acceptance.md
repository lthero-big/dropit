# RHEA-251 — fixed-source Rust acceptance

This entry point accepts a commit and a new report directory outside the checkout:

```sh
node scripts/rust-final-acceptance.mjs "$(git rev-parse HEAD)" ../rust-final-$(date +%Y%m%d-%H%M%S)
```

Use a dedicated checkout at the requested commit. Commit script changes before running. A dirty tree, a different HEAD, or later source drift fails. Reports must be a new directory; existing evidence is never overwritten. Node 22+, pnpm, Rust's locked toolchain, native libdav1d development libraries, Python 3, Docker and Google Chrome must be available. Playwright Chromium is installed by the entry point. No production credentials are needed.

The standard Dockerfile is built from `git archive COMMIT`, with explicit build metadata. The manifest records source SHA, binary SHA-256, OCI revision and immutable Docker image ID. All Rust black-box containers use this image ID. Source suites build a fresh binary in a new target directory; their fixed historical TS references are comparison fixtures, not the tested Rust runtime. Commands, timestamps, exit codes and failures are retained per group. A failed group keeps the overall result red. Inspect `manifest.json`, individual logs, `docker.json`, browser JSON, Playwright JSON and PNG evidence.

Coverage is deliberately labelled:

| Group | Runtime and coverage |
| --- | --- |
| Rust integration targets | Same-source fresh binary; mock OAuth, HTTP/WS and revocation, Unicode, item/group/tag protocol, sharing, upload/download/preview/retract, actual CLI device login and commands, mobile WebView tickets, update HTTP and offline admin |
| Image runtime | Standard Rust image; no Node, metadata, static Web, health, UID/GID 1000, data mode, SIGTERM |
| Docker black-box | Same image ID; headers/origin, room capability, upload/download/media rejection, quota, WS, storage keys |
| Browser smoke | Same image ID/static Web; real password login, send, refresh/logout, independent browser realtime/reconnect and item/group editing; one existing TS proxy-only assertion is explicitly skipped |
| Browser files | Same image ID; desktop/mobile viewport, room text/copy/paste/upload and inline preview restrictions; clipboard API is stubbed and paste is synthetic, not OS clipboard validation |
| Volume rehearsal | Same Rust image ID plus separately built historical TS image; schema 15→19, historical text/files, UID/GID, complete offline backup/restore, TS rollback reads/writes, installed admin reset |

No physical mobile UI is tested. Browser OAuth is not a live provider test. Tags and sharing coverage is protocol-level where existing Web controls do not expose it. Existing integration suites can pass before RHEA-243 is merged; this never accepts its missing room-chunk/cleanup implementation. The parent must rerun the final integrated commit after #97 is accepted. This task neither replaces nor resets its exhausted 3/3 review rule.

Every run removes its uniquely named containers with their anonymous volumes, unique image tags, browser profiles, generated fixtures and fresh build directory in cleanup. Reports remain; Docker build cache and downloaded dependency/browser caches remain reusable. It does not use production ports/names/volumes, push images, merge branches or deploy.

## Actual execution — 2026-11-24

**This is a completed harness delivery, with an overall FAILED baseline result. It is not final migration acceptance.** No backend business code, schema, API, Dockerfile or release workflow changed.

The checkout derives from integration commit `b18b5079cdb8e1851f903eeae1aba6595c63183e`. The preserved Neon patch was downloaded using the authenticated Multica CLI, verified against SHA-256 `7c5138bc5da1367ce7885547cfc0a93a737a68ebc461e08ae32b96fddd763b0a`, and applied in this separate managed checkout. The old Neon checkout was untouched.

The complete second run tested source `4cdba238a8553dae955b33e6b28b824edc593778` and standard Rust image `sha256:39ec15b73109d1ce4e7259abc34e801863e5b21e41bbf1150f11046dcaeaac52`. OCI revision is the full source SHA; `/api/version` intentionally normalizes it to seven characters. Binary SHA-256: `38bc78756086fff99b478de5675924c7e022d42ff75af7eac41280eb0008615c`. Run interval: 2026-11-24T16:51:16.361Z to 2026-11-24T16:59:03.739Z. The later report-only commit does not alter the tested code.

| Group | Result | Exit code |
| --- | --- | --- |
| dependencies | passed | 0 |
| ts-clients | passed | 0 |
| playwright-install | passed | 0 |
| rust-build | passed | 0 |
| rust-image-build | passed | 0 |
| rust-tests | passed | 0 |
| image-runtime | passed | 0 |
| docker-blackbox | failed | 1 |
| browser-setup | passed | 0 |
| browser-smoke | passed | 0 |
| browser-files | passed | 0 |
| admin-fixture | passed | 0 |
| historical-ts-image | passed | 0 |
| volume-rehearsal | passed | 0 |

Rust coverage passed 17 unit tests and all 11 process integration targets. Logs include 199 login/text HTTP responses, 228 file responses, 290 item/group/tag checks, 527 realtime checks, 408 room/share checks, 690 Unicode checks and 353 upload checks. Auth/mock OAuth, CLI machine access and updates also passed. No Rust test was ignored or filtered. These existing room/upload suites do **not** contain the unmerged #97 room-chunk implementation or the final failed-thumbnail-cleanup regression.

Real image browsers passed 4 smoke tests; the one existing TS-only proxy/short-download test was skipped, with its original reason retained in `playwright.json` and `manifest.json`. Empty-install `/login` → `/setup` passed 1/1; browser file/viewport/preview checks passed 10/10. Docker black-box checks passed 27/28. The standard image runtime check passed, including no Node, static Web, UID/GID, metadata, health and SIGTERM. The same browser container passed stop/start readiness and retained its image ID.

The offline rehearsal actually reran schema 15→19 with the pre-v15 backup, old UID/GID 1000 data, TS historical text/upload reads, complete offline tar backup/restore with identical SHA-256 manifests, Rust text/file writes, same-volume TS rollback read/write, and installed admin password reset/login. Its historical TS reference is separately built from `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`; it is never substituted for the Rust candidate.

### Retained failure: OAuth rate-limit compatibility

Reproduce with the standard image and the ordinary black-box entry point:

```sh
DROPIT_IMAGE=sha256:<built-image-id> \
DROPIT_EXPECTED_IMAGE_ID=sha256:<built-image-id> \
DROPIT_EXPECTED_COMMIT=<full-source-sha> \
node scripts/acceptance-docker.mjs ../new-blackbox-report
```

The script starts a disposable container with `RATE_AUTH=3`, then requests `/api/auth/password` once and `/api/auth/github` four times with distinct X-Forwarded-For values, using manual redirect handling. Real TS from the same source checkout returns `404,404,404,429,429`, with `Retry-After: 60` on the last two. The exact Rust image returns `404,404,404,302,302`, redirects to `/login?error=RATE_LIMITED`, and omits Retry-After. The assertion still requires 429 and a Retry-After header; it remains red. See attached `rhea251-ts-oauth-rate.json`, `rhea251-rust-oauth-rate.json` and the runnable probes. Relevant source paths are `apps/server/src/backend.ts` (limit before provider resolution) and `rust/server/src/auth.rs` (OAuth start wraps the limit error as a redirect). Parent coordination is required to resolve this backend difference; this PR does not fix or silently accept it.

### Evidence, negative checks and remaining gates

The first full run on `075ae7500dcb2f598c5a23d6cbf808ef94ccd26b` is also preserved. It passed the source suite, browser smoke and volume rehearsal, but detected stale full-SHA API and `/rooms/` browser assertions as well as the real OAuth rate difference. The second full run above corrected the two harness assumptions while retaining the rate assertion. Neither run is described as fully green.

Three negative checks passed: mismatched requested HEAD is rejected before building; an untracked dirty-tree sentinel is rejected (then removed); and a deliberately wrong expected image ID fails the Docker entry and cleans its owned container. Full command output is attached. All modified MJS syntax checks, shell syntax, Web lint and diff whitespace checks passed.

`manifest.json` records every group command, source/image identity, exit codes, the browser skip and cleanup. The attached evidence archive retains both full-run manifests/logs, Docker/browser JSON, Playwright JSON, PNG screenshots, probes, negative checks and cleanup inventory. Download and extract it to inspect the evidence; runtime paths in its logs are machine-local context, not delivery links.

Both runs finished synchronously. Unique browser containers, anonymous volumes, temporary image tags, browser profiles, fixtures and fresh Cargo targets were removed. Post-run Docker inventories found no containers matching `dropit-rhea251-` or `dropit-accept-`, and no rehearsal volumes matching `dropit-rhea246-`. Dependency/browser caches and Docker build cache remain. No production directory, service, credentials, volume or host port 8787 was used.

PR #97 was still OPEN/unmerged at the captured handoff snapshot (head `22606570603e955f5cfdda8763a082f31a94ac9c`). Its original RHEA-243 3/3 review history remains unchanged. Final acceptance still requires its independent acceptance/integration, resolution of the retained OAuth difference, and a fresh full run on the final integrated commit/image. No physical phone UI, live OAuth provider, main merge, image publishing or production deployment was performed.

Tool versions (Node, repository-selected pnpm, Rust, Docker, Python):

```text
v22.22.0
11.1.0
rustc 1.94.0 (4a4ef493e 2026-03-02)
29.1.2
Python 3.12.3
```

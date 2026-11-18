# Rust server migration

Owner: RHEA-226, DE项目分析与验收员. Source baseline: `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`.

The user authorized an isolated Rust server migration with DE 前端工程师, DE 后端工程师, and DE代码高手-grok participating. React/TypeScript remains the web client. The integration branch is `migration/rhea-226-rust`; child PRs target that branch. The draft PR to `main` is the final review surface. Production deployment remains with the project's existing release owner.

## First wave

| Work | Owner | Owned paths | Independent acceptance |
| --- | --- | --- | --- |
| RHEA-227: minimal Rust password-login and text persistence service | DE 后端工程师 | `rust/server/**` | Real HTTP requests against an isolated schema-19 fixture; login, text roundtrip, restart, errors |
| RHEA-228: web development proxy selection and compatibility smoke tests | DE 前端工程师 | `apps/web/**`, related web dependency entries in `pnpm-lock.yaml` | Same web flow against a real local TS server first; proxy can target either implementation |
| RHEA-229: file/media migration design and compatibility cases | DE代码高手-grok | `rust/research/**` | Primary-source dependency assessment, existing behavior inventory, fixtures/case specification; no application implementation in this task |

All three first-wave PRs passed independent review and were merged into this branch. PR #74 provides the web proxy and browser baseline. PR #75 provides the reviewed file/media contract and implementation plan. PR #76 provides the first Rust HTTP slice, with 199 real HTTP responses checked after revision. The integration baseline is `09075d48b587cd5ce59421a82de442055a1ff46a`.

These pieces can be reviewed independently: a standalone Rust service, a working TS-backed browser baseline, and a dependency/compatibility study. This avoids two implementations of the same Rust service or competing edits to a shared Cargo workspace.

The parent issue's children are the live ownership/status records. Each child has an `in_review` wakeup targeting the coordinator, capped at three runs. Returning a child for changes preserves its assignee and stage. Unsafe or unresolved work is blocked with a concrete explanation.

## Delivery rules

- Read `DECISIONS.md` and `CONTRACT.md` before work. Do not modify this file or change a shared decision from a child PR without coordinating through RHEA-226.
- Use a dedicated branch per child. Start from the integration branch; do not push directly to it or to `main`.
- Include the child issue key in the PR title and set the PR base explicitly to `migration/rhea-226-rust`.
- Record the exact tested commit, commands, results, missing capabilities, and local fixture setup. Never describe an unimplemented route or an unexecuted test as passing.
- The installed `rust-anything` CLI may be used directly. Its 1.4.0 analysis misclassified this service as a library; HTTP recording must use the actual server entry point. Readiness scores do not establish compatibility.
- The coordinator reviews and integrates child deliveries. `main` merge and production deployment are separate release decisions.
- After requesting changes, verify that the original owner has a queued or active run. If none exists, resume the original owner's latest run once after checking current ownership and history. A `todo` status alone does not establish that execution started.
- Advance implementation when the stated technical dependencies have been independently accepted and merged. Child issues may still await human acceptance in `in_review`; do not infer an additional code dependency from that board state.
- After accepting a delivery, inspect the remaining migration work and continue coordination. Keep the parent moving through concrete implementation tasks.

## Second wave

| Work | Owner | Main paths | Independent acceptance |
| --- | --- | --- | --- |
| RHEA-230: existing-account Web login and realtime text | DE 后端工程师 | Rust browser metadata/realtime modules and their tests | Current browser login, text, two-client sync, reconnect, logout against Rust |
| RHEA-231: existing-file download, thumbnail and media Range | DE代码高手-grok | Rust downloads module and separate download fixtures/tests | Real TS/Rust HTTP byte/header/range comparisons on existing TS-created files |
| RHEA-232: Rust verification in CI | DE 前端工程师 | `.github/workflows/**` and CI instructions | Locked fmt/clippy/build/test, including the fixed-history TS/Rust reference harness |

Each task starts from the accepted first-wave baseline and can be verified independently. The two server tasks may add minimal route registration and Cargo features in their own PRs. Preserve existing shared authentication/state APIs, and coordinate any required interface change. The coordinator resolves shared registration/dependency edits during integration and reruns the relevant checks.

RHEA-231 passed its second independent review on head `aaaa1190cceca49facf86813a7f5fd980dba013b`. PR #77 was merged as `8eadad49a2e1ed4cd720d6bc95f8990c039ffd7c`. The coordinator reran Rust 1.94 fmt, strict locked clippy and locked tests: 3 download unit tests, 228 real TS/Rust file HTTP responses and the existing 199 login/text responses passed. This covers existing private-space downloads, stored thumbnails, MIME-sniffed media, GET/HEAD Range including padded numbers and unsafe-integer boundaries, authorization and file release after a client abort.

The fixture records two response-framing differences (Content-Length on empty 416/JSON errors) and the missing-object behavior (TS drops the download socket; Rust returns JSON 404). These remain explicit compatibility exceptions. Image generation, upload, rooms, shares and bearer access are outside RHEA-231. RHEA-230 continues under its existing owner and review rule.

RHEA-232 passed independent review on head `ba3f494cec3561424ffc7f337d1643758e542798`. PR #78 was merged as `ec458afd954002fe93889b5f0a11acc582aad43b`. The Rust CI job installs the pinned 1.94.0 toolchain with rustfmt/clippy, Node 22 and the repository's pnpm version, fetches full history and verifies the fixed TS baseline object, and runs locked clippy/build/test plus fmt. Existing `cargo test` process harnesses build their own fixed TS reference and clean their isolated processes/data. Rust/pnpm dependencies are cached and the job has a 45-minute timeout. The image job now requires both TS/Web verification and Rust verification; publishing depends on that image job. The production image still runs TS until the complete Rust migration is accepted.

The coordinator reran fmt, strict locked clippy, locked build and all 199 login/text HTTP checks on the exact #78 head. On the current downloads integration plus #78, fmt/clippy, 3 unit tests, 228 file HTTP comparisons and 199 login/text checks passed again. The tested integration tree matches the actual merge. Both remote Rust jobs passed; the head's push workflow also passed TS/Web and Docker. Its PR workflow failed the unchanged TS AC-U5 upload retransmission assertion (400 rather than 204 with a 20ms timeout). Local full `pnpm test` reproduced this and a Web upload-queue timing failure; each affected test passed alone. RHEA-235 tracks the independent stability fix; these results do not establish an all-green repository test run.

### RHEA-230 acceptance

RHEA-230 passed its first independent review on PR #82 head `39a058bff1d5738c5ea23da13f426cb2ecade60e`. The coordinator reran Rust 1.94 fmt, strict locked clippy, locked build/test, the existing 199 login/text HTTP responses, the bounded-queue unit test and 527 real HTTP/WebSocket checks. Chromium smoke against the Rust process passed 3 tests with the TS-only short-link assertion skipped; the unchanged TS backend passed all 4 smoke tests. Both runs exercised real private-space sockets, separate cookie jars, text events and reconnect snapshots.

The coordinator resolved integration conflicts with the accepted downloads and CI in candidate `b1c7b19`: retain all download/thumbnail/media and realtime routes, the combined Tokio fs/io/time features, both dependency sets, StoredFile and cloneable Device, and the media Cache-Control override. On this candidate, fmt, strict locked clippy and locked build/test passed: 4 unit tests, 228 file HTTP responses, the original 199 login/text responses and 526 real HTTP/WebSocket checks. The live-socket suite covers groups/presence, connection and payload limits, snapshot/write races, session expiry/logout, disabled accounts, membership removal, TCP slow readers, two 30-second heartbeats and missing-pong termination. Rust browser smoke passed again (3 passed, 1 TS-only skip); Web lint/build passed with existing warnings. The final integration also retains accepted RHEA-235 commit `6883de5` and its acceptance record; neither changes the tested Rust/browser-smoke files. Test services and isolated data were cleaned up.

This accepts existing-password-account Web initialization and private-space realtime text. OAuth flows, setup/registration writes, machine access, rooms/shares, uploads, administration, historical upgrades and Rust release packaging remain separate work. Version dates support current ISO/RFC3339 build metadata; other JavaScript Date.parse inputs remain an explicit compatibility limit. The extra 256-message queue bound and five-second send deadline are documented. Keep RHEA-230 in_review for human acceptance, preserve its owner/stage and disable its completed coordinator review rule. RHEA-234 can now proceed from the accepted integration without waiting for human done.

## Third wave

| Work | Owner | Main paths | Independent acceptance |
| --- | --- | --- | --- |
| RHEA-233: private-space direct upload, image preview and file retraction | DE代码高手-grok | Separate upload/image modules and fixture/tests; minimal route/DB integration | Real TS/Rust upload-download-delete flow, derived-image dimensions/orientation/metadata/AVIF limits, authorization, quotas and cleanup |
| RHEA-234: machine access through PAT, device authorization and Web session tickets | DE 后端工程师 | Separate machine-access/auth modules, related request/DB/realtime integration and tests | Real TS/Rust HTTP/WS and current CLI, existing-token interoperability, scopes, one-time consumption, revocation and restart |
| RHEA-235: reliable existing upload timeout/queue tests | DE 前端工程师 | Existing TS/Web upload tests and necessary test instructions | Preserve timeout/cleanup/retry/cancel assertions under controlled normal concurrency; full TS/Web verification |

RHEA-233 starts from the accepted #77 integration and implements the next file behavior from the reviewed #75 plan. It can be validated using the existing cookie-authenticated HTTP service, so it does not wait for the other second-wave tasks or their human `done` state. Preserve the pending realtime owner's modules; reuse an integrated event interface where available, and identify any file-event hookup for coordinator integration. Chunked/resumable upload remains a subsequent behavior. Full authentication/machine access and rooms/shares are next coordination priorities once the relevant owners finish their current work.

RHEA-234 is the backend owner's next dispatch now that RHEA-230 has passed independent acceptance and integration, without waiting for its human `done` state. It covers one complete machine-access flow, while OAuth/account lifecycle remains separate remaining work. RHEA-235 has been independently accepted and integrated and does not modify Rust functionality. Each new child has one continuous `in_review` rule capped at three independent reviews. Reuse the existing parent coordination check at 2026-11-18 13:48:51 UTC to evaluate readiness and continue implementation; do not create a duplicate timer.

### RHEA-235 acceptance

RHEA-235 passed its first independent review on head `f2a00d67283fda54d653cfbcb6ba1a3e100bb70a`. PR #81 was merged as `6883de5b860212b8241c60cb4bad9a998c02fa23`. Only the two TS/Web test files and `docs/testing-upload-timing.md` changed. AC-U5 retains a real HTTP stalled-body timeout, checks empty persisted/received chunks, restores the fixture timeout through the existing limits API, and proves slot release with all concurrency caps set to one. The board test awaits the controlled abort rejection, checks no item is created, and advances the retention timer before waiting for the real exit animation. Product code, default limits, Rust and production configuration are unchanged.

The coordinator independently passed workspace lint/typecheck/build, all 213 server tests, and all 248 Web tests with `pnpm --filter @dropit/web test --maxWorkers=2`. Under two bounded SHA-256 CPU workers, the complete affected files passed 18/18 and 19/19. Separate temporary mutations removing the upload-slot release and queue abort each caused the intended target assertion to fail (429 rather than 204; aborted=false); both source files were restored byte for byte. The first default-concurrency `pnpm test` failed eight tests in five unchanged Web files on the shared six-CPU host (load average approximately 30); it passed the target cases and is not reported as green. The author separately recorded a normal 503-test pass and an unrelated reconnect timeout under added load. These remain distinct results, with independent logs attached to RHEA-235; no assertions, global timeouts or repository worker settings were relaxed.

RHEA-235 remains `in_review` for human acceptance with its original assignee and stage; its completed coordinator review rule is disabled. RHEA-230 has its own active independent review and controls readiness for RHEA-234; RHEA-233 continues its existing upload/image implementation. Reuse their current runs and the parent coordination check rather than starting duplicate work. Default-suite stability under extreme shared-host contention is not established by this scoped fix.

## Remaining work

Continue with full authentication/machine access, first-run and historical database upgrades, spaces/rooms/permissions, organization/sharing, uploads/image generation, runtime administration and complete data/client/container acceptance. Refine each next task against the latest accepted implementation.

The preliminary full-migration estimate is 12–20 person-days, or 15–25 with contingency. Re-estimate after the first runnable Rust slice. It is not a schedule commitment or a claim that the first wave completes the server migration.

## Third wave

RHEA-230, RHEA-231, RHEA-232, RHEA-233 and the accepted upload test stability work are integrated. RHEA-234 is the active stage-3 implementation. RHEA-235 is integrated after independent test review.

| Work | Owner | Stage | Independent acceptance |
| --- | --- | ---: | --- |
| RHEA-234: PAT, device code and app session tickets | DE 后端工程师 | 3 | Existing CLI/mobile device login and scoped machine access work against TS-created data and Rust, including revocation and one-time tickets |
| RHEA-233: direct upload, image preview and retract | DE代码高手-grok | 3 | Existing private-space upload, preview and retract behavior with real TS/Rust comparisons |
| RHEA-236: spaces, rooms and sharing | DE 后端工程师 | 4 | Members, roles, rooms, PINs, share links and revocation preserve client-visible behavior |
| RHEA-237: resumable uploads and image processing | DE代码高手-grok | 4 | Chunk concurrency, resume/cancel, quota atomicity, cleanup and image boundary behavior |
| RHEA-238: historical migration and maintenance | DE 后端工程师 | 4 | Schema 1–19 upgrades, cleanup, runtime settings, graceful shutdown and isolated image/container checks |
| RHEA-239: final client and container acceptance | DE 前端工程师 | 4 | Web/CLI/mobile protocol checks, CI evidence, Docker health/volume/signal checks and release report |

Stage 4 items are backlog until their stated stage-3 data/auth/upload boundaries are integrated. They have separate owners and independent acceptance surfaces. Promote them as dependencies become real, and keep the parent in progress through final acceptance.

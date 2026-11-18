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

## Remaining work

Continue with full authentication/machine access, first-run and historical database upgrades, spaces/rooms/permissions, organization/sharing, uploads/image generation, runtime administration and complete data/client/container acceptance. Refine each next task against the latest accepted implementation.

The preliminary full-migration estimate is 12–20 person-days, or 15–25 with contingency. Re-estimate after the first runnable Rust slice. It is not a schedule commitment or a claim that the first wave completes the server migration.

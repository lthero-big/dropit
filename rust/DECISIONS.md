# Migration decisions

## ADR-001: Scope and delivery branch

Status: accepted for implementation on 2026-11-18, based on the user's RHEA-226 instructions to start the Rust migration in a new branch and involve frontend/backend agents and Grok.

Migrate the server while retaining the React/TypeScript web client and existing CLI/mobile clients. Use `migration/rhea-226-rust` for integration and separate child branches/PRs for work. Do not add unrelated product features, change production infrastructure, or deploy from a child task.

## ADR-002: Preserve the existing compatibility boundary

Status: implementation default, 2026-11-18; material behavior changes require a recorded decision on RHEA-226.

Keep SQLite and local files. Preserve public API/status/error semantics, browser sessions, PAT scopes, WebSocket messages, config variables, and data layout. The first slice must read schema 19 test fixtures produced by the TS implementation. Historical database upgrades remain part of final acceptance; supporting the current schema alone is not complete migration coverage.

## ADR-003: Rust service organization

Status: implementation default, 2026-11-18.

Use a standalone crate under `rust/server/`, with Tokio and Axum as the server foundation. The backend owner selects and locks a SQLite implementation after checking existing transaction/connection behavior; record that choice in the crate's README. Keep blocking database, password hashing, and image work off asynchronous request workers as appropriate. Commit the crate's lockfile and document its Rust toolchain.

Do not add a shared Cargo workspace in this first wave. Other owners have no need to edit the backend crate. The final server should run without Node; an intermediate recorder or local reference server may still use TS.

## ADR-004: Evidence of equivalence

Status: implementation default, 2026-11-18.

Use the existing TS implementation as the behavior reference. Compare real HTTP status, relevant headers, JSON/error codes and state transitions. Normalize only explicitly identified nondeterministic values; preserve their cross-request relationships. WebSocket, concurrent uploads, interrupted transfers and historical upgrades need dedicated tests. Image equivalence criteria must be specified before changing encoders; byte-identical output is not assumed.

## ADR-005: First-wave parallel boundaries

Status: implementation default, 2026-11-18.

The backend owner implements the minimum Rust service; the frontend owner provides independently runnable TS-backed browser/proxy acceptance; Grok investigates file/media alternatives and proposes implementable compatibility cases. Research does not silently authorize a separate media implementation. Each owner submits a PR against the integration branch and leaves shared migration decisions to the coordinator.

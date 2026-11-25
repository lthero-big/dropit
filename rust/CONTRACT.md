# First-wave compatibility contract

Source of truth: TS code at `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`, particularly `apps/server/src/backend.ts`, `repository.ts`, `password.ts`, `service.ts`, and the existing tests. This file defines a minimum slice, not the full API.

## Backend slice

Implement the current response/cookie/error behavior needed for:

- `GET /healthz`
- `POST /api/auth/password/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/spaces`
- `GET /api/spaces/:space`
- `GET /api/spaces/:space/items`
- `POST /api/spaces/:space/items/text`

Use an isolated SQLite fixture created by the TS implementation, containing a known password user, session metadata, a private space and sample text. Never use live data or credentials. Preserve NFKC password normalization and the existing `scrypt$N$r$p$salt$key` format. Existing user/space identity and ownership must survive. Keep schema 19 compatible; do not bump it simply to implement the port.

Required tests: successful login and cookie use; wrong-password/unauthenticated responses; cross-user denial with the existing status semantics; Unicode text roundtrip; text persistence after a real process restart. Record the unsupported routes explicitly. This slice does not establish OAuth, uploads, WebSocket or full browser readiness.

Read environment variables consistently with the reference service. Use isolated local ports/data and an `APP_ORIGIN` matching the test client. Keep the crate self-contained and document build/start/test commands. Install required development tooling if absent; do not modify production Docker/nginx/services.

## Frontend acceptance

Keep React/TypeScript and the current UI behavior. Make the development proxy target selectable through a server-side development environment variable, retaining `http://127.0.0.1:8787` as the default. Apply the selection consistently to `/api` including WebSocket upgrades, `/healthz`, and `/d/`.

Provide a browser smoke command with documented local fixture setup and backend target. Exercise the actual login and text flow against a real local TS service first; a mock-only test is insufficient evidence for the browser smoke. Tests should be suitable for rerunning against the Rust implementation as capabilities land. Missing Rust routes and realtime support must be reported as gaps, not hidden by fallback to TS or labelled as passing.

Existing unit tests/build must remain usable. A target-selection unit/config check may be used to verify default and custom HTTP/WS targets. No new runtime backend switch should be exposed to end users, and no production routing change is part of this task.

## File/media research

Inventory current raw/chunk upload, resumability, quota/atomic completion, cancellation, download Range/header, MIME sniffing, thumbnail and preview behavior. Distinguish code-declared formats from formats actually available in the current Sharp/libvips build.

Compare concrete Rust dependency options against primary documentation. Cover EXIF rotation, first-frame behavior, pixel limits, WebP output, streaming/backpressure, resource bounds and packaging. Propose representative success, malformed-input and boundary fixtures with expected observable outcomes. Clearly mark any dependency feature or runtime behavior that has not been tested. Recommend a next implementation slice without changing business code in this research task.

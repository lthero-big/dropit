# RHEA-245: Unicode input, persistence and restart evidence

Status: **blocked on an internal representation decision; no compatibility fix**.
The TS oracle is fixed at `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`.
The candidate starts at migration commit `cd53eb69fd717a6006618c35fed87462cf1b8b14`.
Only tests and documentation change in this PR. No production data, credentials,
deployment, schema, request parser, upload code or shared MAP are involved.

## Observed contract

The table's escape sequences denote actual JSON wire tokens. SQLite hex comes
from `hex(CAST(text AS BLOB))`, not re-encoding the result of a SQLite string read.

| Raw JSON text value | TS immediate response / live item event | SQLite bytes | TS GET / WS snapshot / restart |
| --- | --- | --- | --- |
| `"a\ud800b"` | `"a\ud800b"` | `61EDA08062` | `"a���b"` |
| `"a\udc00b"` | `"a\udc00b"` | `61EDB08062` | `"a���b"` |
| `"a\ud83d\ude00b"` | `"a😀b"` | `61F09F988062` | `"a😀b"` |
| `"\ud800\ud801"` | `"\ud800\ud801"` | `EDA080EDA081` | six U+FFFDs |
| `"\ud800\ud83d\ude00"` | `"\ud800😀"` | `EDA080F09F9880` | `"���😀"` |
| `"a\\ud800b"` | `"a\\ud800b"` | `615C756438303062` | literal backslash-u text |

TS accepts both create and PATCH with a lone surrogate. The response and live
`item.created` / `item.updated` preserve the original UTF-16 code units. TS binds
those code units to SQLite as invalid UTF-8 bytes (the surrogate's three-byte
encoding). Its SQLite reads replace each invalid byte with U+FFFD. For `a\ud800b`,
`size` and `storedBytes` remain **5**, even though the read string now takes 11
UTF-8 bytes. Restarting the TS process on the same files preserves this mismatch.

Rust rejects 15 of the 19 raw JSON create fixtures with 400 `INVALID_JSON`,
including unused/nested values, an unused property name and an overwritten
duplicate value containing a lone surrogate. The normal, valid-pair and literal
backslash controls pass. PATCH and login with an unused surrogate also fail,
for **17 input parity gaps**. Reading the TS-written database with Rust adds an
independent historical-data gap: items GET returns 500 `INTERNAL_ERROR`; WS
upgrades, then closes 1011 with `Snapshot unavailable`. The failure affects the
entire snapshot containing that row. TS can read the Rust-written control data.

## Why request replacement is insufficient

`read_json` returns `Map<String, serde_json::Value>`, whose strings and keys use
Rust `String`. `db::Item.text` is `Option<String>` and the realtime publisher
accepts `serde_json::Value`. These interfaces cannot carry a lone UTF-16 code
unit for exact serialization as `\ud800`. SQLite's existing text extraction
also requires valid UTF-8. Replacing input with one U+FFFD would change the
response/event, the persisted bytes and the later read result. Replacing it
with three U+FFFDs would also change the immediate response and size accounting.
Dropping unknown fields before syntax validation would change error handling.

The task explicitly requires coordinator evidence before a substantial internal
data-model/interface change, so this PR stops at executable characterization.
The existing assertions and product behavior have not been relaxed.

Options for the coordinator:

1. Authorize exact compatibility: introduce a representation that preserves
   UTF-16 code units in parsed JSON keys/values and outbound transient events;
   separately encode the legacy SQLite bytes and decode existing invalid UTF-8
   text with the measured TS read behavior. Keep schema 19, quota sizes,
   authentication/validation order and body limits. This touches shared JSON,
   validation, response, realtime and repository interfaces and needs a scoped
   design plus full compatibility regression.
2. Explicitly accept a changed Unicode contract: choose rejection or a specified
   normalization on new writes, and independently define legacy-row reads. This
   is a migration contract exception, not exact TS compatibility. The coordinator
   must approve and update the shared contract before implementation.

## Reproduce

Run from `rust/server` with the prerequisites in the server README:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
UNICODE_REPORT=../unicode-report.json cargo test --locked --test unicode -- --nocapture
cargo test --locked --test unicode unicode_ts_rust_parity -- --ignored --nocapture
```

The first Unicode test asserts the exact documented TS and current Rust
behavior, including raw response/event string tokens and SQLite hex, same-process
GET/WS reads, SIGTERM and a fresh real process on the same database, then the other
implementation reading those files. The second command deliberately fails the
parity gate; it is explicitly ignored in the normal suite until the contract
decision is implemented. It is also available as
`node tests/unicode.mjs --require-parity`. A passing characterization must never
be reported as passing Unicode compatibility or a completed migration.

The isolated harness archives and builds the fixed TS reference with its frozen
lockfile, generates schema-19 synthetic users/sessions, allocates loopback ports,
and removes its own processes, sockets and databases in `finally`.
`String.raw` fixtures are sent as raw UTF-8 byte buffers, so JS encoding never
turns a surrogate into a replacement character before HTTP parsing. Separate
UTF-16 expectations validate the parsed payload. The optional report contains
the sent bytes, wire text tokens, UTF-16 units and stored bytes, without secrets.

Coverage: high/low surrogates, valid pairs, Chinese/emoji, consecutive/reversed
surrogates, case-insensitive hex escapes, quotes/backslashes/tabs, actual U+FFFD,
ignored/nested/key/duplicate fields; 10 illegal JSON forms, non-object JSON,
wrong types, empty text, unauthenticated/cross-space/viewer/Origin rejection,
content type, text/body limits and no writes after errors. The characterization
currently passes **269 HTTP/state checks**; the strict parity gate remains red.

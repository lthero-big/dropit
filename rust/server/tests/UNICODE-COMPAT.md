# RHEA-245: Unicode input, persistence and restart evidence

Status: **exact text compatibility implemented after coordinator authorization**.
The TS oracle is fixed at `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`.
The candidate starts at migration commit `cd53eb69fd717a6006618c35fed87462cf1b8b14`.
The request tree, text repository and transient item serialization change.
No production data, credentials, deployment, schema or shared MAP are involved.

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

Metadata has two storage behaviors:

| Field | Immediate response/event | Storage | Later read |
| --- | --- | --- | --- |
| Text group `g\ud800x` | Original lone unit | TEXT hex `67EDA08078` | `g���x` |
| Explicit group `g\udc00x` | Group list already read from SQLite | TEXT hex `67EDB08078` | `g���x` |
| Tag `tag\ud800x` | Original lone unit | JSON string `"tag\ud800x"` | Original lone unit |
| User name `Bob\ud800x` | PATCH 204; creation returns original | TEXT hex `426F62EDA08078` | `Bob���x` |

Default regression includes the review's four original failures, group rename,
tag deduplication, actual U+FFFD/private-use tags, negative length/control cases,
public shares, anonymous room metadata, user self/admin/member/owner views,
registration and PAT names, JSON upload filenames, real restarts and cross reads.
Group normalization/limits and ordinary ASCII protocol validation still apply.
The existing TS behavior where an omitted group uses a replacement-decoded name
and can return GROUP_NOT_FOUND is explicitly tested rather than normalized away.

TS accepts both create and PATCH with a lone surrogate. The response and live
`item.created` / `item.updated` preserve the original UTF-16 code units. TS binds
those code units to SQLite as invalid UTF-8 bytes (the surrogate's three-byte
encoding). Its SQLite reads replace each invalid byte with U+FFFD. For `a\ud800b`,
`size` and `storedBytes` remain **5**, even though the read string now takes 11
UTF-8 bytes. Restarting the TS process on the same files preserves this mismatch.

The initial candidate rejected 15 of 19 raw JSON create fixtures, plus PATCH
and login with ignored surrogate fields. Its reads of TS-written text returned
500 and WS closed 1011. Those failures are fixed: both implementations now pass
the same strict assertions for create/PATCH, raw live event strings, SQLite hex,
HTTP/WS snapshots, actual restarts and cross-implementation reads. Private-space
and anonymous-room paths are covered separately.

## Why request replacement is insufficient

`js::JsString` retains a JSON string as WTF-8 bytes using serde_json's
byte-string deserializer. A request-only tree preserves keys and values recursively,
including ignored and duplicate fields; valid JSON syntax is checked by RawValue
before field validation. Byte-identical decoded keys implement last-value wins;
lone units remain distinct from literal U+FFFD, private-use code points and
backslash-u text. Numbers retain serde_json's arbitrary-precision representation.
Display names, groups, tags and text use JS-string accessors; protocol enum/ID
validators continue to use scalar UTF-8 accessors.

`ToSql` binds text bytes as TEXT (not BLOB); the byte length equals
Buffer.byteLength even for a lone unit. `db::item` reads TEXT bytes with
from_utf8_lossy, preserving the measured three replacements per surrogate and the
separately stored size. It never rewrites history. Create/PATCH return the transient
input string, while subsequent reads use the stored decoding. Typed responses and
item events, snapshots and public shares serialize directly, bypassing
serde_json::Value's scalar-string limit.
The existing broadcast queue, limits, gate, write transactions and ordinary Value
publishers retain their behavior. This follows the authorized
[internal design](UNICODE-DESIGN.md).

## Reproduce

Run from `rust/server` with the prerequisites in the server README:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
UNICODE_REPORT=../unicode-report.json cargo test --locked --test unicode -- --nocapture
cargo test --locked -- --nocapture
```

The Unicode test asserts exact TS and Rust behavior by default, including raw
response/event string tokens and SQLite hex, same-process GET/WS reads, SIGTERM
and a fresh real process on the same database, then the other implementation
reading those files. No difference is accepted or normalized away, and no Unicode
test is ignored. The direct harness is `node tests/unicode.mjs`.

The isolated harness archives and builds the fixed TS reference with its frozen
lockfile, generates schema-19 synthetic users/sessions, allocates loopback ports,
and removes its own processes, sockets and databases in `finally`.
`String.raw` fixtures are sent as raw UTF-8 byte buffers, so JS encoding never
turns a surrogate into a replacement character before HTTP parsing. Separate
UTF-16 expectations validate the parsed payload. The optional report contains
the sent bytes, wire text tokens, UTF-16 units and stored bytes, without secrets.

Coverage: private-space and room create/PATCH; high/low surrogates, valid pairs,
Chinese/emoji, consecutive/reversed surrogates, case-insensitive hex escapes,
quotes/backslashes/tabs, actual U+FFFD and private-use characters,
ignored/nested/key/duplicate fields; 10 illegal JSON forms, non-object JSON,
wrong types, empty text, unauthenticated/cross-space/viewer/Origin rejection,
content type, text/body limits and no writes after errors. All Unicode cases run
as strict compatibility assertions, including the original legacy-read 500/1011
regression.

## Validation on 2026-11-19

Rust 1.94.0, Node 22.22.0 and pnpm 11.1.0: fmt, strict locked clippy,
locked build and one complete `cargo test --locked -- --nocapture` run pass.
All 16 unit tests and 10 process-test targets pass with zero ignored tests.
The Unicode target runs 23 raw JSON fixtures, 10 illegal JSON controls and
554 HTTP/state checks, including anonymous rooms and bidirectional database reads.
The same full run passes auth/mock OAuth, 228 file responses, 199 login/text
responses, 290 item/label/group checks, PAT/device/WebView/CLI, 527 realtime checks,
408 room/share checks, update HTTP (including slow 200 MiB download/cancel/file
release), and 353 upload/chunk responses.

The 2026-11-20 metadata repair extends the default target to 690 HTTP/state
checks. It adds all four independent-review failures plus group rename, raw tags
on snapshots/public shares, account/PAT name creation and updates, upload-session
filename bytes, crypto UTF-8 behavior, and invalid role rejection. The unchanged
independent-review script also reports zero gaps for its four cases. The updated
unit suite has 17 tests; all Unicode tests remain enabled by default.
Fmt, strict locked clippy, locked build and the complete locked Cargo test run
pass on the metadata candidate: 17 unit tests and 10 process targets, zero ignored.
The full run includes 199 login/text, 228 file, 290 item/label/group, 526 realtime,
408 room/share and 353 upload/chunk checks, plus auth/mock OAuth, machine access
and update HTTP.

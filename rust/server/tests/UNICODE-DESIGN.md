# RHEA-245 internal Unicode design

The coordinator authorized exact TS compatibility on 2026-11-19. Keep schema 19,
wire endpoints, authentication order, quotas and existing disk bytes unchanged.

1. Add a request-only JSON tree with JS strings/keys represented as WTF-8 bytes.
   Use serde_json's byte-string deserializer (which preserves lone UTF-16 units)
   and RawValue syntax validation, including ignored/nested/duplicate fields.
   Scalars keep the current numeric representation; ordinary field validators
   still use scalar UTF-8 accessors. Text uses an explicit JS-string accessor.
   No replacement of request bytes, private-use sentinels or alternate data format.
2. Store text through rusqlite's TEXT byte binding. WTF-8's byte length equals
   Node Buffer.byteLength, including three bytes per lone surrogate. Read existing
   TEXT bytes using from_utf8_lossy, matching measured TS replacement per invalid
   byte. Preserve the separately stored size/storedBytes. Do not rewrite rows.
3. Item text can retain a JS string transiently after create/PATCH. Serialize
   typed item responses/events directly, emitting lone units as JSON escapes.
   Add a typed item-event method at the existing broadcaster boundary; existing
   Value events and all upload callers retain their signatures and ordering.
   Snapshots contain decoded SQLite strings and keep their existing JSON shape.
4. Enable the strict Unicode parity target by default, extend collision and
   duplicate-key fixtures, and run fmt/clippy/locked build plus the complete
   HTTP/WS compatibility suite. Record fresh/edited/historical/restarted paths
   independently; never normalize away a Unicode difference in the harness.

Integration order: this design commit, request/string/repository implementation,
typed text responses/events, then parity and full regression. The parser's return
type and input validator signatures change internally; output Value APIs remain.
The broadcaster's existing publish(Value) method is preserved, so RHEA-243's
upload completion/event fixes can be merged independently without touching
uploads.rs. RHEA-246's packaging/maintenance work has no required signature change.

# File and media contract inventory

Baseline: TypeScript at `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`. Integration head when this note was written: `10ddfc27d1c13bf5afffd17fc1aecaaf31150f6b`. The file and media sources named below are identical between those two commits. Line numbers are from that tree.

This note records observable HTTP, SQLite, and disk behavior. It does not authorize a media implementation. Shared decisions stay in `rust/DECISIONS.md` and `rust/CONTRACT.md`.

Public prose that matches the code: `docs/api.md` sections "Items", "Resumable file uploads", and "Public share links". Where this note and that prose differ, the source lines below win.

## Routes

Both bases exist: `/api/spaces/:space` and `/api/rooms/:room`. Space routes need a member session. Room routes need the unexpired room capability. A room code is not an upload credential.

| Method | Path | Success | Owner |
| --- | --- | --- | --- |
| POST | `base/uploads` | 201 JSON | `backend.ts:1307-1315`, `uploads.ts:28-41` |
| GET | `base/uploads/:id` | 200 JSON | `backend.ts:1316`, `uploads.ts:47-51` |
| PUT | `base/uploads/:id/chunks/:index` | 204 empty | `backend.ts:1317-1321`, `uploads.ts:52-88` |
| POST | `base/uploads/:id/complete` | 201 `{item}` | `backend.ts:1322-1326`, `uploads.ts:89-113` |
| DELETE | `base/uploads/:id` | 204 empty | `backend.ts:1327-1330`, `uploads.ts:126-131` |
| POST | `base/items/file` | 201 `{item}` | `backend.ts:1346-1362`, `service.ts:488-520` |
| GET | `base/items/:id/download` | 200 or 206 bytes | `backend.ts:1408-1411`, `1202-1217` |
| GET | `base/items/:id/thumbnail` | 200 WebP | `backend.ts:1412-1417` |
| GET | `base/items/:id/preview` | 200 WebP | `backend.ts:1418`, `1175-1182` |
| GET | `base/items/:id/media` | 200 or 206 bytes | `backend.ts:1419`, `1183-1201` |
| GET | `/api/s/:token/file` and `/d/:token` | same as download | `backend.ts:1234-1247` |
| GET | `/api/s/:token/thumbnail` | stored WebP | `backend.ts:1248-1255` |
| GET | `/api/s/:token/preview` | generated WebP | `backend.ts:1256-1260` |
| GET | `/api/s/:token/media` | sniffed media | `backend.ts:1261-1265` |

Every `/api/*` response also gets `Cache-Control: no-store` from `backend.ts:269-270`, then a route may replace it. Preview does replace it. Thumbnail and media do not, so their effective cache header is `no-store` from this middleware. Download sets no cache header of its own, so it also keeps `no-store`. `/d/:token` is outside `/api` and sets `Cache-Control: no-store` in `backend.ts:1224-1225`.

Global security headers on every response, including `/d/`: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (`backend.ts:256-268`).

Error JSON is `{ error: { code } }` plus any `ApiError` details (`backend.ts:303-311`). A 429 without `Retry-After` gets `Retry-After: 1`.

## Disk and schema

Content files live in `DATA_DIR/files/<uuid>`. The key must match `^[a-f0-9-]{36}$`. Create mode is `0o600`, directory mode is `0o700` (`files.ts:23-46`).

Tables that must stay compatible with schema 19:

- `items.fileKey`, `items.thumbnailKey`, `items.size`, `items.storedBytes`, `items.mime`, `items.filename` (`migrations.ts:15-17`).
- `garbage(key)` (`migrations.ts:21`).
- `uploads` and `upload_chunks` (`migrations.ts:103-119`). Chunk index is a quoted column. Cascade deletes chunk rows when the upload row goes away.

`publicItem` never returns `fileKey`, `thumbnailKey`, or `storedBytes`. It returns `hasThumbnail: Boolean(thumbnailKey)` (`domain.ts:135-137`).

## Raw upload

`POST base/items/file` reads the raw body. Filename comes from `X-File-Name`, percent-decoded, default `download`, maximum 4096 characters. `Content-Type` is the declared MIME, default `application/octet-stream`, type only, maximum 200 characters (`backend.ts:1346-1361`).

A finite `Content-Length` above the current file cap returns `413 FILE_TOO_LARGE` before the body is stored. A missing or non-integer length is not a declared expected size. The stream itself is still capped at `maxFileBytes` (space) or `roomMaxFileBytes` (room). Defaults are 25 MiB and 5 MiB (`config.ts:52-55`). An empty body is `400 EMPTY_FILE`. A body larger than the cap is `413 FILE_TOO_LARGE` (`files.ts:51-58`).

At most 4 raw `upload()` calls run at once. The fifth returns `429 UPLOAD_BUSY` (`service.ts:488-490`). This counter is separate from chunk concurrency.

Optional `X-Dropit-Device`, `X-Dropit-Device-Name`, `X-Dropit-Device-Kind`, and `X-Dropit-Group` are attached as item metadata. Malformed device headers are ignored. A malformed group header is `400 INVALID_GROUP` (`backend.ts:1277-1287`).

## Resumable upload

`POST base/uploads` body is JSON `{filename, size, mime}` (`backend.ts:1307-1315`).

- `size` is a safe integer from 1 to `Number.MAX_SAFE_INTEGER`, then rejected if it exceeds the current file cap: `413 FILE_TOO_LARGE` (`uploads.ts:30`).
- `filename` is 1–4096 characters, then `cleanFilename` (`domain.ts:130-133`): NFKC, replace `\`, `/`, C0/C1 controls, and bidi overrides with `_`, strip leading dots, trim, keep 180 characters, empty becomes `download`.
- `mime` is 1–200 characters, lowercased, parameters after `;` dropped. Empty after that is `400 INVALID_INPUT`.
- Response 201: `{uploadId, chunkSize, expiresAt, received: []}`.
- `chunkSize` is frozen from `uploadChunkBytes` at creation. Default 8 MiB. Runtime range 64 KiB–24 MiB (`limits.ts:22`). Later limit changes do not resize an existing session (`uploads.test.ts` AC-U4).
- `expiresAt` is `min(createdAt + 86400000, space.expiresAt ?? Infinity)`. Activity does not extend it (`uploads.ts:36`).

`PUT .../chunks/:index` (`uploads.ts:52-88`):

- Index must match `^(0|[1-9]\d*)$`, be a safe integer, and be `< ceil(size / chunkSize)`. Otherwise `400 INVALID_CHUNK_INDEX`. Leading zeros, fractions, and negatives fail this check.
- Expected length is `chunkSize`, or the remainder for the last index. Short body: `400 CHUNK_SIZE_MISMATCH`. Longer body: the writer hits `413 FILE_TOO_LARGE` because its limit is the expected length (`files.ts:51-52`).
- Optional `X-Chunk-SHA256` must be 64 hex characters or `400 INVALID_CHECKSUM`. Comparison is lowercase. Mismatch is `400 CHECKSUM_MISMATCH`. Checksum is checked before the duplicate-chunk path.
- Missing body is `400 EMPTY_FILE`.
- Identical retry of an already stored index returns 204 and does not keep a second file (`repository.ts:808-811` returns false; `uploads.ts:80` deletes the new key).
- Different size or sha256 for an existing index is `409 CHUNK_CONFLICT`. The first copy stays.
- A failed chunk is not listed in `received`. The session remains so the client can retry, except when complete itself fails (below).

`GET base/uploads/:id` returns `{size, chunkSize, expiresAt, received}` with committed indices only, in index order (`uploads.ts:47-51`, `repository.ts:800-802`).

## Quota reservation and atomic complete

`createUpload` runs an immediate transaction (`repository.ts:786-796`):

1. Writer still exists, is not disabled, is a member, and is not a viewer (`checkWriter`, `repository.ts:768-776`). Viewer write is `403 READ_ONLY` at the route before this (`backend.ts:1273-1274`).
2. `used + reserved + declaredSize <= quota`, else `413 QUOTA_EXCEEDED`.
3. Item count plus live upload count `< maxItems`, else `413 ITEM_LIMIT`. Room max items is `min(100, maxItems)`.
4. Live upload sessions: per principal `< uploadSessionsPerUser` (default 8) and global `< uploadSessionsGlobal` (default 128), else `429 UPLOAD_SESSION_LIMIT`.

User quota is `users.quotaBytes` when set, otherwise `userQuotaBytes` (default 1 GiB). Room quota is `roomQuotaBytes` (default 50 MiB) and is not the signed-in user's quota. Signed-in room uploads still share the account's upload-session and chunk-concurrency principal `user:<id>`. Anonymous room holders share `room:<spaceId>` (`uploads.ts:19-27`).

`reservedBytes` on `GET /api/me` is the sum of unexpired upload `size` for that user. It is separate from `usedBytes`. Text growth and ordinary file creates count the same reservation (`repository.ts:762-784`). A shrink of existing text does not re-check quota (`repository.ts:867-872`).

Complete (`uploads.ts:89-113`, `repository.ts:840-856`):

- If any chunk write or another complete is in flight: `409 UPLOAD_IN_PROGRESS`. The session is kept.
- Chunks must be exactly indices `0..count-1` with the expected per-index sizes and a byte sum equal to `upload.size`. Otherwise `400 UPLOAD_INCOMPLETE`.
- Assembly is a streaming concatenation (`files.ts:103-118`). It does not buffer the whole file. The assembled stream is then written as a new content object, so the chunk files and the final file coexist until commit.
- Raster and thumbnail rules below run before the item insert.
- `addItem` deletes the upload row in the same immediate transaction, which releases the reservation, then checks capacity against `storedBytes` (file plus thumbnail). Other live reservations still count.
- On success the response is 201 `{item}` and `item.created` is published. A lost response must be recovered from the item snapshot. Repeating complete returns 404. Two concurrent completes produce one item and one `409` (`uploads.test.ts` AC-U2).
- Any complete failure after the checks above, including decoder failure and quota failure, deletes the upload row in `finally` (`uploads.ts:105-108`). The client must create a new session. Chunk keys are queued in `garbage`. No item remains.
- A successful item commit must not become a failed HTTP response because garbage I/O failed. Cleanup failure is logged and retried by maintenance (`uploads.ts:109-111`).

## Cancel, expiry, and sweep

- `DELETE` authorizes, deletes the upload row, aborts in-flight chunk and complete controllers, waits for them, then flushes garbage (`uploads.ts:126-131`). Aborted writes surface as `404 NOT_FOUND` (`files.ts:42`).
- Disabling a user cancels that user's space uploads and authenticated room uploads (`backend.ts:933`, `uploads.ts:132-135`, `repository.ts:823-828`).
- `expireUploads` drops sessions whose own expiry passed, whose space expired, or whose user is disabled (`repository.ts:830-838`).
- Maintenance also expires items, flushes the garbage queue, then sweeps files older than 1 hour that are not referenced by an item key, a thumbnail key, a chunk key, or the in-process active set (`service.ts:539-547`, `files.ts:93-100`).
- A crash can leave an unreferenced file. The sweep is the recovery path. Active writes are excluded so a live upload is not deleted.
- Unknown, expired, completed, cancelled, cross-user, and wrong-base upload ids are all `404 NOT_FOUND`. There is no upload-list route.

## Rate limits that are easy to miss

Chunk PUT uses the `chunk` bucket (`rateChunk`, default 2000/window) for IP, account, and PAT. It does not consume `rateGeneral`, `rateUpload`, `rateRoom`, `rateToken`, or room-access (`backend.ts:276-277`, `docs/api.md` resumable section). Session create and complete still use the ordinary upload or room-write bucket. Session GET and DELETE use general, and room routes also use room-access unless the request is a chunk PUT (`backend.ts:1267-1270`).

In-process caps, defaults 3 / 6 / 16: chunks per session, per principal, and global (`uploads.ts:62-63`). Excess is `429 CHUNK_BUSY` with `Retry-After`. Lowering a cap does not abort work already running.

Each chunk write has `uploadChunkTimeoutMs` (default 120000). Timeout is `400 UPLOAD_TIMEOUT`, the partial file is removed, and the same index can be sent again (`files.ts:38-42`, `uploads.test.ts` AC-U5). There is no whole-file deadline.

Cookie requests need an allowed `Origin` on unsafe methods. Any `Authorization` header selects Bearer auth and never falls back to the cookie (`backend.ts:280-286`). PUT needs `write`. GET needs `read`. Missing scope is `403 INSUFFICIENT_SCOPE`.

## Download, Range, and headers

`sendDownload` (`backend.ts:1202-1217`):

- Requires `fileKey` and `filename`, else `404 NOT_FOUND`.
- `Accept-Ranges: bytes`.
- `Content-Type: application/octet-stream`. The stored MIME is not used.
- `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<encoded>` (`backend.ts:127-141`).
- `asciiFilename` keeps a printable ASCII stem and a 1–16 character ASCII extension. Characters outside 0x20–0x7e, plus `"`, `\`, `%`, and `;`, become `_`. A name with no ASCII stem uses fallback `download`.
- `filename*` percent-encodes and also encodes `'`, `(`, `)`, `*`.
- Single range only. `parseByteRange` (`media.ts:56-72`):
  - Absent header, or a header that is not `bytes=<start>-<end>` with at least one side: ignored, full body, 200.
  - `bytes=0-1,4-5` does not match the single-range regex, so it is a full 200, not 416.
  - Suffix `bytes=-N`: last N bytes, clamped to the file.
  - Open end `bytes=S-`: from S through the last byte.
  - End past the file is clamped.
  - Start `>= size`, or end `< start`: `416` with `Content-Range: bytes */<size>` and an empty body.
  - A satisfiable range is `206` with `Content-Range: bytes start-end/size` and `Content-Length` of the slice.
- `createReadStream` end is inclusive (`files.ts:83-85`), matching the parsed end.

`/d/:token` and `GET /api/s/:token/file` share this sender. The first request without `access` spends one view, returns `X-Share-Access` and `Content-Location`, and later ranges reuse that ticket (`backend.ts:1234-1245`). Unknown, expired, revoked, exhausted, and malformed tokens are `404 NOT_FOUND`.

## Sniffing

Client `Content-Type` is ignored for inline media.

Raster magic (`media.ts:13-19`), first matching prefix:

| Bytes | Result |
| --- | --- |
| PNG signature | `image/png` |
| `FF D8 FF` | `image/jpeg` |
| `GIF87a` or `GIF89a` | `image/gif` |
| `RIFF` at 0 and `WEBP` at 8 | `image/webp` |
| `ftyp` at 4 and brand `avif` or `avis` | `image/avif` |
| anything else | not a sniffed raster |

`heic`, `heix`, `mif1`, and other HEIF brands are not in this allowlist.

Media magic (`media.ts:31-53`):

| Condition | Content-Type | Kind |
| --- | --- | --- |
| `ftyp` + `M4A `, `M4B `, `M4P ` | `audio/mp4` | audio |
| `ftyp` + `qt  ` | `video/quicktime` | video |
| `ftyp` + `isom`, `iso2`, `iso4`, `iso5`, `iso6`, `mp41`, `mp42`, `avc1`, `dash`, `M4V `, `MSNV` | `video/mp4` | video |
| other `ftyp` brand, including `avif` | not media | |
| EBML `1A 45 DF A3` and the prefix contains ASCII `webm` | `video/webm` | video |
| EBML without `webm` | not media | |
| `OggS` containing `theora` | `video/ogg` | video |
| `OggS` containing `OpusHead`, `vorbis`, or `FLAC` | `audio/ogg` | audio |
| other Ogg | not media | |
| `RIFF` + `WAVE` | `audio/wav` | audio |
| `fLaC` | `audio/flac` | audio |
| `ID3` or an MP3 frame header | `audio/mpeg` | audio |

`sendMedia` reads 4096 prefix bytes. No match, or `size < 1`, is `404 NOT_FOUND`, not 415 (`backend.ts:1183-1186`). Response uses the sniffed type, `Content-Disposition: inline`, `Cache-Control: private, no-store`, and the same Range rules. SVG, HTML, PNG, and arbitrary bytes stay download-only.

WebM and Ogg detection scans the 4096-byte prefix, not the whole file. A codec marker past that window is a miss. This is current behavior, not a new requirement to widen the window.

## Thumbnail and preview

`raster()` (`service.ts:468-475`):

- Loads the whole file with Sharp `limitInputPixels: 16 * 1024 ** 2` (16,777,216) and `animated: false`.
- `metadata.format` must be one of `jpeg`, `png`, `webp`, `gif`, `avif`, `heif`. TIFF is not in this list even if Sharp can decode it.
- Then `rotate()` with no angle, so Sharp applies EXIF orientation (`sharp` operation docs: no angle means auto-orient).
- `resize(edge, edge, { fit: 'inside', withoutEnlargement: true })`.
- `webp({ quality: 75 })`. Sharp output docs: metadata, including EXIF orientation, is removed unless `withMetadata()` is called. This code does not call it.
- Any throw becomes `415 INVALID_IMAGE`. The original Sharp message is not returned.

When a thumbnail is generated (`service.ts:498-509`):

- Session complete sniffs 4096 bytes. A sniffed raster is validated even when the declared MIME is `application/octet-stream`.
- Session complete also rejects `mime === image/svg+xml` or a prefix matching `/<svg[\s/>]/i` with `415 INVALID_IMAGE`, including SVG whose declared MIME is PNG or octet-stream.
- Declared MIME `image/jpeg`, `image/png`, `image/webp`, `image/gif`, or `image/avif` also enters the raster pipeline. `image/heic` and `image/heif` do not, unless the prefix sniffed as AVIF.
- Legacy `POST items/file` does not sniff and does not reject SVG. SVG and HTML are stored download-only, `hasThumbnail: false`. A declared raster MIME that is not a decodable raster still returns `415` and stores nothing.
- Thumbnail edge is 320. The thumbnail object is a second file. `storedBytes = fileSize + thumbnailSize`. Thumbnail write limit is 1 MiB.
- If the quota can hold the declared file but not the thumbnail, complete returns `413 QUOTA_EXCEEDED`, no item, no files (`uploads.test.ts` AC-U2/U6).

Thumbnail GET streams the stored object with `Content-Type: image/webp`. No thumbnail key is `404 NOT_FOUND`. It does not regenerate.

Preview (`service.ts:476-487`, `backend.ts:1175-1182`):

- Requires both `fileKey` and `thumbnailKey`, else `404 NOT_FOUND`. Text, SVG, HTML, and non-raster files therefore 404 even if someone later swaps the bytes.
- At most 2 generations at once, across member, room, and share routes. Excess is `429 PREVIEW_BUSY`.
- Same raster pipeline with edge 2048. No enlargement. Aspect preserved. Output `image/webp`.
- `Content-Disposition: inline`.
- Member and room: `Cache-Control: private, max-age=N`, where N is `min(60, floor((expiresAt-now)/1000))`, floored at 0.
- Share: `Cache-Control: no-store`.
- After generation, the item is loaded again. If it was retracted or expired while generating, the response is `404` and nothing is stored.
- Preview does not write a file, does not change `storedBytes`, and does not add a garbage key.
- Share preview uses the same view ticket as file and thumbnail. A direct preview without `access` spends one view (`backend.test.ts` AC-S4).

Animated GIF: `animated: false` keeps the first frame. The existing test builds a 32x32 buffer with `pageHeight: 16`, expects preview width 32 and height 16, and expects the first pixel to be red rather than the blue second frame (`backend.test.ts` AC-S1).

EXIF orientation 6 on a 3000x1500 JPEG: preview width 1024 and height 2048. Output metadata has no `exif`, `icc`, `iptc`, `xmp`, or `orientation` (`backend.test.ts` AC-S1/S3). The original file bytes are not rotated on disk.

## Exception paths that are easy to miss

1. Complete failure deletes the session. Chunk PUT failure does not. Clients that retry complete after `400` or `415` will get 404 and must create a new upload.
2. A corrupt assembled file whose chunk rows still look valid fails complete with `400 UPLOAD_INCOMPLETE` and deletes the session (`uploads.test.ts` AC-U2). The reservation is released.
3. Cancel during complete must win over item insert. The in-flight complete then returns 404 and leaves no item (`uploads.test.ts` AC-U4).
4. Successful complete plus failed garbage flush is still 201. Orphan files are retried later. Do not map that I/O error onto the client response.
5. `saveChunk` returning false means "duplicate, discard the new key". Returning true means "commit the key". A crash between insert and `files.commit` is recovered by sweep only after the chunk row is gone; while the row exists, sweep must keep the file.
6. Legacy SVG/HTML stays downloadable. The session protocol rejects the same SVG. A Rust port that applies one policy to both routes will break one of them.
7. Sniffed AVIF enters raster validation. A declared `image/heic` without an `avif`/`avis` brand does not. Sharp may still classify a real AVIF as `format: heif`; the allowlist includes `heif`, so that path works only after the pipeline starts.
8. TIFF decodes in this Sharp build and would pass a naive "Sharp can open it" check. `raster()` still rejects it because `tiff` is not in the format list. Expected result is `415` when the declared MIME forced the pipeline, or a download-only item when neither sniff nor declared MIME selected it.
9. Pixel limit is exact: 4096x4096 (16,777,216) is accepted by this build; 4097x4097 throws `Input image exceeds pixel limit` and becomes `415`. Width and height are not capped independently.
10. `image/svg+xml` declared on the legacy route is stored. The same bytes declared as `image/png` are `415` only when the prefix matches the SVG regex or Sharp rejects them. A PNG that merely contains the letters `<svg` later in the file is not rejected by the prefix regex unless those bytes sit in the sniffed window in that form.
11. Multi-range and malformed Range headers are full 200 responses, not 416. Only an unsatisfiable single range is 416.
12. Media 404 and download 200 can both be correct for the same item. HTML declared as `video/mp4` is the test case (`backend.test.ts` media preview).
13. WebM sniff uses `Buffer.includes('webm')` on the prefix. A file whose EBML header is valid but whose codec id sits after byte 4096 is not inlined.
14. Preview 404 for a non-member is the same code as preview 404 for a file with no thumbnail. Do not add a distinct error code.
15. Room file cap must stay strictly below the space file cap, and room quota strictly below user quota, or limit validation fails (`limits.ts:49-52`). Tests and admin patches assume that inequality.
16. Filename cleaning is NFKC. `asciiFilename` is a second, narrower transform used only in `Content-Disposition`. The stored `item.filename` is the cleaned name, not the ASCII fallback.
17. `flushGarbage` removes the file first and forgets the queue row second (`service.ts:533-537`). A crash between them retries the delete. `remove` treats `ENOENT` as success (`files.ts:87-90`).
18. Share range requests must not spend a second view when `access` is present. `/d/:token` without `access` spends one and must return the ticket headers.

## What this inventory does not claim

- Byte-identical WebP across Sharp versions or across a future Rust encoder.
- That every HEIC file in the wild decodes. See `file-media-dependencies.md` for the build probe.
- That production data was read. The tests cited here use temporary directories created by the test fixtures.

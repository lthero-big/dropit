# File and media implementation slice

For the backend agent after RHEA-229 is accepted. This document is a plan and a case list. It does not change `rust/server/**`.

Parent constraints from `rust/DECISIONS.md`: keep SQLite and the local file layout, preserve status and error codes, and do not assume byte-identical image output. RHEA-227 owns the first login and text slice. This work starts after that crate exists, or as a later PR against `migration/rhea-226-rust` that only adds files the backend owner already owns.

## Recommended slice

Ship original-byte upload, resume, download, and Range first. Then add JPEG/PNG/GIF/WebP thumbnail and preview through `image` plus `kamadak-exif`. Leave AVIF and HEIC as an explicit gap with the status codes in the case list.

Do not start with libvips. The measured Sharp prebuild cannot encode HEVC, and the product output is WebP, so a C library does not buy the behavior clients already see except AVIF preview. AVIF preview can be a follow-up once a fixture exists.

## Steps

1. Keep using the schema-19 fixture produced by the TypeScript server. Add file rows only through HTTP against a copy of that database, or generate a fresh isolated database with the TypeScript test helper. Do not open a production `DATA_DIR`.
2. Implement `DiskFileStorage` with the same key regex, `0o600` files, `0o700` directory, SHA-256, exclusive create, short-write loop, and `ENOENT`-tolerant delete. Put blocking file and image work on a blocking pool.
3. Implement raw `POST base/items/file` before resumable upload. Cover empty, over-cap, missing Content-Length, filename cleaning, and download byte equality.
4. Implement the upload session tables already defined in migration 8. Preserve the immediate-transaction reservation, the frozen chunk size, and the "complete failure deletes the session" rule.
5. Implement download and Range with `parseByteRange` semantics, including "malformed Range means 200 of the whole file".
6. Implement sniffing as a direct port of `media.ts`. Unit-test the magic bytes without an image crate.
7. Implement thumbnail and preview for JPEG, PNG, GIF, and WebP only. Check `width * height` before full decode. If the product is greater than 16,777,216, return `415 INVALID_IMAGE` and store nothing.
8. For AVIF sniff or declared `image/avif`, return `415 INVALID_IMAGE` on the session protocol and on a legacy upload that would have entered `raster()`. Document the response in the crate README as a known gap, not as a Sharp-compatible preview.
9. Keep legacy SVG and HTML download-only. Keep session SVG rejection.
10. Run the case list below against the Rust process. Where a case needs a derived image, also run it against the TypeScript server on an isolated port and compare the observable fields, not the WebP bytes.

## Image equivalence

A derived image passes when all of the following hold:

- HTTP status and error code match the case.
- `Content-Type` is `image/webp`.
- A WebP decoder reports the expected width and height, plus or minus 0 pixels for the fixtures in this list. The fixtures are even and small so rounding is not in doubt.
- Aspect ratio is preserved: `outputWidth / outputHeight` matches `orientedWidth / orientedHeight` within 1 pixel on each edge after the fit.
- Neither edge exceeds the requested edge (320 or 2048).
- A source whose oriented edges already fit is not enlarged.
- Output metadata has no EXIF orientation field and no EXIF block that a normal decoder surfaces. ICC, IPTC, and XMP are absent for the fixtures that include them.
- GIF fixture: one frame, and the sampled pixel matches the first frame's color, not the second frame's color.
- `storedBytes` increases by the original size plus the thumbnail size. Preview does not change `storedBytes` or the file count.
- Download of the original returns the uploaded bytes exactly. That equality is required. Thumbnail and preview byte equality is not required.
- `hasThumbnail` matches. `fileKey` and `thumbnailKey` stay absent from JSON.

If Sharp and `image` disagree on a fixture's dimensions by 1 pixel, stop and record both measurements on RHEA-226. Do not silently widen the tolerance for the orientation and GIF fixtures; those have exact expected sizes in the TypeScript tests.

## Fixtures

Store generated fixtures under the Rust crate's test data once implementation starts. This research task does not add binary fixtures.

| Id | How to produce it | Why |
| --- | --- | --- |
| `F-PNG-10` | PNG, 10x10, solid red | sniff, thumbnail, quota |
| `F-PNG-500x400` | PNG, 500x400 | thumbnail edge becomes 320x256 |
| `F-PNG-8` | PNG, 8x8 | no enlargement at preview edge 2048 |
| `F-PNG-48x24` | PNG, 48x24 | preview keeps 48x24 |
| `F-JPEG-ORIENT6` | JPEG, stored 3000x1500, EXIF orientation 6, with an EXIF payload | preview 1024x2048, metadata stripped |
| `F-JPEG-SMALL-ORIENT6` | JPEG, stored 48x24, orientation 6 | preview 24x48; catches a pipeline that reads `metadata()` before rotate is applied |
| `F-GIF-2FRAME` | GIF, frame 32x16, two frames, top red then blue, delays 100 ms | first frame only, 32x16, first pixel red |
| `F-PNG-4096` | PNG, 4096x4096 | pixel ceiling boundary, accepted |
| `F-PNG-4097` | PNG, 4097x4097 | pixel ceiling, `415` |
| `F-WEBP-8x4` | lossless WebP, 8x4 | sniff and preview |
| `F-AVIF-8x4` | 8-bit AVIF, 8x4, `ftypavif` | gap case, `415` in the first Rust slice |
| `F-SVG` | `<svg onload="alert(1)"></svg>` and `<svg/>` | policy split between routes |
| `F-HTML` | `<html><script>alert(1)</script></html>` | download-only, media 404 |
| `F-MP4` | 20-byte `ftypisom` prefix plus `isom` and a short payload, as in `backend.test.ts` | media sniff and Range |
| `F-WAV` | `RIFF` + 4 size bytes + `WAVE` | audio sniff |
| `F-BIN` | `not an image` | download-only |

`F-PNG-4096` is about 60 KB as a solid PNG in the Sharp probe, so it is cheap to generate in a test. Generate it in the test process. Do not commit a multi-megabyte uncompressed bitmap.

The MP4 fixture is not a playable file. It only has to satisfy `sniffMedia` and Range. Clients that need a playable sample are out of this slice.

## Case list

Status codes are the HTTP status. `code` is the JSON `error.code` when the body is JSON. Binary responses have no JSON body.

### A. Raw upload and download

| Id | Action | Expected |
| --- | --- | --- |
| A1 | POST `F-BIN` as `application/octet-stream` with `X-File-Name` of a normal name | 201, `kind=file`, `hasThumbnail=false`, `size` equals bytes, download 200 equals those bytes, `Content-Type` on download is `application/octet-stream` |
| A2 | POST empty body | 400 `EMPTY_FILE`, no file in the store |
| A3 | POST one byte over the current file cap, with and without `Content-Length` | 413 `FILE_TOO_LARGE`, no file left |
| A4 | `X-File-Name: ../..%5Cbad%00%0D%0A名.png` on `F-PNG-500x400` | 201, stored filename has no `\`, `/`, NUL, CR, or LF, `hasThumbnail=true` |
| A5 | `X-File-Name` longer than 4096 | 400 `INVALID_FILENAME` |
| A6 | `X-File-Name` that is not valid percent-encoding | 400 `INVALID_FILENAME` |
| A7 | fifth concurrent raw upload while 4 are in flight | 429 `UPLOAD_BUSY` |
| A8 | viewer member POST | 403 `READ_ONLY` |
| A9 | non-member download | 404 `NOT_FOUND` |
| A10 | delete item | 204, both content and thumbnail files gone, later download 404 |

### B. Resumable session

| Id | Action | Expected |
| --- | --- | --- |
| B1 | POST `{filename,size,mime}` for a 3-chunk payload, send chunks 2, 0, 1 | each PUT 204, GET `received` grows with committed indices, complete 201, download equals the concatenation |
| B2 | PUT the same index with the same bytes and same checksum | 204, still one chunk file |
| B3 | PUT the same index with different bytes | 409 `CHUNK_CONFLICT`, first bytes remain, `received` unchanged |
| B4 | index `-1`, `1`, `01`, `1.5`, or a non-safe integer | 400 `INVALID_CHUNK_INDEX`, session remains, `received` empty |
| B5 | short chunk | 400 `CHUNK_SIZE_MISMATCH`, session remains |
| B6 | long chunk | 413 `FILE_TOO_LARGE`, session remains |
| B7 | checksum not 64 hex | 400 `INVALID_CHECKSUM` |
| B8 | checksum mismatch | 400 `CHECKSUM_MISMATCH`, session remains |
| B9 | complete with a missing index | 400 `UPLOAD_INCOMPLETE`, subsequent GET/PUT/complete 404, no item, reservation 0 |
| B10 | declared size above the file cap | 413 `FILE_TOO_LARGE` at create, no row |
| B11 | create that would pass the quota or item slot | 413 `QUOTA_EXCEEDED` or `ITEM_LIMIT`, no row |
| B12 | two creates racing the last quota byte | one 201 and one 413, never two rows whose reservations sum over the quota |
| B13 | text PATCH that would exceed quota because a reservation exists | 413 `QUOTA_EXCEEDED` |
| B14 | complete while a chunk PUT is in flight | 409 `UPLOAD_IN_PROGRESS`, session remains |
| B15 | two completes | one 201 and one 409, exactly one item |
| B16 | cancel during complete, after the session row is deleted | complete 404, cancel 204, no item, no files |
| B17 | DELETE session | 204, files gone, reservation 0, later request 404 |
| B18 | advance past 24h, run maintenance | session 404, files gone, reservation 0. At 23h the session still exists |
| B19 | room session expiry equals room expiry when that is sooner | complete after room expiry is 404 |
| B20 | disable the user | unfinished space and authenticated room uploads disappear |
| B21 | other member, even of a shared space, GET/PUT/complete/DELETE | 404 `NOT_FOUND` |
| B22 | chunk PUT does not consume the small `rateUpload` budget; the 101st PUT after `rateChunk` is lowered | 429 `RATE_LIMITED` with `Retry-After` |
| B23 | caps 1/1/2, a stalled PUT, then another PUT | 429 `CHUNK_BUSY` with `Retry-After` |
| B24 | real HTTP server, chunk timeout | 400 `UPLOAD_TIMEOUT`, no partial file, retry of that index 204, complete 201 |
| B25 | restart the process after one committed chunk | GET still lists that index, complete works, sweep does not delete the chunk file |
| B26 | change `uploadChunkBytes` after create | existing session keeps the old chunk size; a new session uses the new size |
| B27 | complete after quota is lowered below the file | 413 `QUOTA_EXCEEDED`, session destroyed, no item |

### C. Headers and Range

Use a 10-byte file whose bytes are `0123456789`.

| Id | Range header | Status | Body | `Content-Range` |
| --- | --- | --- | --- | --- |
| C1 | absent | 200 | `0123456789` | absent |
| C2 | `bytes=2-5` | 206 | `2345` | `bytes 2-5/10` |
| C3 | `bytes=7-` | 206 | `789` | `bytes 7-9/10` |
| C4 | `bytes=-3` | 206 | `789` | `bytes 7-9/10` |
| C5 | `bytes=8-99` | 206 | `89` | `bytes 8-9/10` |
| C6 | `bytes=10-` | 416 | empty | `bytes */10` |
| C7 | `bytes=5-2` | 416 | empty | `bytes */10` |
| C8 | `bytes=0-1,4-5` | 200 | whole file | absent |
| C9 | `not-a-range` | 200 | whole file | absent |

Also required on download: `Accept-Ranges: bytes`, `Content-Type: application/octet-stream`, `Content-Disposition` starts with `attachment;`, `X-Content-Type-Options: nosniff`. HEAD with a satisfiable range returns 206 and `Content-Length` of the slice, with an empty body if the stack does not send one. The TypeScript machine-auth test pins HEAD `bytes=0-1` as 206, length 2, empty text.

`asciiFilename` cases from `rhea190-download-name.test.ts` must hold for the `filename=` parameter. `filename*=UTF-8''` carries the cleaned Unicode name.

`/d/:token` first GET: 200, `X-Share-Access` set, `Content-Location` points at `/api/s/<token>/file?access=...`, one view spent. A later Range with that access stays 206 and does not spend a second view. A one-view share's second open is 404.

### D. Sniff and media

| Id | Upload | GET media | GET download |
| --- | --- | --- | --- |
| D1 | `F-MP4` declared `text/html` | 200 `video/mp4`, `inline`, `Accept-Ranges: bytes`, body equals upload | 200 `application/octet-stream`, `attachment` |
| D2 | `F-MP4` with `Range: bytes=0-3` | 206, those four bytes, matching `Content-Range` | same Range rules |
| D3 | `F-MP4` with start at size | 416 | 416 |
| D4 | `F-HTML` declared `video/mp4` | 404 `NOT_FOUND` | 200 attachment |
| D5 | `F-PNG-10` | 404 | 200 |
| D6 | `F-SVG` | 404 | depends on route; see E |
| D7 | `F-WAV` prefix | unit test: `audio/wav` | not an HTTP case by itself |

Share media with `access` and `Range: bytes=-4` is 206 and does not change the view count beyond the open that created the ticket.

### E. Raster policy

| Id | Route | Body and declared MIME | Expected |
| --- | --- | --- | --- |
| E1 | session complete | `F-PNG-10` declared `application/octet-stream` | 201, `hasThumbnail=true`, two files, `usedBytes > size` |
| E2 | session complete | `F-SVG` declared `image/svg+xml`, `image/png`, or `application/octet-stream` | 415 `INVALID_IMAGE`, no files, no reservation |
| E3 | session complete | `fake PNG` declared `image/png` | 415, no files |
| E4 | session complete | `F-PNG-4097` declared `image/png` | 415, no files |
| E5 | session complete | `F-PNG-4096` declared `image/png` | 201, thumbnail exists. This is the boundary that must not be treated as over the limit |
| E6 | session complete | `F-PNG-10` when quota equals the PNG size and cannot hold the thumbnail | 413 `QUOTA_EXCEEDED`, no files, reservation 0 |
| E7 | legacy POST | `F-SVG` declared `image/svg+xml` or `text/html` | 201, `hasThumbnail=false`, thumbnail GET 404, media GET 404, download 200 attachment |
| E8 | legacy POST | `<svg/>` declared `image/png` | 415 `INVALID_IMAGE` |
| E9 | legacy POST | `F-PNG-500x400` | 201, thumbnail `image/webp`, width 320, height 256 |
| E10 | either, after implementation choice | `F-AVIF-8x4` | first Rust slice: 415 and no item. TypeScript on this host: 201 with a thumbnail. The difference is a documented gap, not a silent pass |
| E11 | legacy POST | TIFF, if a fixture is added | 201 download-only if MIME is `image/tiff` or octet-stream. 415 if a future change adds `image/tiff` to the declared-MIME list. Current code does neither sniff nor list it, so download-only is the compatible result |

### F. Preview

| Id | Action | Expected |
| --- | --- | --- |
| F1 | preview `F-PNG-48x24`, `F-JPEG` equivalent, WebP, and GIF stills | 200, `image/webp`, `Content-Disposition: inline`, `nosniff`, dimensions unchanged, quota and file count unchanged, item JSON unchanged |
| F2 | preview `F-JPEG-ORIENT6` | width 1024, height 2048, no EXIF, ICC, IPTC, XMP, or orientation in output metadata |
| F3 | preview `F-GIF-2FRAME` | width 32, height 16, one frame, first sampled pixel red (`R > 240`, `B < 15` in the TypeScript test) |
| F4 | preview a file with no thumbnail | 404 `NOT_FOUND`, no `Content-Disposition` |
| F5 | non-member, wrong space, anonymous | 404, 404, and 401 respectively |
| F6 | room capability preview | 200; other room 404; after room expiry 404 |
| F7 | share preview with `access` | 200, `Cache-Control: no-store`, view count unchanged by the preview itself |
| F8 | share preview without `access` on a one-view link | first 200 spends the view, second 404 |
| F9 | retract during an in-flight preview | that preview returns 404, no extra file remains |
| F10 | third concurrent preview | 429 `PREVIEW_BUSY` |
| F11 | member cache header | `private, max-age=60` early in retention; `private, max-age=2` when 2500 ms remain before expiry in the TypeScript test's clock |

Preview of `F-AVIF-8x4` is not available in the first slice because E10 does not create a thumbnail. Do not add a special preview path that decodes AVIF while upload rejects it.

### G. Restart and garbage

| Id | Action | Expected |
| --- | --- | --- |
| G1 | upload a PNG, restart the process, download and thumbnail | same bytes, thumbnail still 200 |
| G2 | crash window is simulated by inserting a garbage row whose file is already gone | maintenance succeeds, row is forgotten |
| G3 | unreferenced file with mtime older than 1 hour | sweep deletes it |
| G4 | unreferenced file newer than 1 hour, or a key in `upload_chunks` | sweep keeps it |
| G5 | complete succeeds and the garbage delete throws once | client still got 201; a later maintenance removes the chunk files |

## Out of scope for the first implementation PR

- Playable transcoding, video thumbnails, and ffmpeg.
- HEVC/HEIC decode, 10-bit and 12-bit AVIF, and animated AVIF.
- Lossy WebP quality matching Sharp's quality 75.
- Changing the public error codes or adding a "codec unavailable" code. Use `415 INVALID_IMAGE` for raster rejection.
- Editing `rust/CONTRACT.md`, `rust/DECISIONS.md`, or `rust/MAP.md`.
- Production data, deployment, and merging to `main`.

## Evidence the implementation PR should attach

- Exact commit, Rust toolchain, and `cargo test` output.
- The TypeScript comparison command and the fixture ids that were compared.
- A short gap list: AVIF preview, HEIC, lossy WebP bytes, and any GIF disposal case not covered by `F-GIF-2FRAME`.
- Confirmation that no production database or `DATA_DIR` was opened.

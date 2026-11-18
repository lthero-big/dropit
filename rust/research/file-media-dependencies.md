# Rust image-pipeline options

Research only. No crate is added to the repository by this note. Versions below were read on 2026-11-18 from the cited pages. Recheck them when the backend agent writes `Cargo.toml`; crate versions move.

## Recommendation

Use the pure-Rust `image` crate for the first media slice, and keep original bytes on disk.

- Decode JPEG, PNG, GIF, and WebP through `image` 0.25.x with explicit features.
- Apply orientation with `kamadak-exif` before resize.
- Resize inside the requested edge, never enlarge, then encode WebP.
- Keep the TypeScript AVIF result as the final compatibility target: upload `201`, `hasThumbnail=true`, thumbnail `200`, preview `200` with the source dimensions when they already fit. An independent probe on 2026-11-18 measured an 8x4 AVIF at those statuses. A first slice that returns `415` for AVIF is unfinished capability, not an accepted product change. ADR-002 forbids shrinking that boundary without a recorded decision on RHEA-226.
- Finish AVIF decode before the migration is called compatible. The dependency path is below. HEIF/HEVC stays download-only unless a later probe shows the current server thumbnails that file.

This matches ADR-004: compare observable status, headers, and image properties. Do not promise byte-identical WebP.

`image` is the recommended path for the formats whose output is already WebP, because those slices stay free of libvips, libheif, and a C toolchain. AVIF is a required later step on that same path or on the libvips path. The WebP encoder in `image-webp` is lossless only, so quality-75 byte identity is not available either way.

## What the TypeScript build actually does

Lockfile: `sharp@0.34.5` with `@img/sharp-libvips-*@1.2.4` (`pnpm-lock.yaml`). `apps/server/package.json` allows `sharp@^0.34.0`. Production image is `node:22-bookworm-slim` and installs Sharp through pnpm (`Dockerfile:1`, `Dockerfile:17`). It does not apt-install libvips.

Sharp's own install document for v0.34.5 says the prebuilt binaries support JPEG, PNG, WebP, AVIF limited to 8-bit depth, TIFF, GIF, and SVG input. HEIC output with HEVC requires a globally installed libvips built with libheif, libde265, and x265. Source: [sharp install.md at v0.34.5](https://github.com/lovell/sharp/blob/v0.34.5/docs/src/content/docs/install.md) and [sharp api-output.md at v0.34.5](https://github.com/lovell/sharp/blob/v0.34.5/docs/src/content/docs/api-output.md).

Code allowlist and build support are different lists.

| Format | Sniff or declared MIME enters `raster()` | `metadata.format` accepted | This host's Sharp 0.34.5 |
| --- | --- | --- | --- |
| JPEG | sniff `FF D8 FF` or `image/jpeg` | `jpeg` | encode, decode, WebP pipeline succeeded |
| PNG | sniff signature or `image/png` | `png` | succeeded |
| WebP | sniff `RIFF`/`WEBP` or `image/webp` | `webp` | succeeded |
| GIF | sniff `GIF87a`/`GIF89a` or `image/gif` | `gif` | succeeded; `animated: false` kept the first frame |
| AVIF | sniff brand `avif`/`avis` or `image/avif` | `avif` or `heif` | 8x4 AVIF encoded; Sharp reported `format: heif`; WebP pipeline succeeded |
| HEIF/HEIC | not sniffed; `image/heic` does not enter the pipeline | `heif` is accepted if Sharp already started | `.heif({ compression: 'hevc' })` failed: `heifsave: Unsupported compression` |
| TIFF | neither sniff nor declared MIME | not in the allowlist | Sharp can encode and decode TIFF; `raster()` still rejects `tiff` |
| SVG | session protocol rejects any prefix match; legacy route stores declared `image/svg+xml` download-only and thumbnails a valid PNG that happens to contain `<svg/>` | not a raster format | this Sharp build can decode SVG (`metadata.format === svg`); a real SVG declared as a raster MIME is still `415` |

Probe host: Ubuntu 24.04.3, `x86_64`, Node `v22.22.0`, `pnpm@11.1.0`, Sharp versions object:

`aom 3.13.1`, `heif 1.20.2`, `vips 8.17.3`, `webp 1.6.0`, `png 1.6.50`, `exif 0.6.25`, `cgif 0.5.0`, `mozjpeg` present. `sharp.format.heif.input.fileSuffix` was `[".avif"]` only. `sharp.format` reported JPEG, PNG, WebP, GIF, TIFF, SVG input, and HEIF input/output. Magick, OpenSlide, PDF, JPEG 2000, and JPEG XL were not enabled in this binary.

Pixel probe, same options as `service.ts` (`limitInputPixels: 16 * 1024 ** 2`, `animated: false`):

- 4096x4096 PNG passed metadata and the WebP resize.
- 4097x4097 PNG failed with `Input image exceeds pixel limit`.
- Orientation-6 JPEG stored 48x24. `rotate()` alone left `metadata()` reporting 48x24 and orientation 6. The full pipeline `rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 })` produced a 24x48 WebP with no EXIF and no orientation field. The application test at 3000x1500 expects preview 1024x2048, which is that same rotate-then-fit behavior. Do not read Sharp `metadata()` after a bare `rotate()` as "rotation did not happen".

These probe results are local to this process. They are not a certificate for every production host. They do show that the lockfile's prebuilt Sharp, on linux x64, matches Sharp's documented prebuilt set and does not encode HEVC.

## Option A — `image` 0.25.10 plus `kamadak-exif` 0.6.x

Primary sources:

- [image 0.25.10 README](https://github.com/image-rs/image/blob/v0.25.10/README.md)
- [image 0.25.10 Cargo.toml features](https://github.com/image-rs/image/blob/v0.25.10/Cargo.toml)
- [image::Limits](https://docs.rs/image/0.25.10/image/struct.Limits.html)
- [image 0.25.10 `src/io/limits.rs`](https://github.com/image-rs/image/blob/v0.25.10/src/io/limits.rs)
- [image-webp README](https://github.com/image-rs/image-webp/blob/master/README.md), the crate `image` 0.25.10 depends on for the `webp` feature
- [kamadak-exif 0.6.1 crate docs](https://docs.rs/kamadak-exif/0.6.1/exif/)
- crates.io on 2026-11-18: `image` 0.25.10, `kamadak-exif` 0.6.2

`image` default features include `jpeg`, `png`, `gif`, `webp`, and `avif`. The first crate commit can disable defaults and enable `jpeg`, `png`, `gif`, and `webp` so `ravif` is not compiled before the AVIF cases run. Final acceptance still enables AVIF decode. The feature to add then is `avif-native` (dav1d). The `avif` feature alone is the `ravif` encoder, and Dropit does not encode AVIF.

Format facts from those pages:

- WebP decode in `image-webp` covers lossless, lossy, alpha, and animation. WebP encode in that crate is lossless only. There is no lossy WebP encoder in the current `image-webp` README.
- `image` AVIF is encode through `ravif` and, with `avif-native`, decode through `dav1d`. The README does not list a HEIF/HEIC decoder. `image-extras` is the documented place for extra decoders, and this research did not verify an `image-extras` HEIC decoder against Dropit's files.
- `Limits` strict checks are `max_image_width` and `max_image_height`. Default is no width or height limit. Default `max_alloc` is 512 MiB and is documented as non-strict. A 4097x4097 image is under both a 4097-pixel edge cap and the 512 MiB allocation cap, so it would pass `image` defaults. The Dropit ceiling is `width * height > 16_777_216`. Setting only `max_alloc` does not reproduce the Sharp error.
- For JPEG, PNG, GIF, and WebP, read dimensions from the still decoder and reject before `read_image` when the product exceeds 16,777,216. That order is not safe for AVIF. See the next section.
- `GifDecoder` implements `AnimationDecoder`. `DynamicImage::from_decoder` uses the still-image decoder path. Whether that path is always the first GIF frame, including a frame that does not start at (0, 0), was not executed in Rust here. The acceptance case must compare the first composited frame, not merely "decode succeeded".
- `image` does not apply EXIF orientation by itself. `kamadak-exif` parses a raw EXIF block and can read JPEG, HEIF, PNG, WebP, and TIFF containers via `Reader::read_from_container`. Orientation is a field the application must honor. Values 2, 4, 5, and 7 include mirrors. The current TypeScript test only pins orientation 6 (rotate 90 degrees clockwise, width and height swap).

Packaging: no system image library. `image` 0.25.10 declares `rust-version = 1.88.0`. The backend crate must record its toolchain in its own README; this research does not install Rust.

Unverified, and must stay labelled unverified until a Rust test runs:

- Lossy WebP at quality 75 is unavailable, so output bytes and file size will differ from Sharp even when dimensions match.
- GIF first-frame composite versus Sharp `animated: false`.
- EXIF orientations other than the one TypeScript test.
- WebP or PNG that carries EXIF orientation. The TypeScript test uses JPEG.
- Animated WebP. Sniff treats it as `image/webp`. Sharp `animated: false` should keep one frame. `image` behavior was not executed.
- Decoder bombs that pass the pixel product and still expand badly. `max_alloc` is non-strict.
- `image` AVIF decode of the same bytes Sharp accepted.

## Option B — `libvips` crate 2.3.0 against system libvips

Primary sources:

- crates.io on 2026-11-18: `libvips` 2.3.0, repository `https://github.com/olxgroup-oss/libvips-rust-bindings`
- [that repository's README](https://github.com/olxgroup-oss/libvips-rust-bindings/blob/master/README.md)
- [libvips resample documentation](https://www.libvips.org/API/current/libvips-resample.html) for `vips_thumbnail`
- [Sharp output docs](https://github.com/lovell/sharp/blob/v0.34.5/docs/src/content/docs/api-output.md) for which HEIF compressors need a custom build

The README says the crate is a generated safe wrapper, operations follow libvips defaults, and `VipsImage` is not thread safe at the time of that README. It also says optional libvips dependencies are format-related and the caller must be careful. The crate does not ship codecs.

`vips_thumbnail` is the libvips operation that combines load and resize and is documented to handle color management and alpha. `thumbnail_image` is documented as the emergency path. A Rust port that loads the whole file and then resizes, which is what `service.ts` does today, matches the current TypeScript memory profile more than it matches the recommended libvips thumbnail path. Either is compatible if the observable outputs match. Prefer the current load-then-resize order until a difference is measured, because that is what the tests describe.

Packaging if this option is chosen later:

- The runtime image needs `libvips` and its codec plugins, pinned by package version.
- Debian Bookworm's libvips does not imply HEVC. Sharp's own output page says HEVC needs libheif, libde265, and x265. Those are patent-encumbered and are absent from the current prebuilt Sharp.
- AVIF in a distro build depends on that distro's libheif/libaom. It is not implied by installing the `libvips` crate.
- The binding uses the system library, so CI, the developer host, and Docker must install the same major version or the format set will drift.
- `VipsApp` must live for the process lifetime. One initializer, not one per request.
- Blocking libvips calls must stay off the async worker, as `rust/DECISIONS.md` already says for image work.
- Thread safety of `VipsImage` is an open warning in the binding README. Do not share one image across Tokio tasks.

Unverified: this research did not compile the crate, did not link a system libvips, and did not run `vips_thumbnail`. Other binding crates exist (`libvips-rs`, `rs-vips`, `vips`). They were not reviewed beyond their crates.io one-line descriptions. Do not switch crates on a description.

## Option C — spawn the existing Sharp binary, or a small sidecar

This keeps byte-level behavior closest to today, because it is the same library. It also keeps Node or a native Sharp addon in the runtime image, which conflicts with ADR-003's end state: the final server runs without Node. An intermediate comparison harness may call the TypeScript server. The production Rust server should not shell out to `node` or `sharp` for each thumbnail.

Not recommended for the implementation slice.

## Packaging comparison

| Path | Runtime packages | Build packages | Formats that path can honestly claim | License notes from upstream docs |
| --- | --- | --- | --- | --- |
| `image` + `kamadak-exif`, before `avif-native` | none for codecs | Rust toolchain, rustc 1.88+ for `image` 0.25.10 | JPEG, PNG, GIF, WebP decode; WebP encode is lossless only. AVIF is unfinished until the next row passes | `image` is MIT OR Apache-2.0. `kamadak-exif` crate page says BSD-2-Clause |
| `image` with `avif-native` | dav1d | dav1d headers or the crate's bundled build | the previous row plus AVIF decode of `F-AVIF-8x4`, once a Rust test shows 8x4 | dav1d's license is its own; do not assume it matches `image` |
| `libvips` crate + distro libvips | libvips and plugins | clang/pkg-config, libvips headers, and codec libraries | whatever that distro enabled; must be probed at test time | libvips itself is LGPL-2.1-or-later. A distro build can pull in further codec licenses. Do not assume the Sharp prebuilt set |
| keep Sharp | Node 22 and the Sharp native addon | node-gyp only if prebuilds are unavailable | the prebuilt set measured above | Sharp is Apache-2.0; bundled libvips is LGPL-2.1-or-later. Already the current runtime |

The current server license is AGPL-3.0-only. Linking LGPL libvips is a distribution question for the release owner if option B is adopted. This research does not make that decision.

## Behavior the backend agent must reproduce without copying Sharp's bytes

| Behavior | How to judge it | Sharp-specific detail that is not a contract |
| --- | --- | --- |
| EXIF orientation 6 | output width and height swap; output has no EXIF/ICC/IPTC/XMP/orientation | exact resampling filter |
| First GIF frame | dimensions of the first frame; a known pixel color from the fixture | Sharp's GIF decoder version |
| Pixel ceiling | `width * height > 16_777_216` becomes `415 INVALID_IMAGE` before a thumbnail exists | Sharp's error string |
| WebP output | RIFF/WEBP sniff, dimensions inside the edge, no enlargement, aspect ratio preserved within 1 pixel | quality 75 lossy bytes |
| AVIF | final target: 201, thumbnail 200, preview 200 at the oriented size. A slice that still returns `415` is unfinished and must say so | Sharp 0.34.5 on linux x64 decoded the 8x4 probe and the existing `backend.test.ts` AVIF case |
| HEIC | declared `image/heic` today does not enter `raster()` unless sniff says AVIF. A download-only item is the compatible result for a non-AVIF HEIC | HEVC is unsupported in the measured prebuild |
| SVG | session complete `415` when the prefix matches; legacy declared SVG is 201 download-only with no thumbnail and media 404; a valid PNG containing `<svg/>` is thumbnailed on the legacy route | Sharp is able to rasterize a real SVG and must not be allowed to |
| Original file | download bytes equal the uploaded bytes | thumbnail and preview are derived |

## Suggested dependency block

This is a proposal, not a lockfile. The backend agent owns `rust/server/**` and should pin versions there after `cargo add` works in that crate.

```toml
[dependencies]
image = { version = "0.25", default-features = false, features = ["jpeg", "png", "gif", "webp"] }
kamadak-exif = "0.6"
```

AVIF decode is required before compatibility acceptance. Add it in the same crate when the fixture runs:

```toml
image = { version = "0.25", default-features = false, features = ["jpeg", "png", "gif", "webp", "avif-native"] }
```

`avif-native` links dav1d. That is a packaging dependency, not a reason to drop the AVIF cases. If the direct decoder below cannot decode `F-AVIF-8x4` to the expected dimensions, switch that format to the libvips path in option B and probe the distro's libheif/libaom before claiming the case. An AVIF encoder is not required, because output is WebP. Do not enable the `avif` feature alone and treat encode support as decode support.

### AVIF pixel check before native decode

`ImageReader` cannot apply the Dropit pixel ceiling before AVIF's native decode. In `image` 0.25.10, `AvifDecoder::new` calls `mp4parse::read_avif`, then `dav1d::Decoder::new`, `send_data`, and `read_until_ready` before the struct exists. `ImageReader::into_decoder` calls `set_limits` only after `make_decoder` returns that struct. `into_dimensions` goes through `into_decoder`. Sources: [`AvifDecoder::new`](https://github.com/image-rs/image/blob/v0.25.10/src/codecs/avif/decoder.rs#L76-L121) and [`ImageReader::into_decoder`](https://github.com/image-rs/image/blob/v0.25.10/src/io/image_reader_type.rs#L218-L223). `AvifDecoder::dimensions` reads the already decoded `dav1d::Picture`, so it is not a pre-check.

Do not call `ImageReader::decode`, `into_decoder`, or `AvifDecoder::new` on an upload. Use this order instead:

1. Sniff the `ftyp` brand. Only `avif` and `avis` enter this path, matching `media.ts`.
2. Parse the ISOBMFF container with `mp4parse::read_avif` (`mp4parse` 0.17.0, the version `image` 0.25.10 names). This reads boxes. It does not decode AV1.
3. Read the primary item's `ispe` width and height before requesting coded bytes. `read_avif` stores that property ([`read_ispe`](https://docs.rs/crate/mp4parse/0.17.0/source/src/lib.rs), HEIF ISO 23008-12 § 6.5.3). `spatial_extents_ptr` can see it, but `ImageSpatialExtentsProperty` keeps the fields private, so the service needs a small local `ispe` reader or a parser whose width and height are public. Missing, duplicate, or truncated `ispe` is `415`, not a cue to fall through to dav1d.
4. If `width == 0`, `height == 0`, or `width as u64 * height as u64 > 16_777_216`, return `415 INVALID_IMAGE` now. Do not call `primary_item_coded_data` and do not construct `dav1d::Decoder`.
5. Only when the product fits, copy the primary item's coded data and decode it with `dav1d` 0.11.0, the version `image` 0.25.10 names. Build the decoder with `Settings`, not `Decoder::new`:

```rust
let mut settings = dav1d::Settings::new();
settings.set_frame_size_limit(16_777_216);
let mut decoder = dav1d::Decoder::with_settings(&settings)?;
```

`set_frame_size_limit` maps to `Dav1dSettings.frame_size_limit`, documented as the maximum frame size in pixels, with 0 meaning unlimited ([dav1d 0.11.0 `Settings`](https://docs.rs/dav1d/0.11.0/dav1d/struct.Settings.html), [dav1d `dav1d.h`](https://github.com/videolan/dav1d/blob/1.5.1/include/dav1d/dav1d.h)). In dav1d 1.5.1, `src/obu.c` compares `width[1] * height` with that limit after the frame header and returns `ERANGE` before the frame OBU continues ([`src/obu.c`](https://github.com/videolan/dav1d/blob/1.5.1/src/obu.c)). `Decoder::new` leaves the limit at 0, which is why `AvifDecoder::new` does not stop an oversized frame.
6. Map a header-check failure or a dav1d `ERANGE` to `415 INVALID_IMAGE`. Delete the temporary file and release the upload reservation, the same way other raster failures do.
7. For an 8x4 file that passes step 4, continue with the same rotate, resize, and WebP encode used for JPEG.

This is a source-derived call order. It is not a memory measurement. The implementation test must show that an oversized AVIF returns 415 without a picture allocation, using a counting `dav1d::PictureAllocator` or an equivalent allocation counter around step 5. Until that counter runs, "no native allocation" stays unverified. A forged `ispe` that is small while the AV1 frame header is large must still die at step 5 with the same 415 and no picture allocation; the `ispe` check is necessary and not sufficient.

If libvips is the fallback, set its pixel limit from the same 16,777,216 product before load. The exact libvips call was not executed here, so that fallback also needs the allocation counter before it can claim the same property.

### How to close the AVIF gap

1. Generate `F-AVIF-8x4` with the same Sharp call the probe used: an 8x4 solid image, `.avif()`, brand `ftypavif`.
2. Upload it on both the legacy route and the session protocol with `Content-Type: image/avif`. Expect 201 and `hasThumbnail=true`.
3. GET thumbnail and preview. Expect 200, `image/webp`, dimensions 8x4, no enlargement.
4. Load a schema-19 fixture that already contains an AVIF item and its thumbnail key. Download returns the original bytes. Thumbnail returns the stored WebP without re-encoding. Preview returns 200 from the original bytes.
5. Record the crate feature, the dav1d version, and the decoded dimensions. If step 2 or 3 fails, the migration is not compatible yet.

## Unverified points, listed so they are not implied

- No Rust crate was compiled here. `rustc` and `cargo` were not installed. `rust-anything` 1.4.0 being installed does not validate these bindings.
- No side-by-side pixel diff between Sharp WebP and `image` WebP was run.
- No real camera HEIC, 10-bit AVIF, animated WebP, or progressive JPEG corpus was decoded. The AVIF probe was an 8x4 image generated by this same Sharp.
- libvips binding thread safety, thumbnail color management, and distro codec sets were read from upstream docs and not executed.
- `image-extras` and alternate crates (`libvips-rs` 8.18.0, `rs-vips` 0.7.0, `vips` 0.2.0) were not source-reviewed.

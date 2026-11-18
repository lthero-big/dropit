# File and media research (RHEA-229)

Research for the Rust server migration. These notes do not change application code and do not authorize a media implementation by themselves. The coordinator turns an accepted plan into a backend task.

| Document | Contents |
| --- | --- |
| [file-media-contract.md](file-media-contract.md) | Current upload, resume, quota, cancel, Range, sniff, thumbnail, and preview behavior, with source locations and the exception paths that are easy to miss |
| [file-media-dependencies.md](file-media-dependencies.md) | `image` plus `kamadak-exif` versus a libvips binding, including what this host's Sharp build actually decoded |
| [file-media-implementation.md](file-media-implementation.md) | Steps, image equivalence rules, fixtures, and pass/fail cases for the backend agent |

## Versions

- TypeScript baseline: `37ce06ebfab2cd98b81e49ce54fb24ec5daeec68`.
- Integration head read for this note: `10ddfc27d1c13bf5afffd17fc1aecaaf31150f6b`. File and media sources cited in the contract note match the baseline.
- Sharp resolved by the lockfile and loaded in the probe: `0.34.5`, libvips `8.17.3`.
- Node used for the probe and tests: `v22.22.0`. pnpm: `11.1.0`.
- Host: Ubuntu 24.04.3, `x86_64`.
- Crate pages read on 2026-11-18: `image` 0.25.10, `kamadak-exif` 0.6.2, `libvips` 2.3.0. No Rust toolchain was installed, so none of those crates were compiled.

## What was run

Isolated TypeScript tests, temporary directories only, from `apps/server`:

```bash
pnpm --filter @dropit/server exec tsx --test test/uploads.test.ts test/rhea190-download-name.test.ts
pnpm --filter @dropit/server exec tsx --test --test-name-pattern 'media preview|AC-S1|AC-S2|AC-S4|thumbnail|Range|range|D2/G|ascii' \
  test/backend.test.ts test/acceptance.test.ts test/machine-auth.test.ts test/phase2-acceptance.test.ts
```

Result on 2026-11-18: 19 pass, 0 fail in the first command (about 9.3 s). 18 pass, 0 fail in the second (about 5.5 s). The second filter also matched one unrelated invite test because its name contains "range"; that test passed and is not media evidence.

A separate Node probe imported `sharp` from `apps/server` and printed codec, pixel-limit, orientation, and GIF first-frame results. Those results are recorded in `file-media-dependencies.md`. No production database or data directory was opened.

## Measured versus inferred

Measured on this host: Sharp's prebuilt codec list, HEVC encode failure, 4096 versus 4097 pixel ceiling, orientation-6 pipeline dimensions, GIF first-frame dimensions, and the existing upload/media/Range tests.

Inferred from source and upstream docs, and not executed in Rust: `image` WebP output versus Sharp, GIF disposal, EXIF orientations other than 6, libvips binding behavior, and distro libvips codec sets.

Review follow-up, still on the same TypeScript tree: an independent probe measured one-chunk index `1` as 400 and two-chunk index `1` as 204, media `Cache-Control: private, no-store`, a legacy PNG without `Content-Type` as 201 with `hasThumbnail=false`, a valid PNG containing `<svg/>` as legacy 201 with a thumbnail and session complete 415, and an 8x4 AVIF as upload 201, thumbnail present, preview 200 at 8x4. Those measurements are now the case inputs. AVIF `415` on a valid small file is an unfinished slice, not the compatibility target.

AVIF pixel limiting is source-derived and not memory-measured. `image` 0.25.10 decodes inside `AvifDecoder::new` before `set_limits`. The specified path reads `ispe` first, then sets `dav1d` `frame_size_limit` to 16,777,216. E13 requires a counting allocator before that timing can be called verified.

## Primary sources

- Dropit source and tests named in the contract note.
- Dropit `docs/api.md` resumable-upload and preview sections.
- [Sharp v0.34.5 install](https://github.com/lovell/sharp/blob/v0.34.5/docs/src/content/docs/install.md), [constructor](https://github.com/lovell/sharp/blob/v0.34.5/docs/src/content/docs/api-constructor.md), [operations](https://github.com/lovell/sharp/blob/v0.34.5/docs/src/content/docs/api-operation.md), [output](https://github.com/lovell/sharp/blob/v0.34.5/docs/src/content/docs/api-output.md).
- [image 0.25.10 README and features](https://github.com/image-rs/image/blob/v0.25.10/README.md), [Limits source](https://github.com/image-rs/image/blob/v0.25.10/src/io/limits.rs), [image-webp README](https://github.com/image-rs/image-webp/blob/master/README.md).
- [kamadak-exif 0.6.1 docs](https://docs.rs/kamadak-exif/0.6.1/exif/).
- [libvips-rust-bindings README](https://github.com/olxgroup-oss/libvips-rust-bindings/blob/master/README.md) for crate 2.3.0.
- [libvips resample API](https://www.libvips.org/API/current/libvips-resample.html).

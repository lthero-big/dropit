//! Existing-file reads: download, stored thumbnail, and sniffed media Range.
//!
//! Boundaries follow `apps/server/src/media.ts`, `files.ts`, and `backend.ts`
//! `sendDownload` / `sendMedia`. This module does not re-encode images.

use std::{
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

use crate::ApiError;

pub fn files_dir(data: &Path) -> PathBuf {
    data.join("files")
}

/// Same key constraint as `DiskFileStorage.path`. A client path never reaches the disk.
pub fn object_path(directory: &Path, key: &str) -> Result<PathBuf, ApiError> {
    if !is_file_key(key) {
        return Err(ApiError::internal("invalid storage key"));
    }
    Ok(directory.join(key))
}

fn is_file_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeDecision {
    Whole,
    Partial(ByteRange),
    Unsatisfiable,
}

/// Port of `parseByteRange`. A header that is absent or not a single range is a full 200.
pub fn parse_byte_range(header: Option<&str>, size: u64) -> RangeDecision {
    let Some(header) = header.map(str::trim).filter(|value| !value.is_empty()) else {
        return RangeDecision::Whole;
    };
    let Some(span) = header.strip_prefix("bytes=") else {
        return RangeDecision::Whole;
    };
    let Some((start_text, end_text)) = span.split_once('-') else {
        return RangeDecision::Whole;
    };
    if span.matches('-').count() != 1 || (start_text.is_empty() && end_text.is_empty()) {
        return RangeDecision::Whole;
    }
    if start_text.bytes().any(|byte| !byte.is_ascii_digit())
        || end_text.bytes().any(|byte| !byte.is_ascii_digit())
    {
        return RangeDecision::Whole;
    }
    if size == 0 {
        return RangeDecision::Unsatisfiable;
    }
    if start_text.is_empty() {
        let Some(suffix) = safe_integer(end_text) else {
            return RangeDecision::Whole;
        };
        if suffix == 0 {
            return RangeDecision::Whole;
        }
        let length = suffix.min(size);
        return RangeDecision::Partial(ByteRange {
            start: size - length,
            end: size - 1,
        });
    }
    let Some(start) = safe_integer(start_text) else {
        return RangeDecision::Whole;
    };
    if start >= size {
        return RangeDecision::Unsatisfiable;
    }
    let end = if end_text.is_empty() {
        size - 1
    } else {
        let Some(end) = safe_integer(end_text) else {
            return RangeDecision::Whole;
        };
        if end < start {
            return RangeDecision::Unsatisfiable;
        }
        end.min(size - 1)
    };
    RangeDecision::Partial(ByteRange { start, end })
}

/// JavaScript `Number.isSafeInteger` for a decimal digit string.
fn safe_integer(text: &str) -> Option<u64> {
    if text.is_empty() || text.len() > 16 {
        return None;
    }
    let value = text.parse::<u64>().ok()?;
    (value < (1_u64 << 53)).then_some(value)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SniffedMedia {
    pub content_type: &'static str,
}

/// Port of `sniffMedia`. The client `Content-Type` is ignored.
pub fn sniff_media(prefix: &[u8]) -> Option<SniffedMedia> {
    if prefix.len() >= 12 && ascii(prefix, 4, 8) == "ftyp" {
        let brand = ascii(prefix, 8, 12);
        let content_type = if matches!(brand, "M4A " | "M4B " | "M4P ") {
            "audio/mp4"
        } else if brand == "qt  " {
            "video/quicktime"
        } else if matches!(
            brand,
            "isom"
                | "iso2"
                | "iso4"
                | "iso5"
                | "iso6"
                | "mp41"
                | "mp42"
                | "avc1"
                | "dash"
                | "M4V "
                | "MSNV"
        ) {
            "video/mp4"
        } else {
            return None;
        };
        return Some(SniffedMedia { content_type });
    }
    if prefix.len() >= 4 && prefix[..4] == [0x1a, 0x45, 0xdf, 0xa3] {
        return prefix
            .windows(4)
            .any(|window| window == b"webm")
            .then_some(SniffedMedia {
                content_type: "video/webm",
            });
    }
    if ascii(prefix, 0, 4) == "OggS" {
        let text = latin1(prefix);
        let content_type = if text.contains("theora") {
            "video/ogg"
        } else if text.contains("OpusHead") || text.contains("vorbis") || text.contains("FLAC") {
            "audio/ogg"
        } else {
            return None;
        };
        return Some(SniffedMedia { content_type });
    }
    if prefix.len() >= 12 && ascii(prefix, 0, 4) == "RIFF" && ascii(prefix, 8, 12) == "WAVE" {
        return Some(SniffedMedia {
            content_type: "audio/wav",
        });
    }
    if ascii(prefix, 0, 4) == "fLaC" {
        return Some(SniffedMedia {
            content_type: "audio/flac",
        });
    }
    if ascii(prefix, 0, 3) == "ID3" || is_mp3_frame(prefix) {
        return Some(SniffedMedia {
            content_type: "audio/mpeg",
        });
    }
    None
}

fn ascii(bytes: &[u8], start: usize, end: usize) -> &str {
    bytes
        .get(start..end)
        .and_then(|slice| std::str::from_utf8(slice).ok())
        .unwrap_or("")
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| *byte as char).collect()
}

fn is_mp3_frame(bytes: &[u8]) -> bool {
    if bytes.len() < 2 || bytes[0] != 0xff {
        return false;
    }
    let next = bytes[1];
    if next & 0xe0 != 0xe0 {
        return false;
    }
    let version = (next >> 3) & 0x03;
    let layer = (next >> 1) & 0x03;
    version != 1 && layer != 0
}

/// Port of `asciiFilename`.
pub fn ascii_filename(filename: &str, fallback: &str) -> String {
    let base = filename.rsplit(['\\', '/']).next().unwrap_or(filename);
    let dot = base.rfind('.');
    let ext = dot.map(|index| &base[index..]).unwrap_or("");
    let safe_ext = (dot.is_some_and(|index| index > 0) && is_ascii_extension(ext)).then_some(ext);
    let stem_source = safe_ext.map(|_| &base[..dot.unwrap()]).unwrap_or(base);
    let mut stem = String::new();
    let mut replacing = false;
    for ch in stem_source.chars() {
        let unsafe_char =
            !('\u{20}'..='\u{7e}').contains(&ch) || matches!(ch, '"' | '\\' | '%' | ';');
        if unsafe_char {
            if !replacing {
                stem.push('_');
                replacing = true;
            }
        } else {
            stem.push(ch);
            replacing = false;
        }
    }
    let stem = stem.trim_matches([' ', '_', '.']);
    let stem = stem.chars().take(120).collect::<String>();
    let stem = stem.trim_end_matches([' ', '_', '.']);
    let stem = if stem.chars().any(|ch| ch.is_ascii_alphanumeric()) {
        stem
    } else {
        fallback
    };
    format!("{stem}{}", safe_ext.unwrap_or(""))
}

fn is_ascii_extension(ext: &str) -> bool {
    let Some(rest) = ext.strip_prefix('.') else {
        return false;
    };
    (1..=16).contains(&rest.len()) && rest.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// `encodeURIComponent` plus the extra encoding of `'()*` used by `contentDisposition`.
pub fn content_disposition(kind: &str, filename: &str) -> String {
    let fallback = if kind == "inline" {
        "media"
    } else {
        "download"
    };
    let ascii = ascii_filename(filename, fallback);
    let mut encoded = String::new();
    for byte in filename.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

pub enum PreparedRead {
    Missing,
    Unsatisfiable {
        size: u64,
        content_type: &'static str,
        disposition: String,
        cache_control: &'static str,
    },
    Body {
        status: StatusCode,
        content_type: &'static str,
        disposition: String,
        cache_control: &'static str,
        length: Option<u64>,
        content_range: Option<String>,
        accept_ranges: bool,
        body: Body,
    },
}

pub fn prepare_download(
    directory: &Path,
    key: &str,
    filename: &str,
    size: u64,
    range: Option<&str>,
    head: bool,
) -> Result<PreparedRead, ApiError> {
    prepare_object(ObjectRead {
        directory,
        key,
        content_type: "application/octet-stream",
        disposition: &content_disposition("attachment", filename),
        cache_control: "no-store",
        size,
        range,
        head,
    })
}

pub fn prepare_media(
    directory: &Path,
    key: &str,
    filename: &str,
    size: u64,
    range: Option<&str>,
    head: bool,
) -> Result<PreparedRead, ApiError> {
    if size < 1 {
        return Ok(PreparedRead::Missing);
    }
    let prefix = read_prefix(directory, key, 4096)?;
    let Some(sniffed) = sniff_media(&prefix) else {
        return Ok(PreparedRead::Missing);
    };
    prepare_object(ObjectRead {
        directory,
        key,
        content_type: sniffed.content_type,
        disposition: &content_disposition("inline", filename),
        cache_control: "private, no-store",
        size,
        range,
        head,
    })
}

pub fn prepare_thumbnail(
    directory: &Path,
    key: &str,
    head: bool,
) -> Result<PreparedRead, ApiError> {
    let path = object_path(directory, key)?;
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(PreparedRead::Missing),
        Err(error) => return Err(ApiError::internal(error)),
    };
    let length = file.metadata().map_err(ApiError::internal)?.len();
    drop(file);
    Ok(PreparedRead::Body {
        status: StatusCode::OK,
        content_type: "image/webp",
        disposition: String::new(),
        cache_control: "no-store",
        // TS streams the stored thumbnail without Accept-Ranges or Content-Length.
        length: None,
        content_range: None,
        accept_ranges: false,
        body: if head {
            Body::empty()
        } else {
            ranged_body(directory, key, 0, length)?
        },
    })
}

struct ObjectRead<'a> {
    directory: &'a Path,
    key: &'a str,
    content_type: &'static str,
    disposition: &'a str,
    cache_control: &'static str,
    size: u64,
    range: Option<&'a str>,
    head: bool,
}

fn prepare_object(read: ObjectRead<'_>) -> Result<PreparedRead, ApiError> {
    let ObjectRead {
        directory,
        key,
        content_type,
        disposition,
        cache_control,
        size,
        range,
        head,
    } = read;
    let decision = parse_byte_range(range, size);
    if matches!(decision, RangeDecision::Unsatisfiable) {
        return Ok(PreparedRead::Unsatisfiable {
            size,
            content_type,
            disposition: disposition.to_owned(),
            cache_control,
        });
    }
    let (start, end) = match decision {
        RangeDecision::Partial(range) => (range.start, range.end),
        RangeDecision::Whole | RangeDecision::Unsatisfiable => (0, size.saturating_sub(1)),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let content_range = matches!(decision, RangeDecision::Partial(_))
        .then(|| format!("bytes {start}-{end}/{size}"));
    let status = if matches!(decision, RangeDecision::Partial(_)) {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let body = if head {
        Body::empty()
    } else {
        ranged_body(directory, key, start, length)?
    };
    Ok(PreparedRead::Body {
        status,
        content_type,
        disposition: disposition.to_owned(),
        cache_control,
        length: Some(length),
        content_range,
        accept_ranges: true,
        body,
    })
}

/// Seek, then stop after `length` bytes. Dropping the body closes the file.
fn ranged_body(directory: &Path, key: &str, start: u64, length: u64) -> Result<Body, ApiError> {
    let path = object_path(directory, key)?;
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(ApiError::NOT_FOUND);
        }
        Err(error) => return Err(ApiError::internal(error)),
    };
    if length == 0 {
        return Ok(Body::empty());
    }
    file.seek(SeekFrom::Start(start))
        .map_err(ApiError::internal)?;
    let async_file = tokio::fs::File::from_std(file);
    Ok(Body::from_stream(ReaderStream::new(
        async_file.take(length),
    )))
}

fn read_prefix(directory: &Path, key: &str, length: usize) -> Result<Vec<u8>, ApiError> {
    let path = object_path(directory, key)?;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ApiError::internal(error)),
    };
    let mut buffer = vec![0; length];
    let read = file.read(&mut buffer).map_err(ApiError::internal)?;
    buffer.truncate(read);
    Ok(buffer)
}

pub fn range_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
}

pub fn into_response(prepared: PreparedRead, head: bool) -> Response {
    match prepared {
        PreparedRead::Missing => ApiError::NOT_FOUND.into_response(),
        PreparedRead::Unsatisfiable {
            size,
            content_type,
            disposition,
            cache_control,
        } => unsatisfiable(size, content_type, &disposition, cache_control),
        PreparedRead::Body {
            status,
            content_type,
            disposition,
            cache_control,
            length,
            content_range,
            accept_ranges,
            body,
        } => {
            let mut response = if head { Body::empty() } else { body }.into_response();
            *response.status_mut() = status;
            let headers = response.headers_mut();
            if accept_ranges {
                headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            }
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
            if !disposition.is_empty() {
                headers.insert(
                    header::CONTENT_DISPOSITION,
                    HeaderValue::from_str(&disposition).unwrap_or_else(|_| {
                        HeaderValue::from_static("attachment; filename=\"download\"")
                    }),
                );
            }
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(cache_control),
            );
            if let Some(length) = length
                && let Ok(value) = HeaderValue::from_str(&length.to_string())
            {
                headers.insert(header::CONTENT_LENGTH, value);
            }
            if let Some(range) = content_range
                && let Ok(value) = HeaderValue::from_str(&range)
            {
                headers.insert(header::CONTENT_RANGE, value);
            }
            response
        }
    }
}

fn unsatisfiable(
    size: u64,
    content_type: &'static str,
    disposition: &str,
    cache_control: &'static str,
) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if !disposition.is_empty()
        && let Ok(value) = HeaderValue::from_str(disposition)
    {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
        headers.insert(header::CONTENT_RANGE, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_ranges_match_the_typescript_parser() {
        assert_eq!(parse_byte_range(None, 10), RangeDecision::Whole);
        assert_eq!(
            parse_byte_range(Some("not-a-range"), 10),
            RangeDecision::Whole
        );
        assert_eq!(
            parse_byte_range(Some("bytes=0-1,4-5"), 10),
            RangeDecision::Whole
        );
        assert_eq!(
            parse_byte_range(Some("bytes=2-5"), 10),
            RangeDecision::Partial(ByteRange { start: 2, end: 5 })
        );
        assert_eq!(
            parse_byte_range(Some("bytes=7-"), 10),
            RangeDecision::Partial(ByteRange { start: 7, end: 9 })
        );
        assert_eq!(
            parse_byte_range(Some("bytes=-3"), 10),
            RangeDecision::Partial(ByteRange { start: 7, end: 9 })
        );
        assert_eq!(
            parse_byte_range(Some("bytes=8-99"), 10),
            RangeDecision::Partial(ByteRange { start: 8, end: 9 })
        );
        assert_eq!(
            parse_byte_range(Some("bytes=10-"), 10),
            RangeDecision::Unsatisfiable
        );
        assert_eq!(
            parse_byte_range(Some("bytes=5-2"), 10),
            RangeDecision::Unsatisfiable
        );
        assert_eq!(parse_byte_range(Some("bytes=-0"), 10), RangeDecision::Whole);
        assert_eq!(
            parse_byte_range(Some("bytes=9007199254740992-"), 10),
            RangeDecision::Whole
        );
    }

    #[test]
    fn sniff_matches_the_media_allowlist() {
        let mut mp4 = b"\0\0\0\x14ftypisom".to_vec();
        mp4.extend_from_slice(b"payload");
        assert_eq!(sniff_media(&mp4).unwrap().content_type, "video/mp4");
        let mut m4a = b"\0\0\0\x14ftypM4A ".to_vec();
        assert_eq!(sniff_media(&m4a).unwrap().content_type, "audio/mp4");
        let mut quicktime = b"\0\0\0\x14ftypqt  ".to_vec();
        assert_eq!(
            sniff_media(&quicktime).unwrap().content_type,
            "video/quicktime"
        );
        let mut avif = b"\0\0\0\x14ftypavif".to_vec();
        assert!(sniff_media(&avif).is_none());
        let mut webm = vec![0x1a, 0x45, 0xdf, 0xa3];
        webm.extend_from_slice(b"webm");
        assert_eq!(sniff_media(&webm).unwrap().content_type, "video/webm");
        let ebml = [0x1a, 0x45, 0xdf, 0xa3, 0, 0];
        assert!(sniff_media(&ebml).is_none());
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&[0, 0, 0, 0]);
        wav.extend_from_slice(b"WAVE");
        assert_eq!(sniff_media(&wav).unwrap().content_type, "audio/wav");
        assert_eq!(sniff_media(b"fLaC....").unwrap().content_type, "audio/flac");
        assert_eq!(sniff_media(b"ID3....").unwrap().content_type, "audio/mpeg");
        assert!(sniff_media(b"<html>").is_none());
        assert!(sniff_media(&[137, 80, 78, 71]).is_none());
        let _ = (&mut m4a, &mut quicktime, &mut avif);
    }

    #[test]
    fn disposition_keeps_ascii_stem_and_encoded_unicode() {
        assert_eq!(
            content_disposition("attachment", "report-2026.pdf"),
            "attachment; filename=\"report-2026.pdf\"; filename*=UTF-8''report-2026.pdf"
        );
        assert_eq!(ascii_filename("报告.pdf", "download"), "download.pdf");
        assert_eq!(ascii_filename("照片 IMG_01.JPG", "download"), "IMG_01.JPG");
        assert_eq!(ascii_filename("a\"b%c;d.txt", "download"), "a_b_c_d.txt");
        assert_eq!(ascii_filename("../../etc/passwd", "download"), "passwd");
        assert_eq!(ascii_filename(".env", "download"), "env");
        assert!(
            content_disposition("attachment", "名 (1).png")
                .contains("filename*=UTF-8''%E5%90%8D%20%281%29.png")
        );
        assert!(content_disposition("inline", "视频").contains("filename=\"media\""));
        assert!(!is_file_key("../etc/passwd"));
        assert!(!is_file_key("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
        assert!(is_file_key("01234567-89ab-cdef-0123-456789abcdef"));
    }
}

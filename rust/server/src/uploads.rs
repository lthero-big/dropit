//! Private-space direct file upload, on-demand preview, and item retract.
//!
//! Legacy POST does not apply the session-complete SVG prefix rule. A declared
//! image MIME is rasterized; SVG and HTML stay download-only. Disk writes use
//! exclusive create, mode `0o600`, and a drop guard so disconnect or failure
//! leaves no file.
//!
//! File creation and retract publish through the landed realtime hub, using the
//! same `groups` and `item.created` / `item.deleted` payloads as text.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
};

use axum::{
    Json,
    body::Body,
    extract::{Extension, Path as UrlPath, Request, State, rejection::PathRejection},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use http_body_util::BodyExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use unicode_normalization::UnicodeNormalization;

use crate::{
    ApiError, ApiResult, App, RequestContext, clean_group, db, decode_uri_component, downloads,
    header_value, images, now, parse_device,
};

const UPLOAD_SLOTS: u32 = 4;
const PREVIEW_SLOTS: u32 = 2;

struct Slot {
    app: App,
    preview: bool,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let counter = if self.preview {
            &self.app.preview_slots
        } else {
            &self.app.upload_slots
        };
        counter.fetch_sub(1, Ordering::SeqCst);
    }
}

fn acquire(app: &App, preview: bool, limit: u32, code: &'static str) -> ApiResult<Slot> {
    let counter = if preview {
        &app.preview_slots
    } else {
        &app.upload_slots
    };
    loop {
        let current = counter.load(Ordering::SeqCst);
        if current >= limit {
            return Err(ApiError::new(429, code));
        }
        if counter
            .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return Ok(Slot {
                app: Arc::clone(app),
                preview,
            });
        }
    }
}

struct Staged {
    path: PathBuf,
    keep: bool,
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct Stored {
    key: String,
    size: u64,
    sha256: String,
    staged: Staged,
}

pub async fn upload_file(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<String>, PathRejection>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    let auth = context.require_auth()?;
    let UrlPath(space_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user_id = auth.account.user.id.clone();
    let scope = space_id.clone();
    app.db
        .run(move |db| db::space(db, &scope, &user_id, true))
        .await?;
    app.limit("upload:ip", &context.ip, app.config.rate_upload)?;
    app.limit("upload:user", &auth.account.user.id, app.config.rate_upload)?;

    let headers = request.headers().clone();
    let expected = expected_length(
        header_value(&headers, "content-length"),
        app.config.max_file,
    )?;
    let filename = decoded_filename(header_value(&headers, "x-file-name"))?;
    let mime = declared_mime(header_value(&headers, "content-type"))?;
    let group = decoded_group(header_value(&headers, "x-dropit-group"))?;
    let device = parse_device(&headers);

    let slot = acquire(&app, false, UPLOAD_SLOTS, "UPLOAD_BUSY")?;
    let directory = downloads::files_dir(&app.config.data);
    let limit = u64::try_from(app.config.max_file).unwrap_or(0);
    let stored = write_body(&directory, request.into_body(), limit).await?;
    if stored.sha256.len() != 64 {
        return Err(ApiError::internal("sha256"));
    }
    if let Some(expected) = expected
        && stored.size != expected
    {
        return Err(ApiError::new(400, "UPLOAD_INCOMPLETE"));
    }

    let mut thumbnail: Option<(String, Staged, i64)> = None;
    if wants_thumbnail(&mime) {
        let path = stored.staged.path.clone();
        let derived = tokio::task::spawn_blocking(move || images::derive_file(&path, 320))
            .await
            .map_err(ApiError::internal)?
            .map_err(ApiError::from)?;
        if derived.len() > images::THUMBNAIL_BYTES {
            return Err(ApiError::new(413, "FILE_TOO_LARGE"));
        }
        let thumb = write_bytes(&directory, &derived).await?;
        thumbnail = Some((thumb.key, thumb.staged, derived.len() as i64));
    }

    let group = group
        .filter(|value| !value.is_empty())
        .map(|value| clean_group(&value))
        .transpose()?;
    let thumb_size = thumbnail.as_ref().map(|(_, _, size)| *size).unwrap_or(0);
    let input = db::FileInput {
        filename: clean_filename(&filename),
        mime,
        size: stored.size as i64,
        stored_bytes: stored.size as i64 + thumb_size,
        file_key: stored.key.clone(),
        thumbnail_key: thumbnail.as_ref().map(|(key, _, _)| key.clone()),
        group,
        device,
    };
    let config = app.config.clone();
    let hash = auth.session_hash.clone();
    let channel = space_id.clone();
    // Hold the snapshot gate across the commit and publish, matching text.
    let _gate = app.realtime.gate.lock().await;
    let (item, groups) = app
        .db
        .run(move |db| {
            let before = db::groups(db, &space_id)?;
            let item = db::insert_file(db, &config, &hash, &space_id, input);
            let after = db::groups(db, &space_id)?;
            Ok((item, (before != after).then_some(after)))
        })
        .await?;
    if let Some(groups) = groups {
        app.realtime
            .publish(&channel, json!({ "type": "groups", "groups": groups }));
    }
    let item = item?;
    app.realtime
        .publish(&channel, json!({ "type": "item.created", "item": item }));
    drop(_gate);
    // Commit succeeded. Keep the files; a later retract removes them.
    let _slot = slot;
    forget_staged(stored.staged);
    if let Some((_, staged, _)) = thumbnail {
        forget_staged(staged);
    }
    Ok((StatusCode::CREATED, Json(json!({ "item": item }))))
}

fn forget_staged(mut staged: Staged) {
    staged.keep = true;
}

pub async fn retract(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    let auth = context.require_auth()?;
    let UrlPath((space_id, item_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user_id = auth.account.user.id.clone();
    let scope = space_id.clone();
    app.db
        .run(move |db| db::space(db, &scope, &user_id, true))
        .await?;
    app.limit("write:ip", &context.ip, app.config.rate_upload)?;
    app.limit("write:user", &auth.account.user.id, app.config.rate_upload)?;
    let hash = auth.session_hash.clone();
    let channel = space_id.clone();
    let deleted = item_id.clone();
    let _gate = app.realtime.gate.lock().await;
    let keys = app
        .db
        .run(move |db| db::delete_item(db, &hash, &space_id, &item_id))
        .await?;
    app.realtime
        .publish(&channel, json!({ "type": "item.deleted", "id": deleted }));
    drop(_gate);
    let directory = downloads::files_dir(&app.config.data);
    for key in keys {
        remove_stored(&directory, &key).await?;
        app.db.run(move |db| db::forget_garbage(db, &key)).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn preview(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String)>, PathRejection>,
) -> Response {
    let Ok(auth) = context.require_auth() else {
        return ApiError::UNAUTHENTICATED.into_response();
    };
    let Ok(UrlPath((space_id, item_id))) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let user_id = auth.account.user.id.clone();
    let source = match app
        .db
        .run(move |db| db::preview_source(db, &space_id, &user_id, &item_id))
        .await
    {
        Ok(source) => source,
        Err(error) => return error.into_response(),
    };
    let slot = match acquire(&app, true, PREVIEW_SLOTS, "PREVIEW_BUSY") {
        Ok(slot) => slot,
        Err(error) => return error.into_response(),
    };
    let directory = downloads::files_dir(&app.config.data);
    let key = source.file_key.clone();
    let hold = preview_hold_ms();
    let derived = tokio::task::spawn_blocking(move || {
        let path = downloads::object_path(&directory, &key).map_err(|_| images::RasterError)?;
        let bytes = images::derive_file(&path, 2048)?;
        if hold > 0 {
            std::thread::sleep(std::time::Duration::from_millis(hold));
        }
        Ok::<_, images::RasterError>(bytes)
    })
    .await;
    let bytes = match derived {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            drop(slot);
            return ApiError::from(error).into_response();
        }
        Err(error) => {
            drop(slot);
            return ApiError::internal(error).into_response();
        }
    };
    let item_id = source.item_id.clone();
    let live = app.db.run(move |db| db::item_live(db, &item_id)).await;
    drop(slot);
    match live {
        Ok(true) => {}
        Ok(false) => return ApiError::NOT_FOUND.into_response(),
        Err(error) => return error.into_response(),
    }
    let max_age = (source.expires_at - now()).max(0) / 1000;
    let max_age = max_age.min(60);
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_str(&format!("private, max-age={max_age}")).unwrap(),
    );
    response
}

fn preview_hold_ms() -> u64 {
    std::env::var("DROPIT_PREVIEW_HOLD_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn expected_length(raw: Option<&str>, max: i64) -> ApiResult<Option<u64>> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Ok(length) = raw.trim().parse::<f64>() else {
        return Ok(None);
    };
    if !length.is_finite() {
        return Ok(None);
    }
    if length > max as f64 {
        return Err(ApiError::new(413, "FILE_TOO_LARGE"));
    }
    if length.fract() == 0.0 && length >= 0.0 {
        Ok(Some(length as u64))
    } else {
        Ok(None)
    }
}

fn decoded_filename(raw: Option<&str>) -> ApiResult<String> {
    let raw = raw.unwrap_or("download");
    let filename = decode_uri_component(raw).ok_or(ApiError::new(400, "INVALID_FILENAME"))?;
    if filename.encode_utf16().count() > 4096 {
        return Err(ApiError::new(400, "INVALID_FILENAME"));
    }
    Ok(filename)
}

fn declared_mime(raw: Option<&str>) -> ApiResult<String> {
    let mime = raw
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_ascii_lowercase();
    if mime.encode_utf16().count() > 200 {
        return Err(ApiError::new(400, "INVALID_INPUT"));
    }
    Ok(mime)
}

fn decoded_group(raw: Option<&str>) -> ApiResult<Option<String>> {
    match raw.filter(|value| !value.is_empty()) {
        Some(raw) => Ok(Some(
            decode_uri_component(raw).ok_or(ApiError::new(400, "INVALID_GROUP"))?,
        )),
        None => Ok(None),
    }
}

fn wants_thumbnail(mime: &str) -> bool {
    matches!(
        mime,
        "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif"
    )
}

pub fn clean_filename(input: &str) -> String {
    let normalized: String = input.nfkc().collect();
    let mut cleaned = String::with_capacity(normalized.len());
    for ch in normalized.chars() {
        let code = ch as u32;
        let bad = matches!(ch, '\\' | '/')
            || code <= 0x1f
            || (0x7f..=0x9f).contains(&code)
            || (0x202a..=0x202e).contains(&code)
            || (0x2066..=0x2069).contains(&code);
        cleaned.push(if bad { '_' } else { ch });
    }
    let stripped = cleaned.trim_start_matches('.');
    let trimmed = trim_js(stripped);
    let sliced = utf16_prefix(trimmed, 180);
    if sliced.is_empty() {
        "download".into()
    } else {
        sliced
    }
}

fn trim_js(value: &str) -> &str {
    value.trim_matches(|ch: char| {
        crate::js_space(ch) || matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
    })
}

fn utf16_prefix(value: &str, limit: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in value.char_indices() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        end = index + ch.len_utf8();
    }
    value[..end].to_owned()
}

async fn write_body(directory: &Path, body: Body, limit: u64) -> ApiResult<Stored> {
    let key = uuid::Uuid::new_v4().to_string();
    let path = downloads::object_path(directory, &key)?;
    let staged = Staged {
        path: path.clone(),
        keep: false,
    };
    let mut file = create_exclusive(directory, &path).await?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut body = body;
    while let Some(next) = body.frame().await {
        let frame = next.map_err(|_| ApiError::new(404, "NOT_FOUND"))?;
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or(ApiError::new(413, "FILE_TOO_LARGE"))?;
        if size > limit {
            return Err(ApiError::new(413, "FILE_TOO_LARGE"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    if size == 0 {
        return Err(ApiError::new(400, "EMPTY_FILE"));
    }
    file.sync_all().await.map_err(ApiError::internal)?;
    drop(file);
    Ok(Stored {
        key,
        size,
        sha256: hex_encode(hasher.finalize()),
        staged,
    })
}

async fn write_bytes(directory: &Path, bytes: &[u8]) -> ApiResult<Stored> {
    let key = uuid::Uuid::new_v4().to_string();
    let path = downloads::object_path(directory, &key)?;
    let staged = Staged {
        path: path.clone(),
        keep: false,
    };
    let mut file = create_exclusive(directory, &path).await?;
    file.write_all(bytes).await.map_err(ApiError::internal)?;
    file.sync_all().await.map_err(ApiError::internal)?;
    drop(file);
    Ok(Stored {
        key,
        size: bytes.len() as u64,
        sha256: hex_encode(Sha256::digest(bytes)),
        staged,
    })
}

async fn create_exclusive(directory: &Path, path: &Path) -> ApiResult<tokio::fs::File> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(ApiError::internal)?;
    tokio::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
        .await
        .map_err(ApiError::internal)?;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let file = options.open(path).await.map_err(ApiError::internal)?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .await
        .map_err(ApiError::internal)?;
    Ok(file)
}

async fn remove_stored(directory: &Path, key: &str) -> ApiResult<()> {
    let path = downloads::object_path(directory, key)?;
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ApiError::internal(error)),
    }
}

fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let bytes = bytes.as_ref();
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::clean_filename;

    #[test]
    fn filename_strips_path_and_controls() {
        let cleaned = clean_filename("../..\\bad\u{0}\r\n名.png");
        assert!(!cleaned.contains(['\\', '/', '\0', '\r', '\n']));
        assert_eq!(cleaned, "_.._bad___名.png");
        assert_eq!(clean_filename("..."), "download");
        assert_eq!(clean_filename("  report.txt  "), "report.txt");
    }
}

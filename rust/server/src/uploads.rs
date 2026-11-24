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
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};

use axum::{
    Json,
    body::Body,
    extract::{Extension, Path as UrlPath, Request, State, rejection::PathRejection},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::FutureExt;
use http_body_util::BodyExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{io::AsyncWriteExt, sync::Notify, time::timeout};
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

pub async fn upload_room(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<String>, PathRejection>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    let UrlPath(room_token) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let room = crate::rooms::load_room(&app, &room_token).await?;
    app.limit("room-write:ip", &context.ip, app.config.rate_room)?;
    let headers = request.headers().clone();
    let expected = expected_length(
        header_value(&headers, "content-length"),
        app.config.room_max_file,
    )?;
    let filename = decoded_filename(header_value(&headers, "x-file-name"))?;
    let mime = declared_mime(header_value(&headers, "content-type"))?;
    let group = decoded_group(header_value(&headers, "x-dropit-group"))?;
    let device = parse_device(&headers);
    let slot = acquire(&app, false, UPLOAD_SLOTS, "UPLOAD_BUSY")?;
    let directory = downloads::files_dir(&app.config.data);
    let stored = write_body(
        &directory,
        request.into_body(),
        app.config.room_max_file as u64,
    )
    .await?;
    if stored.size == 0 {
        return Err(ApiError::new(400, "EMPTY_FILE"));
    }
    if let Some(expected) = expected
        && stored.size != expected
    {
        return Err(ApiError::new(400, "UPLOAD_INCOMPLETE"));
    }
    let mut thumbnail: Option<(String, Staged, i64)> = None;
    if wants_thumbnail(&mime) {
        let source = stored.staged.path.clone();
        let derived = tokio::task::spawn_blocking(move || images::derive_file(&source, 320))
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
    let channel = room.id.clone();
    let config = app.config.clone();
    let _gate = app.realtime.gate.lock().await;
    let (item, groups) = app
        .db
        .run({
            let channel = channel.clone();
            move |db| {
                let before = db::groups(db, &channel)?;
                let item = db::insert_room_file(db, &config, &channel, input);
                let after = db::groups(db, &channel)?;
                Ok((item, (before != after).then_some(after)))
            }
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
    preview_item(app, source, false).await
}

pub async fn preview_item(app: App, source: db::PreviewSource, shared: bool) -> Response {
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
        if shared {
            HeaderValue::from_static("no-store")
        } else {
            HeaderValue::from_str(&format!("private, max-age={max_age}")).unwrap()
        },
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

/// In-process chunk and complete work. Caps do not abort a write already running.
#[derive(Default)]
pub struct ChunkWork {
    inner: Mutex<ChunkState>,
}

#[derive(Default)]
struct ChunkState {
    sessions: HashMap<String, u32>,
    principals: HashMap<String, u32>,
    active: u32,
    completing: HashMap<String, Arc<Notify>>,
    cancelled: HashMap<String, Vec<Arc<Notify>>>,
}

struct ChunkPermit {
    app: App,
    session: String,
    principal: String,
    /// Private to this write. Drop notifies only the cancel waiter for this permit.
    notify: Arc<Notify>,
}

impl Drop for ChunkPermit {
    fn drop(&mut self) {
        let mut state = self.app.chunk_work.inner.lock().expect("chunk work");
        release_count(&mut state.sessions, &self.session);
        release_count(&mut state.principals, &self.principal);
        state.active = state.active.saturating_sub(1);
        if let Some(waiters) = state.cancelled.get_mut(&self.session) {
            waiters.retain(|waiter| !Arc::ptr_eq(waiter, &self.notify));
            if waiters.is_empty() {
                state.cancelled.remove(&self.session);
            }
        }
        self.notify.notify_waiters();
    }
}

fn release_count(map: &mut HashMap<String, u32>, key: &str) {
    if let Some(count) = map.get_mut(key) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            map.remove(key);
        }
    }
}

fn chunk_busy() -> ApiError {
    let mut error = ApiError::new(429, "CHUNK_BUSY");
    error.header = Some((header::RETRY_AFTER, HeaderValue::from_static("1")));
    error
}

fn acquire_chunk(app: &App, session: &str, principal: &str) -> ApiResult<ChunkPermit> {
    let mut state = app.chunk_work.inner.lock().map_err(ApiError::internal)?;
    if state.completing.contains_key(session) {
        return Err(ApiError::new(409, "UPLOAD_IN_PROGRESS"));
    }
    let own_session = state.sessions.get(session).copied().unwrap_or(0);
    let own_principal = state.principals.get(principal).copied().unwrap_or(0);
    if own_session >= app.config.upload_chunks_per_session
        || own_principal >= app.config.upload_chunks_per_user
        || state.active >= app.config.upload_chunks_global
    {
        return Err(chunk_busy());
    }
    *state.sessions.entry(session.to_owned()).or_insert(0) += 1;
    *state.principals.entry(principal.to_owned()).or_insert(0) += 1;
    state.active += 1;
    let notify = Arc::new(Notify::new());
    state
        .cancelled
        .entry(session.to_owned())
        .or_default()
        .push(Arc::clone(&notify));
    Ok(ChunkPermit {
        app: Arc::clone(app),
        session: session.to_owned(),
        principal: principal.to_owned(),
        notify,
    })
}

pub async fn create_upload(
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
    let body = crate::read_json(request, 8192).await?;
    let filename = crate::input_js_string(body.get("filename"), 4096)?.clean_filename();
    let size = json_size(body.get("size"), app.config.max_file)?;
    let mime = session_mime(body.get("mime"))?;
    let created_at = now();
    let mut upload = db::NewUpload {
        id: uuid::Uuid::new_v4().to_string(),
        space_id: space_id.clone(),
        user_id: Some(auth.account.user.id.clone()),
        principal: format!("user:{}", auth.account.user.id),
        filename,
        mime,
        size,
        chunk_size: app.config.upload_chunk_bytes,
        created_at,
        expires_at: created_at.saturating_add(86_400_000),
        quota: auth.account.quota.unwrap_or(app.config.quota),
        max_items: app.config.max_items,
        sessions_per_user: app.config.upload_sessions_per_user,
        sessions_global: app.config.upload_sessions_global,
    };
    let response_id = upload.id.clone();
    app.db
        .run(move |db| db::create_upload_for_user(db, &mut upload))
        .await?;
    let created = app
        .db
        .run(move |db| db::upload_session(db, &response_id, now()))
        .await?
        .ok_or(ApiError::NOT_FOUND)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "uploadId": created.id,
            "chunkSize": created.chunk_size,
            "expiresAt": created.expires_at,
            "received": [],
        })),
    ))
}

pub async fn get_upload(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String)>, PathRejection>,
) -> ApiResult<Json<serde_json::Value>> {
    let auth = context.require_auth()?;
    let UrlPath((space_id, upload_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user_id = auth.account.user.id.clone();
    app.limit("general:user", &user_id, app.config.rate_general)?;
    let (upload, chunks) = app
        .db
        .run(move |db| {
            db::space(db, &space_id, &user_id, false)?;
            let upload = authorized_upload(db, &space_id, &user_id, &upload_id)?;
            let chunks = db::upload_chunks(db, &upload_id)?;
            Ok((upload, chunks))
        })
        .await?;
    Ok(Json(json!({
        "size": upload.size,
        "chunkSize": upload.chunk_size,
        "expiresAt": upload.expires_at,
        "received": chunks.into_iter().map(|chunk| chunk.index).collect::<Vec<_>>(),
    })))
}

pub async fn put_chunk(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String, String)>, PathRejection>,
    request: Request,
) -> ApiResult<StatusCode> {
    let auth = context.require_auth()?;
    let UrlPath((space_id, upload_id, raw_index)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user_id = auth.account.user.id.clone();
    let scope = space_id.clone();
    let id = upload_id.clone();
    app.db
        .run(move |db| {
            db::space(db, &scope, &user_id, true)?;
            authorized_upload(db, &scope, &user_id, &id)
        })
        .await?;
    // Chunk rate is consumed in api_context so this path does not also take general/token.
    let checksum = header_value(request.headers(), "x-chunk-sha256").map(str::to_owned);
    if let Some(checksum) = &checksum
        && (checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(ApiError::new(400, "INVALID_CHECKSUM"));
    }
    let principal = format!("user:{}", auth.account.user.id);
    let permit = acquire_chunk(&app, &upload_id, &principal)?;
    let directory = downloads::files_dir(&app.config.data);
    let timeout_ms = app.config.upload_chunk_timeout_ms as u64;
    let index = chunk_index(&raw_index)?;
    let user_id = auth.account.user.id.clone();
    let scope = space_id.clone();
    let id = upload_id.clone();
    let expected = app
        .db
        .run(move |db| {
            let upload = authorized_upload(db, &scope, &user_id, &id)?;
            chunk_expected(&upload, index)
        })
        .await?;
    let stored = match timeout(
        Duration::from_millis(timeout_ms),
        write_limited(&directory, request.into_body(), expected, &permit.notify),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => return Err(ApiError::new(400, "UPLOAD_TIMEOUT")),
    };
    if stored.size != expected {
        return Err(ApiError::new(400, "CHUNK_SIZE_MISMATCH"));
    }
    if let Some(checksum) = checksum
        && !stored.sha256.eq_ignore_ascii_case(&checksum)
    {
        return Err(ApiError::new(400, "CHECKSUM_MISMATCH"));
    }
    let user_id = auth.account.user.id.clone();
    let scope = space_id.clone();
    let id = upload_id.clone();
    let key = stored.key.clone();
    let sha = stored.sha256.clone();
    let committed = app
        .db
        .run(move |db| {
            authorized_upload(db, &scope, &user_id, &id)?;
            db::save_chunk(db, &id, index, &key, expected as i64, &sha, now())
        })
        .await?;
    if committed {
        forget_staged(stored.staged);
    } else {
        // Identical retry: the first key stays. Drop the new file now.
        drop(stored);
        let _ = flush_garbage(&app, &directory).await;
    }
    drop(permit);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn complete_upload(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String)>, PathRejection>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    let auth = context.require_auth()?;
    let UrlPath((space_id, upload_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user_id = auth.account.user.id.clone();
    let scope = space_id.clone();
    let id = upload_id.clone();
    let upload = app
        .db
        .run(move |db| {
            db::space(db, &scope, &user_id, true)?;
            authorized_upload(db, &scope, &user_id, &id)
        })
        .await?;
    app.limit("upload:ip", &context.ip, app.config.rate_upload)?;
    app.limit("upload:user", &auth.account.user.id, app.config.rate_upload)?;
    let headers = request.headers().clone();
    let group = decoded_group(header_value(&headers, "x-dropit-group"))?;
    let device = parse_device(&headers);
    let complete_notify = begin_complete(&app, &upload_id)?;
    let result = finish_complete(
        &app,
        auth,
        &space_id,
        &upload,
        group,
        device,
        &complete_notify,
    )
    .await;
    let directory = downloads::files_dir(&app.config.data);
    // A successful commit already deleted the session. Failure must delete it too.
    // Cancel may have deleted it first; deleting again is a no-op.
    if result.is_err() {
        let id = upload_id.clone();
        let _ = app.db.run(move |db| db::delete_upload(db, &id)).await;
    }
    end_complete(&app, &upload_id);
    let _ = flush_garbage(&app, &directory).await;
    let (item, groups, channel) = result?;
    let _gate = app.realtime.gate.lock().await;
    if let Some(groups) = groups {
        app.realtime
            .publish(&channel, json!({ "type": "groups", "groups": groups }));
    }
    app.realtime
        .publish(&channel, json!({ "type": "item.created", "item": item }));
    drop(_gate);
    Ok((StatusCode::CREATED, Json(json!({ "item": item }))))
}

async fn finish_complete(
    app: &App,
    auth: &crate::Auth,
    space_id: &str,
    upload: &db::UploadSession,
    group: Option<String>,
    device: Option<db::Device>,
    cancel: &Notify,
) -> ApiResult<(db::Item, Option<Vec<String>>, String)> {
    let user_id = auth.account.user.id.clone();
    let scope = space_id.to_owned();
    let id = upload.id.clone();
    let chunks = app
        .db
        .run(move |db| {
            authorized_upload(db, &scope, &user_id, &id)?;
            db::upload_chunks(db, &id)
        })
        .await?;
    let count = div_ceil(upload.size, upload.chunk_size);
    let contiguous = chunks.len() as i64 == count
        && chunks
            .iter()
            .enumerate()
            .all(|(index, chunk)| chunk.index == index as i64);
    let sizes_match = chunks.iter().map(|chunk| chunk.size).sum::<i64>() == upload.size
        && chunks.iter().enumerate().all(|(index, chunk)| {
            chunk.size
                == upload
                    .chunk_size
                    .min(upload.size - index as i64 * upload.chunk_size)
        });
    if !contiguous || !sizes_match {
        return Err(ApiError::new(400, "UPLOAD_INCOMPLETE"));
    }
    if was_cancelled(cancel) {
        return Err(ApiError::NOT_FOUND);
    }
    let directory = downloads::files_dir(&app.config.data);
    let keys: Vec<String> = chunks.iter().map(|chunk| chunk.key.clone()).collect();
    let assembled = assemble_chunks(&directory, &keys, upload.size as u64, cancel).await?;
    let prefix = read_prefix(&assembled.staged.path, 4096).await?;
    if upload.mime == "image/svg+xml" || svg_prefix(&prefix) {
        return Err(ApiError::new(415, "INVALID_IMAGE"));
    }
    let sniffed = sniff_raster(&prefix);
    let mut thumbnail: Option<(String, Staged, i64)> = None;
    if sniffed.is_some() || wants_thumbnail(&upload.mime) {
        let path = assembled.staged.path.clone();
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
        filename: upload.filename.clone(),
        mime: upload.mime.clone(),
        size: assembled.size as i64,
        stored_bytes: assembled.size as i64 + thumb_size,
        file_key: assembled.key.clone(),
        thumbnail_key: thumbnail.as_ref().map(|(key, _, _)| key.clone()),
        group,
        device,
    };
    let hash = auth.session_hash.clone();
    let channel = space_id.to_owned();
    let space_id = space_id.to_owned();
    let upload_id = upload.id.clone();
    let config = app.config.clone();
    let _gate = app.realtime.gate.lock().await;
    let committed = app
        .db
        .run(move |db| {
            if db::upload_session(db, &upload_id, now())?.is_none() {
                return Err(ApiError::NOT_FOUND);
            }
            let before = db::groups(db, &space_id)?;
            let item = db::complete_upload(db, &config, &hash, &space_id, &upload_id, input);
            let after = db::groups(db, &space_id)?;
            Ok((item, (before != after).then_some(after)))
        })
        .await;
    drop(_gate);
    let (item, groups) = committed?;
    let item = item?;
    forget_staged(assembled.staged);
    if let Some((_, staged, _)) = thumbnail {
        forget_staged(staged);
    }
    Ok((item, groups, channel))
}

async fn finish_room_complete(
    app: &App,
    space_id: &str,
    upload: &db::UploadSession,
    group: Option<String>,
    device: Option<db::Device>,
    cancel: &Notify,
) -> ApiResult<(db::Item, Option<Vec<String>>, String)> {
    let scope = space_id.to_owned();
    let id = upload.id.clone();
    let chunks = app
        .db
        .run(move |db| {
            room_upload(db, &scope, &id)?;
            db::upload_chunks(db, &id)
        })
        .await?;
    let count = div_ceil(upload.size, upload.chunk_size);
    let contiguous = chunks.len() as i64 == count
        && chunks
            .iter()
            .enumerate()
            .all(|(index, chunk)| chunk.index == index as i64);
    let sizes_match = chunks.iter().map(|chunk| chunk.size).sum::<i64>() == upload.size
        && chunks.iter().enumerate().all(|(index, chunk)| {
            chunk.size
                == upload
                    .chunk_size
                    .min(upload.size - index as i64 * upload.chunk_size)
        });
    if !contiguous || !sizes_match {
        return Err(ApiError::new(400, "UPLOAD_INCOMPLETE"));
    }
    if was_cancelled(cancel) {
        return Err(ApiError::NOT_FOUND);
    }
    let directory = downloads::files_dir(&app.config.data);
    let keys: Vec<String> = chunks.iter().map(|chunk| chunk.key.clone()).collect();
    let assembled = assemble_chunks(&directory, &keys, upload.size as u64, cancel).await?;
    let prefix = read_prefix(&assembled.staged.path, 4096).await?;
    if upload.mime == "image/svg+xml" || svg_prefix(&prefix) {
        return Err(ApiError::new(415, "INVALID_IMAGE"));
    }
    let sniffed = sniff_raster(&prefix);
    let mut thumbnail: Option<(String, Staged, i64)> = None;
    if sniffed.is_some() || wants_thumbnail(&upload.mime) {
        let path = assembled.staged.path.clone();
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
        filename: upload.filename.clone(),
        mime: upload.mime.clone(),
        size: assembled.size as i64,
        stored_bytes: assembled.size as i64 + thumb_size,
        file_key: assembled.key.clone(),
        thumbnail_key: thumbnail.as_ref().map(|(key, _, _)| key.clone()),
        group,
        device,
    };
    let channel = space_id.to_owned();
    let space_id = space_id.to_owned();
    let upload_id = upload.id.clone();
    let config = app.config.clone();
    // Gate then DB, matching room text, retract, and the room snapshot. A retract
    // cannot commit between this write and item.created. The gate drops before
    // the caller flushes garbage.
    let _gate = app.realtime.gate.lock().await;
    let committed = app
        .db
        .run(move |db| {
            if room_upload(db, &space_id, &upload_id).is_err() {
                return Err(ApiError::NOT_FOUND);
            }
            let before = db::groups(db, &space_id)?;
            let item = db::complete_room_upload(db, &config, &space_id, &upload_id, input);
            let after = db::groups(db, &space_id)?;
            Ok((item, (before != after).then_some(after)))
        })
        .await;
    let (item, groups) = committed?;
    // A committed group stays even when the later item insert fails. Publish it
    // before returning that error, matching resolveGroup before addItem.
    if let Some(groups) = &groups {
        app.realtime
            .publish(&channel, json!({ "type": "groups", "groups": groups }));
    }
    let item = match item {
        Ok(item) => item,
        Err(error) => return Err(error),
    };
    // Still holding the gate, after the commit and before item.created.
    crate::realtime::test_barrier("room-complete-committed").await;
    app.realtime
        .publish(&channel, json!({ "type": "item.created", "item": item }));
    drop(_gate);
    forget_staged(assembled.staged);
    if let Some((_, staged, _)) = thumbnail {
        forget_staged(staged);
    }
    Ok((item, groups, channel))
}

pub async fn cancel_upload(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    let auth = context.require_auth()?;
    let UrlPath((space_id, upload_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user_id = auth.account.user.id.clone();
    let scope = space_id.clone();
    let id = upload_id.clone();
    app.db
        .run(move |db| {
            db::space(db, &scope, &user_id, true)?;
            authorized_upload(db, &scope, &user_id, &id)?;
            Ok(())
        })
        .await?;
    app.limit("general:ip", &context.ip, app.config.rate_general)?;
    app.limit(
        "general:user",
        &auth.account.user.id,
        app.config.rate_general,
    )?;
    let id = upload_id.clone();
    app.db.run(move |db| db::delete_upload(db, &id)).await?;
    abort_session(&app, &upload_id).await;
    let directory = downloads::files_dir(&app.config.data);
    flush_garbage(&app, &directory).await;
    Ok(StatusCode::NO_CONTENT)
}

fn room_write_limit(app: &App, context: &RequestContext) -> ApiResult<()> {
    app.limit("room-write:ip", &context.ip, app.config.rate_room)?;
    if let Some(auth) = &context.auth {
        app.limit(
            "room-write:user",
            &auth.account.user.id,
            app.config.rate_room,
        )?;
    }
    Ok(())
}

fn room_principal(context: &RequestContext, space_id: &str) -> String {
    match context.auth.as_ref() {
        Some(auth) => format!("user:{}", auth.account.user.id),
        None => format!("room:{space_id}"),
    }
}

fn room_upload(
    db: &rusqlite::Connection,
    space_id: &str,
    upload_id: &str,
) -> ApiResult<db::UploadSession> {
    let upload = db::upload_session(db, upload_id, now())?.ok_or(ApiError::NOT_FOUND)?;
    // Any holder of this room token may resume the session. A user-owned private
    // session must not be completed into the room.
    if upload.space_id != space_id || upload.user_id.is_some() {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(upload)
}

pub async fn create_room_upload(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<String>, PathRejection>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    let UrlPath(token) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let room = crate::rooms::scope(&app, &context, &token).await?;
    room_write_limit(&app, &context)?;
    let body = crate::read_json(request, 8192).await?;
    let filename = crate::input_js_string(body.get("filename"), 4096)?.clean_filename();
    let size = json_size(body.get("size"), app.config.room_max_file)?;
    let mime = session_mime(body.get("mime"))?;
    let created_at = now();
    let mut upload = db::NewUpload {
        id: uuid::Uuid::new_v4().to_string(),
        space_id: room.id.clone(),
        user_id: None,
        principal: room_principal(&context, &room.id),
        filename,
        mime,
        size,
        chunk_size: app.config.upload_chunk_bytes,
        created_at,
        expires_at: created_at.saturating_add(86_400_000),
        quota: app.config.room_quota,
        max_items: app.config.max_items.min(100),
        sessions_per_user: app.config.upload_sessions_per_user,
        sessions_global: app.config.upload_sessions_global,
    };
    let response_id = upload.id.clone();
    app.db
        .run(move |db| db::create_upload_for_room(db, &mut upload))
        .await?;
    let created = app
        .db
        .run(move |db| db::upload_session(db, &response_id, now()))
        .await?
        .ok_or(ApiError::NOT_FOUND)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "uploadId": created.id,
            "chunkSize": created.chunk_size,
            "expiresAt": created.expires_at,
            "received": [],
        })),
    ))
}

pub async fn get_room_upload(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String)>, PathRejection>,
) -> ApiResult<Json<serde_json::Value>> {
    let UrlPath((token, upload_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let room = crate::rooms::scope(&app, &context, &token).await?;
    let (upload, chunks) = app
        .db
        .run(move |db| {
            let upload = room_upload(db, &room.id, &upload_id)?;
            let chunks = db::upload_chunks(db, &upload_id)?;
            Ok((upload, chunks))
        })
        .await?;
    Ok(Json(json!({
        "size": upload.size,
        "chunkSize": upload.chunk_size,
        "expiresAt": upload.expires_at,
        "received": chunks.into_iter().map(|chunk| chunk.index).collect::<Vec<_>>(),
    })))
}

pub async fn put_room_chunk(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String, String)>, PathRejection>,
    request: Request,
) -> ApiResult<StatusCode> {
    let UrlPath((token, upload_id, raw_index)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    // Chunk PUT skips room-access and room-write. The capability is still required.
    let room = crate::rooms::load_room(&app, &token).await?;
    let space_id = room.id.clone();
    let id = upload_id.clone();
    app.db
        .run(move |db| room_upload(db, &space_id, &id))
        .await?;
    let checksum = header_value(request.headers(), "x-chunk-sha256").map(str::to_owned);
    if let Some(checksum) = &checksum
        && (checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(ApiError::new(400, "INVALID_CHECKSUM"));
    }
    let principal = room_principal(&context, &room.id);
    let permit = acquire_chunk(&app, &upload_id, &principal)?;
    let directory = downloads::files_dir(&app.config.data);
    let timeout_ms = app.config.upload_chunk_timeout_ms as u64;
    let index = chunk_index(&raw_index)?;
    let space_id = room.id.clone();
    let id = upload_id.clone();
    let expected = app
        .db
        .run(move |db| {
            let upload = room_upload(db, &space_id, &id)?;
            chunk_expected(&upload, index)
        })
        .await?;
    let stored = match timeout(
        Duration::from_millis(timeout_ms),
        write_limited(&directory, request.into_body(), expected, &permit.notify),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => return Err(ApiError::new(400, "UPLOAD_TIMEOUT")),
    };
    if stored.size != expected {
        return Err(ApiError::new(400, "CHUNK_SIZE_MISMATCH"));
    }
    if let Some(checksum) = checksum
        && !stored.sha256.eq_ignore_ascii_case(&checksum)
    {
        return Err(ApiError::new(400, "CHECKSUM_MISMATCH"));
    }
    let space_id = room.id.clone();
    let id = upload_id.clone();
    let key = stored.key.clone();
    let sha = stored.sha256.clone();
    let committed = app
        .db
        .run(move |db| {
            room_upload(db, &space_id, &id)?;
            db::save_chunk(db, &id, index, &key, expected as i64, &sha, now())
        })
        .await?;
    if committed {
        forget_staged(stored.staged);
    } else {
        drop(stored);
        let _ = flush_garbage(&app, &directory).await;
    }
    drop(permit);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn complete_room(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String)>, PathRejection>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    let UrlPath((token, upload_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let room = crate::rooms::scope(&app, &context, &token).await?;
    room_write_limit(&app, &context)?;
    let space_id = room.id.clone();
    let id = upload_id.clone();
    let upload = app
        .db
        .run(move |db| room_upload(db, &space_id, &id))
        .await?;
    let headers = request.headers().clone();
    let group = decoded_group(header_value(&headers, "x-dropit-group"))?;
    let device = parse_device(&headers);
    // 409 UPLOAD_IN_PROGRESS returns before the slot and before session deletion.
    let complete_notify = begin_complete(&app, &upload_id)?;
    // Same four-slot cap as legacy POST. A full pool returns 429 UPLOAD_BUSY
    // without incrementing. The slot drops on every later exit, including quota
    // failure and cancel, so a held complete cannot leak a permit.
    let slot = match acquire(&app, false, UPLOAD_SLOTS, "UPLOAD_BUSY") {
        Ok(slot) => slot,
        Err(error) => {
            let id = upload_id.clone();
            let _ = app.db.run(move |db| db::delete_upload(db, &id)).await;
            end_complete(&app, &upload_id);
            let directory = downloads::files_dir(&app.config.data);
            let _ = flush_garbage(&app, &directory).await;
            return Err(error);
        }
    };
    let result =
        finish_room_complete(&app, &room.id, &upload, group, device, &complete_notify).await;
    let directory = downloads::files_dir(&app.config.data);
    // Release the in-progress mark before deleting a failed session. A racing
    // complete then observes UPLOAD_IN_PROGRESS while the session still exists,
    // matching the TypeScript 409, and does not delete that session.
    end_complete(&app, &upload_id);
    if result.is_err() {
        let id = upload_id.clone();
        let _ = app.db.run(move |db| db::delete_upload(db, &id)).await;
    }
    let (item, _groups, _channel) = result?;
    // Publish already happened inside the commit gate. Flush garbage only after
    // that gate is released so file removal cannot sit ahead of item.created.
    drop(slot);
    let _ = flush_garbage(&app, &directory).await;
    Ok((StatusCode::CREATED, Json(json!({ "item": item }))))
}

pub async fn cancel_room_upload(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<UrlPath<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    let UrlPath((token, upload_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let room = crate::rooms::scope(&app, &context, &token).await?;
    let space_id = room.id.clone();
    let id = upload_id.clone();
    app.db
        .run(move |db| {
            room_upload(db, &space_id, &id)?;
            Ok(())
        })
        .await?;
    let id = upload_id.clone();
    app.db.run(move |db| db::delete_upload(db, &id)).await?;
    abort_session(&app, &upload_id).await;
    let directory = downloads::files_dir(&app.config.data);
    flush_garbage(&app, &directory).await;
    Ok(StatusCode::NO_CONTENT)
}

fn begin_complete(app: &App, upload_id: &str) -> ApiResult<Arc<Notify>> {
    let mut state = app.chunk_work.inner.lock().map_err(ApiError::internal)?;
    if state.completing.contains_key(upload_id) || state.sessions.contains_key(upload_id) {
        return Err(ApiError::new(409, "UPLOAD_IN_PROGRESS"));
    }
    let notify = Arc::new(Notify::new());
    state
        .completing
        .insert(upload_id.to_owned(), Arc::clone(&notify));
    Ok(notify)
}

fn end_complete(app: &App, upload_id: &str) {
    if let Ok(mut state) = app.chunk_work.inner.lock()
        && let Some(notify) = state.completing.remove(upload_id)
    {
        notify.notify_waiters();
    }
}

async fn abort_session(app: &App, upload_id: &str) {
    let (chunk_notify, complete_notify) = {
        let Ok(state) = app.chunk_work.inner.lock() else {
            return;
        };
        (
            state.cancelled.get(upload_id).cloned().unwrap_or_default(),
            state.completing.get(upload_id).cloned(),
        )
    };
    for notify in &chunk_notify {
        notify.notify_waiters();
    }
    if let Some(notify) = &complete_notify {
        notify.notify_waiters();
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let pending = app
            .chunk_work
            .inner
            .lock()
            .map(|state| {
                state.sessions.contains_key(upload_id) || state.completing.contains_key(upload_id)
            })
            .unwrap_or(false);
        if !pending || tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Stop in-process writers for sessions that maintenance or account disable already removed.
pub async fn abort_sessions(app: &App, ids: &[String]) {
    for id in ids {
        abort_session(app, id).await;
    }
    let directory = downloads::files_dir(&app.config.data);
    flush_garbage(app, &directory).await;
}

fn authorized_upload(
    db: &rusqlite::Connection,
    space_id: &str,
    user_id: &str,
    upload_id: &str,
) -> ApiResult<db::UploadSession> {
    let upload = db::upload_session(db, upload_id, now())?.ok_or(ApiError::NOT_FOUND)?;
    if upload.space_id != space_id || upload.user_id.as_deref() != Some(user_id) {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(upload)
}

fn json_size(value: Option<&crate::js::Value>, max_file: i64) -> ApiResult<i64> {
    let number = value
        .and_then(crate::js::Value::as_f64)
        .ok_or(ApiError::INVALID_INPUT)?;
    if number.fract() != 0.0 || !(1.0..(1_u64 << 53) as f64).contains(&number) {
        return Err(ApiError::INVALID_INPUT);
    }
    let size = number as i64;
    if size > max_file {
        return Err(ApiError::new(413, "FILE_TOO_LARGE"));
    }
    Ok(size)
}

fn session_mime(value: Option<&crate::js::Value>) -> ApiResult<String> {
    let raw = crate::input_string(value, 200)?;
    let mime = raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if mime.is_empty() {
        return Err(ApiError::INVALID_INPUT);
    }
    Ok(mime)
}

fn was_cancelled(cancel: &Notify) -> bool {
    cancel.notified().now_or_never().is_some()
}

fn div_ceil(value: i64, divisor: i64) -> i64 {
    value.saturating_add(divisor - 1) / divisor
}

fn chunk_index(raw: &str) -> ApiResult<i64> {
    if !valid_chunk_index(raw) {
        return Err(ApiError::new(400, "INVALID_CHUNK_INDEX"));
    }
    raw.parse::<i64>()
        .map_err(|_| ApiError::new(400, "INVALID_CHUNK_INDEX"))
}

fn chunk_expected(upload: &db::UploadSession, index: i64) -> ApiResult<u64> {
    if index < 0 || index >= div_ceil(upload.size, upload.chunk_size) {
        return Err(ApiError::new(400, "INVALID_CHUNK_INDEX"));
    }
    Ok(upload
        .chunk_size
        .min(upload.size - index * upload.chunk_size) as u64)
}

fn valid_chunk_index(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.is_empty() || bytes.iter().any(|byte| !byte.is_ascii_digit()) {
        return false;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return false;
    }
    // Number.isSafeInteger rejects values at or above 2^53.
    let digits = raw.trim_start_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    if digits.len() > 16 {
        return false;
    }
    let value: u64 = digits.parse().unwrap_or(u64::MAX);
    value < (1_u64 << 53)
}

fn sniff_raster(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes[..8] == [137, 80, 78, 71, 13, 10, 26, 10] {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some("image/jpeg");
    }
    if bytes.len() >= 6 && (bytes[..6] == *b"GIF87a" || bytes[..6] == *b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (bytes[8..12] == *b"avif" || bytes[8..12] == *b"avis")
    {
        return Some("image/avif");
    }
    None
}

fn svg_prefix(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut index = 0;
    while let Some(found) = text[index..].find("<svg") {
        let after = index + found + 4;
        if bytes
            .get(after)
            .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
        {
            return true;
        }
        index = after;
    }
    false
}

async fn read_prefix(path: &Path, length: usize) -> ApiResult<Vec<u8>> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(ApiError::internal)?;
    let mut buffer = vec![0; length];
    let read = tokio::io::AsyncReadExt::read(&mut file, &mut buffer)
        .await
        .map_err(ApiError::internal)?;
    buffer.truncate(read);
    Ok(buffer)
}

async fn write_limited(
    directory: &Path,
    body: Body,
    limit: u64,
    cancel: &Notify,
) -> ApiResult<Stored> {
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
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.notified() => return Err(ApiError::NOT_FOUND),
            frame = body.frame() => frame,
        };
        let Some(frame) = next else { break };
        let frame = frame.map_err(|_| ApiError::NOT_FOUND)?;
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

async fn assemble_chunks(
    directory: &Path,
    keys: &[String],
    expected: u64,
    cancel: &Notify,
) -> ApiResult<Stored> {
    let key = uuid::Uuid::new_v4().to_string();
    let path = downloads::object_path(directory, &key)?;
    let staged = Staged {
        path: path.clone(),
        keep: false,
    };
    let mut output = create_exclusive(directory, &path).await?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = vec![0; 64 * 1024];
    for source in keys {
        let source = downloads::object_path(directory, source)?;
        let mut input = tokio::fs::File::open(source)
            .await
            .map_err(|_| ApiError::new(400, "UPLOAD_INCOMPLETE"))?;
        loop {
            if was_cancelled(cancel) {
                return Err(ApiError::NOT_FOUND);
            }
            let read = tokio::io::AsyncReadExt::read(&mut input, &mut buffer)
                .await
                .map_err(ApiError::internal)?;
            if read == 0 {
                break;
            }
            size = size
                .checked_add(read as u64)
                .ok_or(ApiError::new(413, "FILE_TOO_LARGE"))?;
            if size > expected {
                return Err(ApiError::new(400, "UPLOAD_INCOMPLETE"));
            }
            hasher.update(&buffer[..read]);
            output
                .write_all(&buffer[..read])
                .await
                .map_err(ApiError::internal)?;
        }
    }
    if size != expected {
        return Err(ApiError::new(400, "UPLOAD_INCOMPLETE"));
    }
    output.sync_all().await.map_err(ApiError::internal)?;
    drop(output);
    Ok(Stored {
        key,
        size,
        sha256: hex_encode(hasher.finalize()),
        staged,
    })
}

async fn flush_garbage(app: &App, directory: &Path) {
    let Ok(keys) = app.db.run(|db| db::garbage_keys(db)).await else {
        return;
    };
    for key in keys {
        if remove_stored(directory, &key).await.is_ok() {
            let _ = app.db.run(move |db| db::forget_garbage(db, &key)).await;
        }
    }
}

/// Test and maintenance entry. Expired sessions become garbage, then unreferenced
/// files older than `older_than` are removed. Live chunk keys stay.
///
/// `DROPIT_SWEEP_ON_SPACES=1` runs this from GET /api/spaces so the HTTP harness
/// can prove expiry and garbage cleanup. It is not a public route.
pub async fn sweep_expired(app: &App, older_than: i64) -> ApiResult<()> {
    let time = now();
    let ids = app.db.run(move |db| db::expire_uploads(db, time)).await?;
    abort_sessions(app, &ids).await;
    let directory = downloads::files_dir(&app.config.data);
    let referenced = app.db.run(|db| db::referenced_file_keys(db)).await?;
    let referenced: std::collections::HashSet<String> = referenced.into_iter().collect();
    let entries = match tokio::fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(ApiError::internal(error)),
    };
    let mut entries = entries;
    while let Some(entry) = entries.next_entry().await.map_err(ApiError::internal)? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if referenced.contains(name) || downloads::object_path(&directory, name).is_err() {
            continue;
        }
        let modified = entry
            .metadata()
            .await
            .map_err(ApiError::internal)?
            .modified()
            .map_err(ApiError::internal)?;
        let millis = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        if millis < older_than {
            remove_stored(&directory, name).await?;
        }
    }
    Ok(())
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

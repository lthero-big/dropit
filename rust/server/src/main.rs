mod admin;
mod auth;
mod browser;
mod config;
mod db;
mod downloads;
mod images;
mod items;
mod js;
mod machine;
mod maintenance;
mod migrations;
mod password;
mod realtime;
mod rooms;
mod sharing;
mod spaces;
mod update;
mod uploads;

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, atomic::AtomicU32},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::to_bytes,
    extract::{ConnectInfo, Extension, Path, Query, Request, State, rejection::PathRejection},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post, put},
};
use percent_encoding::percent_decode_str;
use rusqlite::{TransactionBehavior, params};
use serde_json::{Map, Value, json};
use tokio::sync::{Semaphore, watch};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use browser::BuildInfo;
use config::{Config, StartupResult, parse_origin};
use db::{Account, Database, Device, TextInput};
use realtime::Realtime;

type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
pub(crate) struct ApiError {
    status: u16,
    code: &'static str,
    details: Option<Box<Map<String, Value>>>,
    pub(crate) header: Option<(header::HeaderName, HeaderValue)>,
}

impl ApiError {
    const NOT_FOUND: Self = Self::new(404, "NOT_FOUND");
    const UNAUTHENTICATED: Self = Self::new(401, "UNAUTHENTICATED");
    const INVALID_INPUT: Self = Self::new(400, "INVALID_INPUT");

    const fn new(status: u16, code: &'static str) -> Self {
        Self {
            status,
            code,
            details: None,
            header: None,
        }
    }

    fn internal(_: impl std::fmt::Debug) -> Self {
        eprintln!("Backend operation failed");
        Self::new(500, "INTERNAL_ERROR")
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(mut self) -> Response {
        let mut details = self.details.take().unwrap_or_default();
        details.insert("code".into(), self.code.into());
        let mut response = (
            StatusCode::from_u16(self.status).unwrap(),
            Json(json!({ "error": details })),
        )
            .into_response();
        if let Some((name, value)) = self.header {
            response.headers_mut().insert(name, value);
        }
        // TS adds Retry-After: 1 to every 429 that did not set one.
        if self.status == 429 && !response.headers().contains_key(header::RETRY_AFTER) {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        }
        response
    }
}

struct StateData {
    config: Arc<Config>,
    db: Database,
    build: BuildInfo,
    update: update::UpdateService,
    realtime: Realtime,
    limiter: Mutex<HashMap<(&'static str, String), Bucket>>,
    password_slots: Arc<Semaphore>,
    upload_slots: AtomicU32,
    preview_slots: AtomicU32,
    app_tickets: Mutex<HashMap<String, AppTicket>>,
    chunk_work: uploads::ChunkWork,
    pin_lockouts: Mutex<HashMap<String, (u32, i64, i64)>>,
    setup_code: Mutex<Option<String>>,
}

pub(crate) type App = Arc<StateData>;

struct Bucket {
    count: u32,
    reset: i64,
}

struct AppTicket {
    user_id: String,
    token_id: String,
    expires_at: i64,
}

impl StateData {
    fn limit(&self, group: &'static str, key: &str, limit: u32) -> ApiResult<()> {
        let time = now();
        let mut buckets = self.limiter.lock().map_err(ApiError::internal)?;
        buckets.retain(|_, bucket| bucket.reset > time);
        let key = (group, key.to_owned());
        let reset = time + self.config.rate_window;
        let retry_at = if buckets.len() >= 10000 && !buckets.contains_key(&key) {
            Some(reset)
        } else {
            let bucket = buckets.entry(key).or_insert(Bucket { count: 0, reset });
            bucket.count = bucket.count.saturating_add(1);
            (bucket.count > limit).then_some(bucket.reset)
        };
        if let Some(retry_at) = retry_at {
            let mut error = ApiError::new(429, "RATE_LIMITED");
            error.header = Some((
                header::RETRY_AFTER,
                HeaderValue::from(((retry_at - time + 999) / 1000).max(1)),
            ));
            return Err(error);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct Auth {
    account: Arc<Account>,
    session_hash: String,
    bearer: Option<machine::Bearer>,
}

#[derive(Clone)]
pub(crate) struct RequestContext {
    ip: String,
    ip_summary: String,
    secure_cookie: bool,
    request_origin: Option<String>,
    received_origin: Option<String>,
    auth: Option<Auth>,
}

impl RequestContext {
    pub(crate) fn require_auth(&self) -> ApiResult<&Auth> {
        self.auth.as_ref().ok_or(ApiError::UNAUTHENTICATED)
    }
}

#[tokio::main]
async fn main() -> StartupResult<()> {
    if std::env::args_os().next().is_some_and(|arg| {
        std::path::Path::new(&arg)
            .file_name()
            .is_some_and(|name| name == "dropit-admin")
    }) {
        std::process::exit(admin::run(std::env::args().skip(1).collect())?);
    }
    let mut config = Config::load()?;
    let db = Database::open(&mut config)?;
    let mut user_count = db
        .run(|db| Ok(db::user_count(&*db)?))
        .await
        .map_err(|error| format!("database startup check failed: {error:?}"))?;
    if user_count == 0
        && let (Ok(email), Ok(raw_password)) = (
            std::env::var("ADMIN_EMAIL"),
            std::env::var("ADMIN_PASSWORD"),
        )
        && !email.trim().is_empty()
        && !raw_password.is_empty()
    {
        let email = email.trim().to_lowercase();
        let email_for_log = email.clone();
        let password_hash = password::hash_password(&raw_password)
            .map_err(|error| format!("admin bootstrap failed: {error:?}"))?;
        db.run(move |db| auth::bootstrap_admin(db, &email, &password_hash, now()))
            .await
            .map_err(|error| format!("admin bootstrap failed: {error:?}"))?;
        user_count = db
            .run(|db| Ok(db::user_count(&*db)?))
            .await
            .map_err(|error| format!("database startup check failed: {error:?}"))?;
        eprintln!(
            "dropit: created the first admin {email_for_log} from ADMIN_EMAIL / ADMIN_PASSWORD"
        );
    }
    let setup_code = if user_count == 0 {
        let code = auth::setup_code()
            .map_err(|error| format!("setup code generation failed: {error:?}"))?;
        eprintln!("dropit setup code: {code}");
        Some(code)
    } else {
        None
    };
    let build = browser::build_info();
    let update = update::UpdateService::new(build.clone(), &config.data)
        .map_err(|error| format!("update checker configuration failed: {error}"))?;
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    let app = Arc::new(StateData {
        db,
        build,
        update,
        realtime: Realtime::new(),
        config: Arc::new(config),
        limiter: Mutex::new(HashMap::new()),
        password_slots: Arc::new(Semaphore::new(4)),
        upload_slots: AtomicU32::new(0),
        preview_slots: AtomicU32::new(0),
        app_tickets: Mutex::new(HashMap::new()),
        chunk_work: uploads::ChunkWork::default(),
        pin_lockouts: Mutex::new(HashMap::new()),
        setup_code: Mutex::new(setup_code),
    });
    let routes = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/auth/password/login", post(login))
        .route("/api/auth/password/register", post(auth::register))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/{provider}", get(auth::oauth_start))
        .route("/api/auth/{provider}/callback", get(auth::oauth_callback))
        .route("/api/auth/device/authorize", post(device_authorize))
        .route("/api/auth/device/token", post(device_token))
        .route("/api/auth/device", get(device_info))
        .route("/api/auth/device/approve", post(device_approve))
        .route("/api/auth/device/deny", post(device_deny))
        .route("/api/app-session/ticket", post(app_session_ticket))
        .route("/api/app-session", get(app_session))
        .route("/api/invites/{token}", get(spaces::invite_info))
        .route("/api/invites/{token}/accept", post(spaces::accept_invite))
        .route(
            "/api/spaces/{space}/invites",
            get(spaces::list_invites).post(spaces::create_invite),
        )
        .route(
            "/api/spaces/{space}/invites/{id}",
            delete(spaces::revoke_invite),
        )
        .route("/api/spaces/{space}/members", get(spaces::members))
        .route(
            "/api/spaces/{space}/members/{userId}",
            patch(spaces::set_member_role).delete(spaces::remove_member),
        )
        .route("/api/spaces/{space}/membership", delete(spaces::leave))
        .route("/api/rooms", post(rooms::create))
        .route("/api/rooms/enter", post(rooms::enter))
        .route("/api/rooms/{room}/code", put(rooms::change_code))
        .route("/api/rooms/{room}", get(rooms::info))
        .route("/api/rooms/{room}/items", get(rooms::items))
        .route("/api/rooms/{room}/items/text", post(rooms::text))
        .route("/api/rooms/{room}/items/file", post(uploads::upload_room))
        .route(
            "/api/rooms/{room}/uploads",
            post(uploads::create_room_upload),
        )
        .route(
            "/api/rooms/{room}/uploads/{id}",
            get(uploads::get_room_upload).delete(uploads::cancel_room_upload),
        )
        .route(
            "/api/rooms/{room}/uploads/{id}/chunks/{index}",
            put(uploads::put_room_chunk),
        )
        .route(
            "/api/rooms/{room}/uploads/{id}/complete",
            post(uploads::complete_room),
        )
        .route(
            "/api/rooms/{room}/items/{id}",
            delete(rooms::delete_item).patch(items::edit),
        )
        .route("/api/rooms/{room}/items/{id}/labels", patch(items::labels))
        .route(
            "/api/rooms/{room}/groups",
            get(items::groups).post(items::create_group),
        )
        .route(
            "/api/rooms/{room}/groups/{name}",
            patch(items::rename_group).delete(items::delete_group),
        )
        .route(
            "/api/rooms/{room}/items/{id}/download",
            get(rooms::download).head(rooms::download),
        )
        .route(
            "/api/rooms/{room}/items/{id}/thumbnail",
            get(rooms::thumbnail).head(rooms::thumbnail),
        )
        .route("/api/rooms/{room}/items/{id}/preview", get(rooms::preview))
        .route(
            "/api/rooms/{room}/items/{id}/media",
            get(rooms::media).head(rooms::media),
        )
        .route("/api/rooms/{room}/ws", get(realtime::room_websocket))
        .route("/api/admin/rooms", get(rooms::admin_rooms))
        .route("/api/admin/rooms/{id}/unlock", post(rooms::admin_unlock))
        .route("/api/admin/rooms/{id}/close", post(rooms::admin_close))
        .route("/api/admin/rooms/{id}/reopen", post(rooms::admin_reopen))
        .route("/api/admin/rooms/{id}", delete(rooms::admin_delete))
        .route(
            "/api/spaces/{space}/items/{id}/shares",
            get(sharing::list_private).post(sharing::create_private),
        )
        .route(
            "/api/spaces/{space}/shares/{shareId}",
            delete(sharing::revoke_private),
        )
        .route(
            "/api/rooms/{room}/items/{id}/shares",
            get(sharing::list_room).post(sharing::create_room),
        )
        .route(
            "/api/rooms/{room}/shares/{shareId}",
            delete(sharing::revoke_room),
        )
        .route(
            "/api/me/share-presets",
            get(sharing::share_presets).put(sharing::save_share_presets),
        )
        .route("/api/shares", get(sharing::managed_shares))
        .route("/api/shares/{shareId}/link", get(sharing::managed_link))
        .route(
            "/api/shares/{shareId}/revoke",
            post(sharing::managed_revoke),
        )
        .route("/api/shares/{shareId}", delete(sharing::managed_delete))
        .route("/api/s/{token}", get(sharing::open_public))
        .route(
            "/api/s/{token}/file",
            get(sharing::file).head(sharing::file),
        )
        .route("/api/s/{token}/thumbnail", get(sharing::thumbnail))
        .route("/api/s/{token}/preview", get(sharing::preview))
        .route(
            "/api/s/{token}/media",
            get(sharing::media).head(sharing::media),
        )
        .route("/d/{token}", get(sharing::file).head(sharing::file))
        .route("/api/tokens", get(tokens).post(create_token))
        .route("/api/tokens/{id}", patch(rename_token).delete(delete_token))
        .route("/api/admin/tokens", get(admin_tokens))
        .route("/api/admin/tokens/{id}", delete(admin_delete_token))
        .route("/api/auth/providers", get(browser::auth_providers))
        .route("/api/site", get(browser::site))
        .route("/api/version", get(browser::version))
        .route("/api/app/android/latest", get(update::android_latest))
        .route(
            "/api/app/android/download/{file}",
            get(update::android_download),
        )
        .route("/api/admin/update", get(update::admin_report))
        .route("/api/admin/update/check", post(update::admin_check))
        .route("/api/setup", get(browser::setup))
        .route("/api/setup", post(auth::setup))
        .route("/api/me/password", put(auth::change_password))
        .route("/api/me/identities", get(auth::identities))
        .route(
            "/api/me/identities/{provider}",
            delete(auth::unlink_identity),
        )
        .route("/api/admin/oauth", get(auth::admin_oauth))
        .route(
            "/api/admin/oauth/{provider}",
            put(auth::save_oauth).delete(auth::delete_oauth),
        )
        .route(
            "/api/admin/oauth/{provider}/verify",
            post(auth::verify_oauth),
        )
        .route("/api/sessions", get(auth::sessions))
        .route("/api/sessions/{id}", delete(auth::revoke_session))
        .route(
            "/api/sessions/revoke-others",
            post(auth::revoke_other_sessions),
        )
        .route(
            "/api/admin/users",
            get(auth::admin_users).post(auth::create_user),
        )
        .route("/api/admin/users/{id}", patch(auth::update_user))
        .route("/api/admin/users/{id}/password", post(auth::reset_password))
        .route("/api/admin/users/{id}/logout", post(auth::logout_user))
        .route(
            "/api/admin/users/{id}/sessions",
            get(auth::admin_user_sessions),
        )
        .route(
            "/api/admin/sessions/{id}",
            delete(auth::admin_revoke_session),
        )
        .route(
            "/api/admin/registration",
            get(auth::registration).put(auth::save_registration),
        )
        .route(
            "/api/admin/invites",
            get(auth::admin_invites).post(auth::create_admin_invite),
        )
        .route("/api/admin/invites/{id}", delete(auth::revoke_admin_invite))
        .route(
            "/api/me/invites",
            get(auth::my_invites).post(auth::create_personal_invite),
        )
        .route("/api/me/invites/{id}", delete(auth::revoke_personal_invite))
        .route("/api/me", get(me))
        .route("/api/spaces", get(spaces))
        .route("/api/spaces/{space}", get(space))
        .route("/api/spaces/{space}/items", get(items))
        .route("/api/spaces/{space}/items/text", post(text))
        .route("/api/spaces/{space}/items/file", post(uploads::upload_file))
        .route("/api/spaces/{space}/uploads", post(uploads::create_upload))
        .route(
            "/api/spaces/{space}/uploads/{id}",
            get(uploads::get_upload).delete(uploads::cancel_upload),
        )
        .route(
            "/api/spaces/{space}/uploads/{id}/chunks/{index}",
            put(uploads::put_chunk),
        )
        .route(
            "/api/spaces/{space}/uploads/{id}/complete",
            post(uploads::complete_upload),
        )
        .route(
            "/api/spaces/{space}/items/{id}",
            delete(uploads::retract).patch(items::edit),
        )
        .route(
            "/api/spaces/{space}/items/{id}/labels",
            patch(items::labels),
        )
        .route(
            "/api/spaces/{space}/groups",
            get(items::groups).post(items::create_group),
        )
        .route(
            "/api/spaces/{space}/groups/{name}",
            patch(items::rename_group).delete(items::delete_group),
        )
        .route(
            "/api/spaces/{space}/items/{id}/preview",
            get(uploads::preview),
        )
        .route("/api/spaces/{space}/ws", get(realtime::websocket))
        .route(
            "/api/spaces/{space}/items/{id}/download",
            get(download).head(download),
        )
        .route(
            "/api/spaces/{space}/items/{id}/thumbnail",
            get(thumbnail).head(thumbnail),
        )
        .route(
            "/api/spaces/{space}/items/{id}/media",
            get(media).head(media),
        )
        .fallback(static_or_not_found)
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn_with_state(app.clone(), request_context))
        .with_state(app.clone());
    println!("dropit listening on port {}", listener.local_addr()?.port());
    let (shutdown, shutdown_rx) = watch::channel(false);
    let update_task = tokio::spawn(update::run_loop(app.clone(), shutdown.subscribe()));
    let maintenance_app = app.clone();
    let maintenance_task = tokio::spawn(maintenance::run_loop(maintenance_app, shutdown_rx));
    let server_result = axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(app.clone()))
    .await;
    let _ = shutdown.send(true);
    let _ = maintenance_task.await;
    let _ = update_task.await;
    if let Err(error) = maintenance::run_once(&app).await {
        eprintln!("dropit: final maintenance failed; durable garbage will retry on restart");
        let _ = error;
    }
    server_result?;
    Ok(())
}

async fn healthz(State(app): State<App>) -> ApiResult<Json<Value>> {
    app.db
        .run(|db| {
            db.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn shutdown_signal(app: App) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    {
        let terminate = async {
            if let Ok(mut signal) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                signal.recv().await;
            }
        };
        tokio::select! {
            _ = ctrl_c => app.realtime.close_all(),
            _ = terminate => app.realtime.close_all(),
        }
    }
    #[cfg(not(unix))]
    {
        ctrl_c.await;
        app.realtime.close_all();
    }
}

async fn not_found() -> ApiError {
    ApiError::NOT_FOUND
}

async fn static_or_not_found(State(app): State<App>, request: Request) -> Response {
    if request.uri().path().starts_with("/api/") || request.uri().path().starts_with("/d/") {
        return ApiError::NOT_FOUND.into_response();
    }
    if !matches!(request.method(), &Method::GET | &Method::HEAD) {
        return ApiError::NOT_FOUND.into_response();
    }

    let requested = percent_decode_str(request.uri().path().trim_start_matches('/'))
        .decode_utf8()
        .ok();
    let Some(requested) = requested else {
        return ApiError::NOT_FOUND.into_response();
    };
    if requested.contains(['\0', '\\']) || requested.split('/').any(|component| component == "..") {
        return ApiError::NOT_FOUND.into_response();
    }

    let requested = if requested.is_empty() {
        "index.html"
    } else {
        requested.as_ref()
    };
    let candidate = app.config.static_dir.join(requested);
    let (bytes, content_path) = match tokio::fs::read(&candidate).await {
        Ok(bytes) => (bytes, candidate),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !requested.contains('.') => {
            let index = app.config.static_dir.join("index.html");
            match tokio::fs::read(&index).await {
                Ok(bytes) => (bytes, index),
                Err(_) => return ApiError::NOT_FOUND.into_response(),
            }
        }
        Err(_) => return ApiError::NOT_FOUND.into_response(),
    };
    let content_type = match content_path.extension().and_then(|value| value.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    };
    let body = if request.method() == Method::HEAD {
        axum::body::Body::empty()
    } else {
        axum::body::Body::from(bytes)
    };
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

async fn request_context(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    let short_download = request.uri().path().starts_with("/d/");
    let is_api = request.uri().path().starts_with("/api/") || short_download;
    let own = request_origin(&app.config, &request, peer.ip());
    let origin = app
        .config
        .origin
        .as_ref()
        .map(|(origin, _)| origin.as_str())
        .or(own.as_deref());
    let secure = app.config.production && origin.is_some_and(|origin| origin.starts_with("https:"));
    let mut response = if short_download {
        let (mut parts, body) = request.into_parts();
        let ip = client_ip(&app.config, &parts.headers, peer.ip()).to_canonical();
        match app.limit("general:ip", &ip.to_string(), app.config.rate_general) {
            Err(error) => error.into_response(),
            Ok(()) => {
                parts.extensions.insert(RequestContext {
                    ip: ip.to_string(),
                    ip_summary: summarize_ip(ip),
                    secure_cookie: secure,
                    request_origin: own.clone(),
                    received_origin: header_value(&parts.headers, "origin").map(str::to_owned),
                    auth: None,
                });
                next.run(Request::from_parts(parts, body)).await
            }
        }
    } else if is_api {
        let (mut parts, body) = request.into_parts();
        match api_context(&app, &parts, peer.ip(), own.as_deref(), secure).await {
            Ok(context) => {
                parts.extensions.insert(context);
                next.run(Request::from_parts(parts, body)).await
            }
            Err(error) => error.into_response(),
        }
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    // Hono sets no-store before the handler, then media overwrites it with private, no-store.
    // This layer runs after the handler, so an existing Cache-Control must win.
    if is_api && !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    if secure {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    ));
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=()",
        ),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

fn chunk_upload_path(path: &str) -> bool {
    let mut parts = path.split('/');
    parts.next() == Some("")
        && parts.next() == Some("api")
        && matches!(parts.next(), Some("spaces" | "rooms"))
        && parts.next().is_some_and(|part| !part.is_empty())
        && parts.next() == Some("uploads")
        && parts.next().is_some_and(|part| !part.is_empty())
        && parts.next() == Some("chunks")
        && parts.next().is_some_and(|part| !part.is_empty())
        && parts.next().is_none()
}

async fn api_context(
    app: &StateData,
    request: &axum::http::request::Parts,
    peer: IpAddr,
    own: Option<&str>,
    secure_cookie: bool,
) -> ApiResult<RequestContext> {
    let headers = &request.headers;
    let ip = client_ip(&app.config, headers, peer).to_canonical();
    let ip_summary = summarize_ip(ip);
    let ip = ip.to_string();
    // Chunk PUT uses only the chunk bucket. It must not consume general, token,
    // room-access, or room-write, matching the TypeScript middleware.
    let chunk_request = request.method == Method::PUT && chunk_upload_path(request.uri.path());
    if chunk_request {
        app.limit("chunk:ip", &ip, app.config.rate_chunk)?;
    } else {
        app.limit("general:ip", &ip, app.config.rate_general)?;
    }
    let raw_session = read_cookie(headers, cookie_name(secure_cookie));
    let auth = if let Some(authorization) = header_value(headers, "authorization") {
        let raw = authorization
            .split_once(' ')
            .filter(|(scheme, value)| scheme.eq_ignore_ascii_case("Bearer") && is_bearer(value))
            .map(|(_, value)| value);
        let Some(raw) = raw else {
            let mut error = ApiError::UNAUTHENTICATED;
            error.header = Some((header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer")));
            return Err(error);
        };
        let hash = password::hash(raw);
        let token_auth = app
            .db
            .run(move |db| machine::token_session(db, &hash, now(), true))
            .await?;
        let Some((account, bearer)) = token_auth else {
            let mut error = ApiError::UNAUTHENTICATED;
            error.header = Some((header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer")));
            return Err(error);
        };
        if chunk_request {
            app.limit("chunk-token", &bearer.id, app.config.rate_chunk)?;
        } else {
            app.limit("token", &bearer.id, app.config.rate_token)?;
        }
        Some(Auth {
            account: Arc::new(account),
            session_hash: String::new(),
            bearer: Some(bearer),
        })
    } else if let Some(token) = raw_session.clone() {
        let session_hash = password::hash(&token);
        let hash = session_hash.clone();
        let ip = ip_summary.clone();
        app.db
            .run(move |db| db::session(db, &hash, Some(&ip)))
            .await?
            .map(|account| Auth {
                account: Arc::new(account),
                session_hash,
                bearer: None,
            })
    } else {
        None
    };
    if let Some(auth) = &auth {
        if chunk_request {
            app.limit("chunk:user", &auth.account.user.id, app.config.rate_chunk)?;
        } else {
            app.limit(
                "general:user",
                &auth.account.user.id,
                app.config.rate_general,
            )?;
        }
    }

    let safe = matches!(request.method.as_str(), "GET" | "HEAD" | "OPTIONS");
    if let Some(auth) = &auth
        && let Some(bearer) = &auth.bearer
        && !bearer
            .scopes
            .iter()
            .any(|scope| scope == if safe { "read" } else { "write" })
    {
        return Err(ApiError::new(403, "INSUFFICIENT_SCOPE"));
    }
    let public_device = request.method == Method::POST
        && matches!(
            request.uri.path(),
            "/api/auth/device/authorize" | "/api/auth/device/token"
        )
        && raw_session.is_none()
        && header_value(headers, "origin")
            .is_none_or(|received| origin_matches(app, own, received));
    if !safe && auth.as_ref().is_none_or(|auth| auth.bearer.is_none()) && !public_device {
        let received = header_value(headers, "origin").unwrap_or_default();
        let (expected, source) = app
            .config
            .origin
            .as_ref()
            .map(|(origin, source)| (origin.as_str(), *source))
            .unwrap_or((own.unwrap_or_default(), "request"));
        let matches_origin = !received.is_empty()
            && (received == expected
                || (source == "request"
                    && expected
                        .strip_prefix("http://")
                        .is_some_and(|host| received == format!("https://{host}"))));
        if !matches_origin {
            let mut error = ApiError::new(403, "ORIGIN_REJECTED");
            error.details = Some(Box::new(Map::from_iter([
                ("expected".into(), expected.into()),
                ("received".into(), received.into()),
                ("source".into(), source.into()),
            ])));
            return Err(error);
        }
    }
    if auth
        .as_ref()
        .is_some_and(|auth| auth.bearer.is_none() && auth.account.must_change_password)
        && !matches!(
            request.uri.path(),
            "/api/me"
                | "/api/me/password"
                | "/api/auth/logout"
                | "/api/auth/providers"
                | "/api/site"
                | "/api/version"
                | "/api/setup"
                | "/api/app-session"
        )
    {
        return Err(ApiError::new(403, "PASSWORD_CHANGE_REQUIRED"));
    }
    Ok(RequestContext {
        ip,
        ip_summary,
        secure_cookie,
        request_origin: own.map(str::to_owned),
        received_origin: header_value(headers, "origin").map(str::to_owned),
        auth,
    })
}

fn is_bearer(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn origin_matches(app: &StateData, own: Option<&str>, received: &str) -> bool {
    let (expected, source) = app
        .config
        .origin
        .as_ref()
        .map(|(origin, source)| (origin.as_str(), *source))
        .unwrap_or((own.unwrap_or_default(), "request"));
    received == expected
        || (source == "request"
            && expected
                .strip_prefix("http://")
                .is_some_and(|host| received == format!("https://{host}")))
}

fn request_origin(config: &Config, request: &Request, peer: IpAddr) -> Option<String> {
    let first = |name| {
        header_value(request.headers(), name)
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let trusted = config.trusts(peer);
    let protocol = if trusted {
        first("x-forwarded-proto")
            .filter(|v| v.eq_ignore_ascii_case("http") || v.eq_ignore_ascii_case("https"))
    } else {
        None
    };
    let scheme = protocol.unwrap_or("http");
    let host = trusted
        .then(|| first("x-forwarded-host"))
        .flatten()
        .or_else(|| header_value(request.headers(), "host"))
        .or_else(|| {
            request
                .uri()
                .authority()
                .map(|authority| authority.as_str())
        })?;
    parse_origin(&format!("{scheme}://{host}"))
}

fn client_ip(config: &Config, headers: &HeaderMap, peer: IpAddr) -> IpAddr {
    let mut ip = peer;
    if let Some(forwarded) = header_value(headers, "x-forwarded-for") {
        for address in forwarded
            .rsplit(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if !config.trusts(ip) {
                break;
            }
            let Ok(address) = address.parse() else { break };
            ip = address;
        }
    }
    ip
}

fn summarize_ip(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            format!("{a}.{b}.{c}.0/24")
        }
        IpAddr::V6(ip) => {
            let ip = ip.to_string();
            let prefix = ip
                .split(':')
                .filter(|segment| !segment.is_empty())
                .take(2)
                .collect::<Vec<_>>();
            format!("IPv6 {}:…", prefix.join(":"))
        }
    }
}

pub(crate) fn cookie_name(secure: bool) -> &'static str {
    if secure {
        "__Host-dropit_session"
    } else {
        "dropit_session"
    }
}

pub(crate) fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let value = header_value(headers, "cookie")?
        .split(';')
        .filter_map(|v| v.split_once('='))
        .find_map(|(key, value)| (key.trim() == name).then_some(value.trim()))?;
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value);
    decode_uri_component(value).filter(|value| !value.is_empty())
}

pub(crate) fn set_cookie(secure: bool, token: &str, max_age: i64) -> HeaderMap {
    let secure_attribute = if secure { "; Secure" } else { "" };
    let value = format!(
        "{}={token}; Max-Age={max_age}; Path=/; HttpOnly{secure_attribute}; SameSite=Lax",
        cookie_name(secure)
    );
    HeaderMap::from_iter([(header::SET_COOKIE, value.parse().unwrap())])
}

async fn login(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    app.limit("auth", &context.ip, app.config.rate_auth)?;
    let user_agent = header_value(request.headers(), "user-agent").map(|agent| {
        let truncated: Vec<_> = agent.encode_utf16().take(400).collect();
        String::from_utf16_lossy(&truncated)
    });
    let body = read_json(request, 4096).await?;
    let email = body
        .get("email")
        .and_then(crate::js::Value::as_str)
        .unwrap_or_default()
        .trim_matches(js_space)
        .to_lowercase();
    let password = input_js_string(body.get("password"), 256)?.utf8();
    if email.is_empty() || email.encode_utf16().count() > 200 {
        return Err(ApiError::INVALID_INPUT);
    }
    app.limit("auth:email", &password::hash(&email), app.config.rate_auth)?;
    let invite = match body.get("invite") {
        None | Some(crate::js::Value::Null) => None,
        Some(crate::js::Value::String(value)) if value.is_empty() => None,
        value => Some(password::hash(&input_js_string(value, 128)?.utf8())),
    };
    let email_to_find = email.clone();
    let account = app
        .db
        .run(move |db| db::password_account(db, &email_to_find))
        .await?;
    let stored = account
        .as_ref()
        .and_then(|account| account.password_hash.clone());
    let slot = app
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(ApiError::internal)?;
    let verified = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        password::verify(&password, stored.as_deref())
    })
    .await
    .map_err(ApiError::internal)??;
    let bad_credentials = || ApiError::new(401, "INVALID_CREDENTIALS");
    let account = account.filter(|_| verified).ok_or_else(bad_credentials)?;

    let token = password::session_token()?;
    let session_hash = password::hash(&token);
    let session_ms = app.config.session;
    let account = app.db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = db::password_account(&tx, &email)?
            .filter(|current| current.user.id == account.user.id && current.password_hash == account.password_hash)
            .ok_or_else(bad_credentials)?;
        if current.user.disabled != 0 {
            return Err(ApiError::new(403, "USER_DISABLED"));
        }
        let time = now();
        if let Some(invite) = invite {
            db::accept_invite(&tx, &invite, &current.user.id, time)?;
        }
        if current.user.pending != 0 {
            tx.execute("UPDATE users SET pending=0 WHERE id=?", [&current.user.id])?;
        }
        tx.execute("INSERT INTO sessions (sessionHash,userId,expiresAt,id,createdAt,lastSeenAt,userAgent,ipSummary)
            VALUES (?1,?2,?3,?4,?5,?5,?6,?7)",
            params![session_hash, current.user.id, time + session_ms, Uuid::new_v4().to_string(), time, user_agent, context.ip_summary])?;
        tx.commit()?;
        Ok(current)
    }).await?;

    let user = account.user;
    Ok((
        set_cookie(context.secure_cookie, &token, session_ms / 1000),
        Json(json!({
            "user": { "id": user.id, "email": user.email, "name": user.name, "role": user.role },
            "mustChangePassword": account.must_change_password,
        })),
    ))
}

async fn logout(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<impl IntoResponse> {
    let auth = context.require_auth()?.clone();
    if let Some(bearer) = auth.bearer {
        let id = bearer.id.clone();
        let revoke_id = id.clone();
        app.db
            .run(move |db| machine::revoke_token(db, &revoke_id, Some(&auth.account.user.id)))
            .await?;
        app.realtime.revoke_token(&id);
    } else {
        let hash = auth.session_hash;
        app.db
            .run(move |db| {
                db.execute("DELETE FROM sessions WHERE sessionHash=?", [hash])?;
                Ok(())
            })
            .await?;
    }
    Ok((
        StatusCode::NO_CONTENT,
        if context
            .auth
            .as_ref()
            .is_some_and(|auth| auth.bearer.is_some())
        {
            HeaderMap::new()
        } else {
            set_cookie(context.secure_cookie, "", 0)
        },
    ))
}

pub(crate) fn browser_session(context: &RequestContext) -> ApiResult<&Auth> {
    let auth = context.require_auth()?;
    if auth.bearer.is_some() {
        return Err(ApiError::new(403, "BROWSER_SESSION_REQUIRED"));
    }
    Ok(auth)
}

pub(crate) fn admin_session(context: &RequestContext) -> ApiResult<&Auth> {
    let auth = browser_session(context)?;
    if !machine::is_admin(&auth.account) {
        return Err(ApiError::new(403, "FORBIDDEN"));
    }
    Ok(auth)
}

async fn create_token(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    let auth = browser_session(&context)?;
    app.limit("token-create", &context.ip, app.config.rate_auth)?;
    let input = machine::token_options(&read_json(request, 2048).await?, false)?;
    let raw = machine::raw_token()?;
    let record = machine::AccessToken {
        id: Uuid::new_v4().to_string(),
        user_id: auth.account.user.id.clone(),
        name: input.name,
        scopes: input.scopes,
        created_at: now(),
        last_used_at: None,
        expires_at: input.lifetime_ms.map(|ms| now() + ms),
        revoked: 0,
    };
    app.db
        .run({
            let record = record.clone();
            let raw = raw.clone();
            move |db| machine::create_token(db, &record, &raw)
        })
        .await?;
    let mut body = machine::access_token_value(&record);
    body.as_object_mut()
        .expect("token response object")
        .insert("token".into(), raw.into());
    let mut body = js::to_value(&body)?;
    body.as_object_mut()
        .unwrap()
        .insert("name", js::Value::String(record.name));
    Ok((StatusCode::CREATED, Json(body)))
}

async fn tokens(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let user_id = context.require_auth()?.account.user.id.clone();
    let tokens = app
        .db
        .run(move |db| machine::list_tokens(db, Some(&user_id)))
        .await?;
    Ok(Json(json!({ "tokens": tokens })))
}

async fn rename_token(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    let auth = browser_session(&context)?;
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let body = read_json(request, 2048).await?;
    let name = machine::person_name(body.get("name"))?;
    let user_id = auth.account.user.id.clone();
    app.db
        .run(move |db| machine::rename_token(db, &id, &user_id, &name))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_token(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let auth = context.require_auth()?.clone();
    let user_id = auth.account.user.id.clone();
    if query.get("purge").is_some_and(|value| value == "1") {
        let browser = browser_session(&context)?;
        let owner = browser.account.user.id.clone();
        app.db
            .run(move |db| machine::delete_token(db, &id, &owner, now()))
            .await?;
    } else {
        let revoke_id = id.clone();
        app.db
            .run(move |db| machine::revoke_token(db, &revoke_id, Some(&user_id)))
            .await?;
        app.realtime.revoke_token(&id);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn admin_tokens(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    admin_session(&context)?;
    let user_id = query.get("userId").cloned();
    let tokens = app
        .db
        .run(move |db| machine::list_tokens(db, user_id.as_deref()))
        .await?;
    Ok(Json(json!({ "tokens": tokens })))
}

async fn admin_delete_token(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<impl IntoResponse> {
    admin_session(&context)?;
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let revoke_id = id.clone();
    app.db
        .run(move |db| machine::revoke_token(db, &revoke_id, None))
        .await?;
    app.realtime.revoke_token(&id);
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn origin_for(app: &StateData, context: &RequestContext) -> String {
    app.config
        .origin
        .as_ref()
        .map(|(origin, _)| origin.clone())
        .or_else(|| context.request_origin.clone())
        .unwrap_or_else(|| "http://127.0.0.1".into())
}

async fn device_authorize(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> ApiResult<Json<Value>> {
    app.limit("device-authorize", &context.ip, app.config.rate_auth)?;
    let input = machine::token_options(&read_json(request, 2048).await?, true)?;
    let device_code = machine::raw_token()?;
    let user_code = machine::user_code()?;
    let id = Uuid::new_v4().to_string();
    let time = now();
    let device = machine::DeviceAuthorization {
        id: id.clone(),
        device_code_hash: password::hash(&device_code),
        user_code_hash: machine::user_code_hash(&user_code),
        name: input.name,
        ip_summary: machine::ip_summary(&context.ip),
        scopes: input.scopes,
        token_lifetime_ms: input.lifetime_ms,
        expires_at: time + 600_000,
        interval: 5,
        next_poll_at: time + 5_000,
        attempts: 0,
        status: "pending".into(),
        user_id: None,
    };
    app.db
        .run(move |db| machine::create_device(db, &device))
        .await?;
    let verification_uri = format!("{}/device", origin_for(&app, &context));
    let complete = format!("{verification_uri}?user_code={user_code}&verification_id={id}");
    Ok(Json(json!({
        "device_code": device_code,
        "user_code": user_code,
        "verification_uri": verification_uri,
        "verification_id": id,
        "verification_uri_complete": complete,
        "expires_in": 600,
        "interval": 5,
    })))
}

async fn device_token(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    app.limit("device-poll", &context.ip, app.config.rate_general)?;
    let body = read_json(request, 2048).await?;
    let device_code = body
        .get("device_code")
        .and_then(crate::js::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or(ApiError::INVALID_INPUT)?;
    let raw = machine::raw_token()?;
    let token_id = Uuid::new_v4().to_string();
    let time = now();
    let result = app
        .db
        .run({
            let hash = password::hash(device_code);
            let raw = raw.clone();
            let token_id = token_id.clone();
            move |db| machine::poll_device(db, &hash, time, &token_id, &raw)
        })
        .await?;
    match result {
        machine::PollResult::Error(body) => Ok((StatusCode::BAD_REQUEST, Json(body))),
        machine::PollResult::Token(record) => {
            let expires_in = record
                .expires_at
                .map(|expires_at| (expires_at - now()) / 1000);
            Ok((
                StatusCode::OK,
                Json(json!({
                    "access_token": raw,
                    "token_type": "Bearer",
                    "scope": record.scopes.join(" "),
                    "expires_in": expires_in,
                    "token": machine::access_token_value(&record),
                })),
            ))
        }
    }
}

async fn requested_device(
    app: &App,
    context: &RequestContext,
    user_code: Option<&str>,
    verification_id: Option<&str>,
) -> ApiResult<machine::DeviceAuthorization> {
    browser_session(context)?;
    app.limit("device-confirm", &context.ip, 5)?;
    let code = user_code
        .filter(|value| !value.is_empty())
        .ok_or(ApiError::INVALID_INPUT)?;
    if code.encode_utf16().count() > 32 {
        return Err(ApiError::INVALID_INPUT);
    }
    let hash = machine::user_code_hash(code);
    let verification_id = match verification_id {
        None => None,
        Some(value) if !value.is_empty() && value.len() <= 64 => Some(value.to_owned()),
        Some(_) => return Err(ApiError::INVALID_INPUT),
    };
    app.db
        .run(move |db| machine::device_for_user_code(db, &hash, verification_id.as_deref(), now()))
        .await?
        .ok_or(ApiError::NOT_FOUND)
}

async fn device_info(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let device = requested_device(
        &app,
        &context,
        query.get("user_code").map(String::as_str),
        query.get("verification_id").map(String::as_str),
    )
    .await?;
    Ok(Json(
        json!({ "name": device.name, "ipSummary": device.ip_summary, "scopes": device.scopes, "expiresAt": device.expires_at, "tokenExpiresInDays": device.token_lifetime_ms.map(|ms| ms as f64 / 86_400_000.0) }),
    ))
}

async fn decide_device(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
    approve: bool,
) -> ApiResult<impl IntoResponse> {
    let body = read_json(request, 2048).await?;
    let user_code = body.get("user_code").and_then(crate::js::Value::as_str);
    let verification_id = body
        .get("verification_id")
        .and_then(crate::js::Value::as_str);
    let device = requested_device(&app, &context, user_code, verification_id).await?;
    let user_id = browser_session(&context)?.account.user.id.clone();
    app.db
        .run(move |db| machine::decide_device(db, &device.id, &user_id, approve, now()))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn device_approve(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    decide_device(State(app), Extension(context), request, true).await
}

async fn device_deny(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    decide_device(State(app), Extension(context), request, false).await
}

async fn app_session_ticket(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let auth = context.require_auth()?;
    let bearer = auth
        .bearer
        .as_ref()
        .ok_or(ApiError::new(403, "BEARER_REQUIRED"))?;
    if !bearer.scopes.iter().any(|scope| scope == "web") {
        return Err(ApiError::new(403, "INSUFFICIENT_SCOPE"));
    }
    app.limit("app-session", &context.ip, app.config.rate_auth)?;
    let time = now();
    let mut tickets = app.app_tickets.lock().map_err(ApiError::internal)?;
    tickets.retain(|_, entry| entry.expires_at > time);
    if tickets.len() >= 10_000 {
        return Err(ApiError::new(429, "RATE_LIMITED"));
    }
    let raw = machine::raw_token()?;
    tickets.insert(
        password::hash(&raw),
        AppTicket {
            user_id: auth.account.user.id.clone(),
            token_id: bearer.id.clone(),
            expires_at: time + 60_000,
        },
    );
    Ok(Json(
        json!({ "ticket": raw, "path": format!("/api/app-session?ticket={raw}"), "expires_in": 60 }),
    ))
}

async fn app_session(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Query(query): Query<HashMap<String, String>>,
    request: Request,
) -> ApiResult<Response> {
    app.limit("auth", &context.ip, app.config.rate_auth)?;
    let raw = query.get("ticket").cloned().unwrap_or_default();
    let key = is_bearer(&raw).then(|| password::hash(&raw));
    let entry = if let Some(key) = key {
        app.app_tickets
            .lock()
            .map_err(ApiError::internal)?
            .remove(&key)
    } else {
        None
    };
    let live = if let Some(entry) = &entry {
        entry.expires_at > now()
            && app
                .db
                .run({
                    let user = entry.user_id.clone();
                    let id = entry.token_id.clone();
                    move |db| machine::token_live(db, &id, &user, now(), "web")
                })
                .await?
    } else {
        false
    };
    if !live {
        let mut response = StatusCode::FOUND.into_response();
        response.headers_mut().insert(
            header::LOCATION,
            HeaderValue::from_static("/login?error=APP_SESSION_EXPIRED"),
        );
        return Ok(response);
    }
    let mut response = StatusCode::FOUND.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, HeaderValue::from_static("/"));
    if context
        .auth
        .as_ref()
        .is_none_or(|auth| auth.bearer.is_some())
    {
        let entry = entry.expect("live ticket has entry");
        let raw_session = machine::raw_token()?;
        let hash = password::hash(&raw_session);
        let user_agent = header_value(request.headers(), "user-agent").map(str::to_owned);
        let ip_summary = context.ip_summary.clone();
        let expires = now() + app.config.session;
        let user_id = entry.user_id;
        app.db
            .run(move |db| {
                machine::create_browser_session(
                    db,
                    &user_id,
                    &hash,
                    expires,
                    now(),
                    user_agent.as_deref(),
                    &ip_summary,
                )
            })
            .await?;
        if let Some(value) = set_cookie(
            context.secure_cookie,
            &raw_session,
            app.config.session / 1000,
        )
        .get(header::SET_COOKIE)
        {
            response
                .headers_mut()
                .insert(header::SET_COOKIE, value.clone());
        }
    }
    Ok(response)
}

async fn me(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let account = context.require_auth()?.account.clone();
    let id = account.user.id.clone();
    let (used, reserved) = app.db.run(move |db| db::usage(db, &id, now())).await?;
    Ok(Json(json!({
        "user": account.user,
        "hasPassword": account.password_hash.as_ref().is_some_and(|hash| !hash.is_empty()),
        "mustChangePassword": account.must_change_password,
        "usedBytes": used, "reservedBytes": reserved,
        "quotaBytes": account.quota.unwrap_or(app.config.quota), "maxFileBytes": app.config.max_file,
        "maxTextBytes": app.config.max_text, "retentionMs": app.config.retention,
    })))
}

async fn spaces(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let id = context.require_auth()?.account.user.id.clone();
    // Test hook only. Production maintenance remains in RHEA-238.
    if std::env::var("DROPIT_SWEEP_ON_SPACES").ok().as_deref() == Some("1") {
        let older_than = std::env::var("DROPIT_SWEEP_OLDER_THAN")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(|| now().saturating_sub(3_600_000));
        let _ = uploads::sweep_expired(&app, older_than).await;
    }
    let spaces = app.db.run(move |db| db::spaces(db, &id)).await?;
    Ok(Json(json!({ "spaces": spaces })))
}

async fn space(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let account = context.require_auth()?.account.clone();
    let Path(space_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let quota = account.quota.unwrap_or(app.config.quota);
    let space = app
        .db
        .run(move |db| db::space(db, &space_id, &account.user.id, false))
        .await?;
    Ok(Json(json!({
        "id": space.id, "name": space.name, "expiresAt": space.expires_at, "maxFileBytes": app.config.max_file, "quotaBytes": quota,
    })))
}

async fn items(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Box<serde_json::value::RawValue>>> {
    let id = context.require_auth()?.account.user.id.clone();
    let Path(space_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let snapshot = app
        .db
        .run(move |db| {
            let tx = db.transaction()?;
            let space = db::space(&tx, &space_id, &id, false)?;
            db::snapshot(&tx, space)
        })
        .await?;
    Ok(Json(snapshot))
}

async fn text(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    request: Request,
) -> ApiResult<impl IntoResponse> {
    let auth = context.require_auth()?;
    let Path(space_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let id = auth.account.user.id.clone();
    let scope = space_id.clone();
    app.db
        .run(move |db| db::space(db, &scope, &id, true))
        .await?;
    app.limit("write:ip", &context.ip, app.config.rate_upload)?;
    app.limit("write:user", &auth.account.user.id, app.config.rate_upload)?;
    let headers = request.headers().clone();
    let body = read_json(request, app.config.max_text * 6 + 1024).await?;
    let text = body.text("text")?;
    let header_group = match header_value(&headers, "x-dropit-group").filter(|v| !v.is_empty()) {
        Some(raw) => Some(decode_uri_component(raw).ok_or(ApiError::new(400, "INVALID_GROUP"))?),
        None => None,
    };
    if text.is_blank() {
        return Err(ApiError::new(400, "EMPTY_TEXT"));
    }
    if text.len() > app.config.max_text {
        return Err(ApiError::new(413, "TEXT_TOO_LARGE"));
    }
    let group = match body.get("group") {
        None | Some(crate::js::Value::Null) => header_group.map(Into::into),
        value => Some(
            value
                .and_then(crate::js::Value::as_js_str)
                .ok_or(ApiError::new(400, "INVALID_GROUP"))?
                .clone(),
        ),
    };
    let group = group
        .filter(|value| !value.is_empty())
        .map(|value| value.clean_group())
        .transpose()?;
    let input = TextInput {
        text: text.clone(),
        group,
        device: parse_device(&headers),
    };
    let config = app.config.clone();
    let session_hash = (!auth.session_hash.is_empty()).then(|| auth.session_hash.clone());
    let bearer_id = auth.bearer.as_ref().map(|bearer| bearer.id.clone());
    let _gate = app.realtime.gate.lock().await;
    let channel = space_id.clone();
    let (item, groups) = app
        .db
        .run(move |db| {
            let before = db::groups(db, &space_id)?;
            let item = db::insert_text(
                db,
                &config,
                session_hash.as_deref(),
                bearer_id.as_deref(),
                &space_id,
                input,
            );
            let after = db::groups(db, &space_id)?;
            Ok((item, (before != after).then_some(after)))
        })
        .await?;
    // TS creates/publishes a group even if a later quota/capacity check fails.
    if let Some(groups) = groups {
        app.realtime
            .publish(&channel, json!({ "type": "groups", "groups": groups }));
    }
    let item = item?;
    app.realtime.publish_item(&channel, "item.created", &item);
    Ok((StatusCode::CREATED, Json(js::ItemResponse { item })))
}

async fn download(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    method: Method,
    path: Result<Path<(String, String)>, PathRejection>,
    request: Request,
) -> Response {
    read_existing(app, context, method, path, request, ReadKind::Download).await
}

async fn thumbnail(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    method: Method,
    path: Result<Path<(String, String)>, PathRejection>,
    request: Request,
) -> Response {
    read_existing(app, context, method, path, request, ReadKind::Thumbnail).await
}

async fn media(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    method: Method,
    path: Result<Path<(String, String)>, PathRejection>,
    request: Request,
) -> Response {
    read_existing(app, context, method, path, request, ReadKind::Media).await
}

#[derive(Clone, Copy)]
enum ReadKind {
    Download,
    Thumbnail,
    Media,
}

async fn read_existing(
    app: App,
    context: RequestContext,
    method: Method,
    path: Result<Path<(String, String)>, PathRejection>,
    request: Request,
    kind: ReadKind,
) -> Response {
    let Ok(user_id) = context
        .require_auth()
        .map(|auth| auth.account.user.id.clone())
    else {
        return ApiError::UNAUTHENTICATED.into_response();
    };
    let Ok(Path((space, id))) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let range = downloads::range_header(request.headers()).map(str::to_owned);
    let head = method == Method::HEAD;
    let directory = downloads::files_dir(&app.config.data);
    let loaded = app
        .db
        .run(move |db| db::readable_file(db, &space, &user_id, &id))
        .await;
    let file = match loaded {
        Ok(file) => file,
        Err(error) => return error.into_response(),
    };
    let Ok(size) = file_size(file.size) else {
        return ApiError::internal("negative stored size").into_response();
    };
    let prepared = match kind {
        ReadKind::Download => {
            let (Some(key), Some(filename)) = (
                file.file_key.filter(|key| !key.is_empty()),
                file.filename.filter(|name| !name.is_empty()),
            ) else {
                return ApiError::NOT_FOUND.into_response();
            };
            downloads::prepare_download(&directory, &key, &filename, size, range.as_deref(), head)
        }
        ReadKind::Thumbnail => {
            let Some(key) = file.thumbnail_key.filter(|key| !key.is_empty()) else {
                return ApiError::NOT_FOUND.into_response();
            };
            downloads::prepare_thumbnail(&directory, &key, head)
        }
        ReadKind::Media => {
            let Some(key) = file.file_key.filter(|key| !key.is_empty()) else {
                return ApiError::NOT_FOUND.into_response();
            };
            downloads::prepare_media(
                &directory,
                &key,
                file.filename.as_deref().unwrap_or("media"),
                size,
                range.as_deref(),
                head,
            )
        }
    };
    match prepared {
        Ok(prepared) => downloads::into_response(prepared, head),
        Err(error) => error.into_response(),
    }
}

fn file_size(size: i64) -> ApiResult<u64> {
    u64::try_from(size).map_err(|_| ApiError::internal("negative stored size"))
}

pub(crate) async fn read_json(request: Request, limit: usize) -> ApiResult<js::Object> {
    if !header_value(request.headers(), "content-type")
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return Err(ApiError::new(400, "JSON_REQUIRED"));
    }
    let bytes = to_bytes(request.into_body(), limit)
        .await
        .map_err(|error| {
            if std::error::Error::source(&error)
                .is_some_and(|source| source.is::<http_body_util::LengthLimitError>())
            {
                ApiError::new(413, "BODY_TOO_LARGE")
            } else {
                ApiError::new(400, "INVALID_JSON")
            }
        })?;
    // JSON.parse accepts huge numbers in unused fields. Keep them parseable before validating used fields.
    js::parse(&String::from_utf8_lossy(&bytes)).map_err(|_| ApiError::new(400, "INVALID_JSON"))
}

pub(crate) fn input_js_string(value: Option<&js::Value>, limit: usize) -> ApiResult<&js::JsString> {
    value
        .and_then(js::Value::as_js_str)
        .filter(|value| !value.is_empty() && value.utf16_len() <= limit)
        .ok_or(ApiError::INVALID_INPUT)
}

pub(crate) fn input_string(value: Option<&js::Value>, limit: usize) -> ApiResult<&str> {
    value
        .and_then(js::Value::as_str)
        .filter(|text| !text.is_empty() && text.encode_utf16().count() <= limit)
        .ok_or(ApiError::INVALID_INPUT)
}

pub(crate) fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn decode_uri_component(value: &str) -> Option<String> {
    for (index, byte) in value.bytes().enumerate() {
        if byte == b'%'
            && !value
                .as_bytes()
                .get(index + 1..index + 3)
                .is_some_and(|bytes| bytes.iter().all(u8::is_ascii_hexdigit))
        {
            return None;
        }
    }
    percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

pub(crate) fn parse_device(headers: &HeaderMap) -> Option<Device> {
    let name = header_value(headers, "x-dropit-device-name").and_then(decode_uri_component);
    device_from_values(
        header_value(headers, "x-dropit-device"),
        name.as_deref(),
        header_value(headers, "x-dropit-device-kind"),
    )
}

fn device_from_values(id: Option<&str>, name: Option<&str>, kind: Option<&str>) -> Option<Device> {
    let id = id?;
    if !(6..=64).contains(&id.len())
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return None;
    }
    let name = clean_whitespace(name.unwrap_or_default());
    let name = if name.is_empty() || name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        "未命名设备".into()
    } else {
        name.chars().take(40).collect()
    };
    let kind = kind
        .filter(|kind| matches!(*kind, "mac" | "phone" | "pad" | "pc" | "cli"))
        .unwrap_or("pc");
    Some(Device {
        id: id.into(),
        name,
        kind: kind.into(),
    })
}

pub(crate) fn clean_group(value: &str) -> ApiResult<String> {
    let group = clean_whitespace(value);
    if !(1..=24).contains(&group.chars().count())
        || group.chars().any(char::is_control)
        || matches!(group.as_str(), "全部" | "未分组")
    {
        return Err(ApiError::new(400, "INVALID_GROUP"));
    }
    Ok(group)
}

fn clean_whitespace(value: &str) -> String {
    let normalized: String = value.nfc().collect();
    normalized
        .split(js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn js_space(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_millis() as i64
}

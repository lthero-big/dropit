mod config;
mod db;
mod downloads;
mod password;

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::to_bytes,
    extract::{ConnectInfo, Extension, Path, Request, State, rejection::PathRejection},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use percent_encoding::percent_decode_str;
use rusqlite::{TransactionBehavior, params};
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use config::{Config, StartupResult, parse_origin};
use db::{Account, Database, Device, TextInput};

type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
struct ApiError {
    status: u16,
    code: &'static str,
    details: Option<Box<Map<String, Value>>>,
    header: Option<(header::HeaderName, HeaderValue)>,
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
        response
    }
}

struct StateData {
    config: Arc<Config>,
    db: Database,
    limiter: Mutex<HashMap<(&'static str, String), Bucket>>,
    password_slots: Arc<Semaphore>,
}

type App = Arc<StateData>;

struct Bucket {
    count: u32,
    reset: i64,
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
                HeaderValue::from((retry_at - time + 999) / 1000),
            ));
            return Err(error);
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Auth {
    account: Arc<Account>,
    session_hash: String,
}

#[derive(Clone)]
struct RequestContext {
    ip: String,
    ip_summary: String,
    secure_cookie: bool,
    auth: Option<Auth>,
}

impl RequestContext {
    fn require_auth(&self) -> ApiResult<&Auth> {
        self.auth.as_ref().ok_or(ApiError::UNAUTHENTICATED)
    }
}

#[tokio::main]
async fn main() -> StartupResult<()> {
    let mut config = Config::load()?;
    let db = Database::open(&mut config)?;
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    let app = Arc::new(StateData {
        db,
        config: Arc::new(config),
        limiter: Mutex::new(HashMap::new()),
        password_slots: Arc::new(Semaphore::new(4)),
    });
    let routes = Router::new()
        .route("/healthz", get(|| async { Json(json!({"status": "ok"})) }))
        .route("/api/auth/password/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/spaces", get(spaces))
        .route("/api/spaces/{space}", get(space))
        .route("/api/spaces/{space}/items", get(items))
        .route("/api/spaces/{space}/items/text", post(text))
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
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn_with_state(app.clone(), request_context))
        .with_state(app);
    println!("dropit listening on port {}", listener.local_addr()?.port());
    axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn not_found() -> ApiError {
    ApiError::NOT_FOUND
}

async fn request_context(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let own = request_origin(&app.config, &request, peer.ip());
    let origin = app
        .config
        .origin
        .as_ref()
        .map(|(origin, _)| origin.as_str())
        .or(own.as_deref());
    let secure = app.config.production && origin.is_some_and(|origin| origin.starts_with("https:"));
    let mut response = if is_api {
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
    app.limit("general:ip", &ip, app.config.rate_general)?;
    if headers.contains_key(header::AUTHORIZATION) {
        let mut error = ApiError::UNAUTHENTICATED;
        error.header = Some((header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer")));
        return Err(error);
    }
    let auth = if let Some(token) = read_cookie(headers, cookie_name(secure_cookie)) {
        let session_hash = password::hash(&token);
        let hash = session_hash.clone();
        let ip = ip_summary.clone();
        app.db
            .run(move |db| db::session(db, &hash, Some(&ip)))
            .await?
            .map(|account| Auth {
                account: Arc::new(account),
                session_hash,
            })
    } else {
        None
    };
    if let Some(auth) = &auth {
        app.limit(
            "general:user",
            &auth.account.user.id,
            app.config.rate_general,
        )?;
    }

    let safe = matches!(request.method.as_str(), "GET" | "HEAD" | "OPTIONS");
    if !safe {
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
        .is_some_and(|auth| auth.account.must_change_password)
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
        auth,
    })
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

fn cookie_name(secure: bool) -> &'static str {
    if secure {
        "__Host-dropit_session"
    } else {
        "dropit_session"
    }
}

fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
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

fn set_cookie(secure: bool, token: &str, max_age: i64) -> HeaderMap {
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
    app.limit("auth:ip", &context.ip, app.config.rate_auth)?;
    let user_agent = header_value(request.headers(), "user-agent").map(|agent| {
        let truncated: Vec<_> = agent.encode_utf16().take(400).collect();
        String::from_utf16_lossy(&truncated)
    });
    let body = read_json(request, 4096).await?;
    let email = body
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_matches(js_space)
        .to_lowercase();
    let password = input_string(body.get("password"), 256)?.to_owned();
    if email.is_empty() || email.encode_utf16().count() > 200 {
        return Err(ApiError::INVALID_INPUT);
    }
    app.limit("auth:email", &password::hash(&email), app.config.rate_auth)?;
    let invite = match body.get("invite") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        value => Some(password::hash(input_string(value, 128)?)),
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
    let hash = context.require_auth()?.session_hash.clone();
    app.db
        .run(move |db| {
            db.execute("DELETE FROM sessions WHERE sessionHash=?", [hash])?;
            Ok(())
        })
        .await?;
    Ok((
        StatusCode::NO_CONTENT,
        set_cookie(context.secure_cookie, "", 0),
    ))
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
) -> ApiResult<Json<Value>> {
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
    let text = input_string(body.get("text"), usize::MAX)?;
    let header_group = match header_value(&headers, "x-dropit-group").filter(|v| !v.is_empty()) {
        Some(raw) => Some(decode_uri_component(raw).ok_or(ApiError::new(400, "INVALID_GROUP"))?),
        None => None,
    };
    if text.trim_matches(js_space).is_empty() {
        return Err(ApiError::new(400, "EMPTY_TEXT"));
    }
    if text.len() > app.config.max_text {
        return Err(ApiError::new(413, "TEXT_TOO_LARGE"));
    }
    let group = match body.get("group") {
        None | Some(Value::Null) => header_group,
        value => Some(
            value
                .and_then(Value::as_str)
                .ok_or(ApiError::new(400, "INVALID_GROUP"))?
                .to_owned(),
        ),
    };
    let group = group
        .filter(|value| !value.is_empty())
        .map(|value| clean_group(&value))
        .transpose()?;
    let input = TextInput {
        text: text.to_owned(),
        group,
        device: parse_device(&headers),
    };
    let config = app.config.clone();
    let hash = auth.session_hash.clone();
    let item = app
        .db
        .run(move |db| db::insert_text(db, &config, &hash, &space_id, input))
        .await?;
    Ok((StatusCode::CREATED, Json(json!({ "item": item }))))
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

async fn read_json(request: Request, limit: usize) -> ApiResult<Map<String, Value>> {
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
    serde_json::from_str(&String::from_utf8_lossy(&bytes))
        .map_err(|_| ApiError::new(400, "INVALID_JSON"))
}

fn input_string(value: Option<&Value>, limit: usize) -> ApiResult<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.encode_utf16().count() <= limit)
        .ok_or(ApiError::INVALID_INPUT)
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
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

fn parse_device(headers: &HeaderMap) -> Option<Device> {
    let id = header_value(headers, "x-dropit-device")?;
    if !(6..=64).contains(&id.len())
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return None;
    }
    let name = header_value(headers, "x-dropit-device-name")
        .and_then(decode_uri_component)
        .unwrap_or_default();
    let name = clean_whitespace(&name);
    let name = if name.is_empty() || name.chars().any(char::is_control) {
        "未命名设备".into()
    } else {
        name.chars().take(40).collect()
    };
    let kind = header_value(headers, "x-dropit-device-kind")
        .filter(|kind| matches!(*kind, "mac" | "phone" | "pad" | "pc" | "cli"))
        .unwrap_or("pc");
    Some(Device {
        id: id.into(),
        name,
        kind: kind.into(),
    })
}

fn clean_group(value: &str) -> ApiResult<String> {
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

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_millis() as i64
}

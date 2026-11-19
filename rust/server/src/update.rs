//! Release metadata, update checks and the Android release feed.
//!
//! The public endpoints deliberately keep all network and filesystem failures
//! out of the request path used by the app.  A broken update service must not
//! prevent the clipboard from working or make an APK discoverable by filename.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use axum::{
    Json,
    body::Body,
    extract::{Extension, Path as AxumPath, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::{sync::watch, time::interval};

use crate::{ApiError, ApiResult, App, RequestContext, browser::BuildInfo, now};

const MAX_APK_BYTES: u64 = 200 * 1024 * 1024;
const UPDATE_HOURS_MIN: u64 = 6;
const UPDATE_HOURS_MAX: u64 = 168;

#[derive(Clone)]
struct UpdateSettings {
    enabled: bool,
    interval_ms: i64,
    image: String,
    repo: String,
    branch: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum UpdateStatus {
    Disabled,
    Pending,
    #[serde(rename = "up-to-date")]
    UpToDate,
    Available,
    Unknown,
    Error,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestRelease {
    version: Option<String>,
    commit: Option<String>,
    digest: Option<String>,
    published_at: Option<String>,
    url: Option<String>,
    behind_by: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    status: UpdateStatus,
    source: Option<String>,
    checked_at: Option<i64>,
    latest: Option<LatestRelease>,
    error: Option<String>,
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReport {
    current: BuildInfo,
    check: UpdateCheckReport,
    upgrade: Upgrade,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckReport {
    #[serde(flatten)]
    state: UpdateState,
    enabled: bool,
    interval_hours: u64,
    next_check_at: Option<i64>,
    image: String,
    repo: String,
    branch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Upgrade {
    install: String,
    command: String,
    docs: String,
}

#[derive(Serialize, Deserialize)]
struct CachedUpdate {
    key: String,
    state: UpdateState,
}

pub(crate) struct UpdateService {
    build: BuildInfo,
    settings: UpdateSettings,
    cache_path: PathBuf,
    state: Mutex<UpdateState>,
}

impl UpdateService {
    pub(crate) fn new(build: BuildInfo, data_dir: &Path) -> Result<Self, String> {
        let settings = load_settings()?;
        let key = cache_key(&build, &settings);
        let state = read_cache(&data_dir.join("update-check.json"), &key)
            .unwrap_or_else(|| initial_state(settings.enabled));
        Ok(Self {
            build,
            settings,
            cache_path: data_dir.join("update-check.json"),
            state: Mutex::new(state),
        })
    }

    fn report(&self) -> UpdateReport {
        let state = self
            .state
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| initial_state(false));
        let next_check_at = state
            .checked_at
            .map(|value| value + self.settings.interval_ms);
        UpdateReport {
            current: self.build.clone(),
            check: UpdateCheckReport {
                state,
                enabled: self.settings.enabled,
                interval_hours: (self.settings.interval_ms / 3_600_000) as u64,
                next_check_at,
                image: self.settings.image.clone(),
                repo: self.settings.repo.clone(),
                branch: self.settings.branch.clone(),
            },
            upgrade: Upgrade {
                install: self.build.install.clone(),
                command: upgrade_command(&self.build.install),
                docs: format!(
                    "https://github.com/{}/blob/main/docs/wiki/Deployment.md#upgrading",
                    self.settings.repo
                ),
            },
        }
    }

    async fn check_if_due(&self) {
        if !self.settings.enabled {
            return;
        }
        let due = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.checked_at)
            .is_none_or(|checked_at| now() - checked_at >= self.settings.interval_ms);
        if due {
            self.check_now().await;
        }
    }

    async fn check_now(&self) -> UpdateState {
        if !self.settings.enabled {
            return self
                .state
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| initial_state(false));
        }
        let current = self
            .state
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| initial_state(true));
        if let Some(checked_at) = current.checked_at
            && now() - checked_at < 60_000
            && current.status != UpdateStatus::Error
        {
            return current;
        }

        let result = self.fetch().await;
        let next = match result {
            Ok(state) => state,
            Err(code) => UpdateState {
                status: UpdateStatus::Error,
                checked_at: Some(now()),
                error: Some(match code.as_str() {
                    "HTTP_403" | "HTTP_429" => "RATE_LIMITED".into(),
                    "HTTP_408" | "TIMEOUT" => "TIMEOUT".into(),
                    _ => "NETWORK".into(),
                }),
                ..current
            },
        };
        if let Ok(mut state) = self.state.lock() {
            *state = next.clone();
        }
        persist_cache(
            &self.cache_path,
            &cache_key(&self.build, &self.settings),
            &next,
        );
        next
    }

    async fn fetch(&self) -> Result<UpdateState, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("dropit-update-check")
            .build()
            .map_err(|_| "NETWORK".to_owned())?;
        let mut state = if self.build.install == "docker" {
            self.docker_state(&client).await?
        } else {
            self.github_state(&client).await?
        };
        // A release tag is informational, but a newer semver release still
        // counts as available even when the branch comparison is identical.
        if let Ok(release) = get_json(
            &client,
            &format!(
                "https://api.github.com/repos/{}/releases/latest",
                self.settings.repo
            ),
        )
        .await
            && let Some(version) = release
                .get("tag_name")
                .and_then(Value::as_str)
                .and_then(normalize_version)
        {
            state
                .latest
                .get_or_insert_with(LatestRelease::default)
                .version = Some(version.clone());
            if compare_versions(&version, &self.build.version) > 0 && self.build.version != "0.0.0"
            {
                let latest = state.latest.get_or_insert_with(LatestRelease::default);
                latest.url = release
                    .get("html_url")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| latest.url.clone());
                latest.published_at = release
                    .get("published_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| latest.published_at.clone());
                state.status = UpdateStatus::Available;
            }
        }
        Ok(state)
    }

    async fn github_state(&self, client: &reqwest::Client) -> Result<UpdateState, String> {
        let base = UpdateState {
            status: UpdateStatus::Unknown,
            source: Some("github".into()),
            checked_at: Some(now()),
            latest: None,
            error: None,
            reason: None,
        };
        let Some(commit) = self.build.commit.as_deref() else {
            return Ok(UpdateState {
                reason: Some("NO_LOCAL_COMMIT".into()),
                ..base
            });
        };
        let Some(result) = self
            .behind_by(client, commit, &self.settings.branch)
            .await?
        else {
            return Ok(UpdateState {
                reason: Some("COMMIT_NOT_ON_GITHUB".into()),
                ..base
            });
        };
        Ok(UpdateState {
            status: if result.0 > 0 {
                UpdateStatus::Available
            } else {
                UpdateStatus::UpToDate
            },
            latest: Some(LatestRelease {
                commit: result.1,
                behind_by: Some(result.0),
                url: result.2,
                ..LatestRelease::default()
            }),
            ..base
        })
    }

    async fn docker_state(&self, client: &reqwest::Client) -> Result<UpdateState, String> {
        let repo = format!(
            "https://hub.docker.com/v2/repositories/{}",
            self.settings.image
        );
        let latest = get_json(client, &format!("{repo}/tags/latest")).await?;
        let digest = latest
            .get("digest")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let tags = get_json(
            client,
            &format!("{repo}/tags?page_size=50&ordering=last_updated"),
        )
        .await?;
        let mut sibling = tags
            .get("results")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tag| {
                let name = tag.get("name").and_then(Value::as_str)?;
                (name != "latest"
                    && digest.is_some()
                    && tag.get("digest").and_then(Value::as_str) == digest.as_deref())
                .then_some(name)
            });
        let commit = sibling.clone().find_map(normalize_commit);
        let version = sibling.find_map(normalize_version);
        let mut state = UpdateState {
            status: UpdateStatus::Unknown,
            source: Some("dockerhub".into()),
            checked_at: Some(now()),
            latest: Some(LatestRelease {
                digest,
                commit: commit.clone(),
                version: version.clone(),
                published_at: latest
                    .get("last_updated")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                url: Some(format!(
                    "https://hub.docker.com/r/{}/tags",
                    self.settings.image
                )),
                ..LatestRelease::default()
            }),
            error: None,
            reason: None,
        };
        if let (Some(local), Some(remote)) = (self.build.commit.as_deref(), commit.as_deref()) {
            if local == remote {
                state.status = UpdateStatus::UpToDate;
                state.latest.as_mut().unwrap().behind_by = Some(0);
            } else if let Some((behind, _, _)) = self.behind_by(client, local, remote).await? {
                state.status = if behind > 0 {
                    UpdateStatus::Available
                } else {
                    UpdateStatus::UpToDate
                };
                state.latest.as_mut().unwrap().behind_by = Some(behind);
            } else {
                state.reason = Some("COMPARE_UNAVAILABLE".into());
            }
        } else if let Some(remote) = version {
            state.status = if compare_versions(&remote, &self.build.version) > 0 {
                UpdateStatus::Available
            } else {
                UpdateStatus::UpToDate
            };
        } else {
            state.reason = Some(
                if self.build.commit.is_some() {
                    "REMOTE_UNTAGGED"
                } else {
                    "NO_LOCAL_COMMIT"
                }
                .into(),
            );
        }
        Ok(state)
    }

    async fn behind_by(
        &self,
        client: &reqwest::Client,
        commit: &str,
        target: &str,
    ) -> Result<Option<(u64, Option<String>, Option<String>)>, String> {
        let url = format!(
            "https://api.github.com/repos/{}/compare/{}...{}",
            self.settings.repo, commit, target
        );
        let body = match get_json(client, &url).await {
            Ok(body) => body,
            Err(error) if error == "HTTP_404" => return Ok(None),
            Err(error) => return Err(error),
        };
        let ahead = body
            .get("ahead_by")
            .and_then(Value::as_u64)
            .ok_or_else(|| "NETWORK".to_owned())?;
        let head = body
            .get("commits")
            .and_then(Value::as_array)
            .and_then(|items| items.last())
            .and_then(|item| item.get("sha"))
            .and_then(Value::as_str)
            .and_then(normalize_commit)
            .or_else(|| (ahead == 0).then(|| commit.to_owned()));
        let url = body
            .get("html_url")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(Some((ahead, head, url)))
    }
}

fn initial_state(enabled: bool) -> UpdateState {
    UpdateState {
        status: if enabled {
            UpdateStatus::Pending
        } else {
            UpdateStatus::Disabled
        },
        source: None,
        checked_at: None,
        latest: None,
        error: None,
        reason: None,
    }
}

fn load_settings() -> Result<UpdateSettings, String> {
    let flag = std::env::var("UPDATE_CHECK")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let enabled = !matches!(flag.as_str(), "0" | "false" | "off" | "no" | "disabled");
    let hours = std::env::var("UPDATE_CHECK_HOURS")
        .unwrap_or_else(|_| "12".into())
        .parse::<u64>()
        .map_err(|_| "Invalid UPDATE_CHECK_HOURS".to_owned())?;
    if !(UPDATE_HOURS_MIN..=UPDATE_HOURS_MAX).contains(&hours) {
        return Err("Invalid UPDATE_CHECK_HOURS (6-168)".into());
    }
    let image = std::env::var("UPDATE_IMAGE").unwrap_or_else(|_| "lthero1/dropit".into());
    let repo = std::env::var("UPDATE_REPO").unwrap_or_else(|_| "lthero-big/dropit".into());
    let branch = std::env::var("UPDATE_BRANCH").unwrap_or_else(|_| "main".into());
    if !valid_pair(&image)
        || !valid_pair(&repo)
        || branch.is_empty()
        || branch.len() > 100
        || branch.contains("..")
        || !branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'/' | b'_' | b'-'))
    {
        return Err("Invalid update source configuration".into());
    }
    Ok(UpdateSettings {
        enabled,
        interval_ms: (hours * 3_600_000) as i64,
        image,
        repo,
        branch,
    })
}

fn valid_pair(value: &str) -> bool {
    let mut parts = value.split('/');
    let valid = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && part.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
            })
    };
    parts.next().is_some_and(valid) && parts.next().is_some_and(valid) && parts.next().is_none()
}

fn upgrade_command(install: &str) -> String {
    match install {
        "docker" => "docker compose pull && docker compose up -d".into(),
        "docker-build" => "./scripts/update.sh --docker".into(),
        _ => "./scripts/update.sh".into(),
    }
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .header("accept", "application/json, application/vnd.github+json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "TIMEOUT"
            } else {
                "NETWORK"
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP_{}", status.as_u16()));
    }
    let bytes = response.bytes().await.map_err(|_| "NETWORK")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("HTTP_502".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "NETWORK".into())
}

fn normalize_commit(value: &str) -> Option<String> {
    let value = value.trim();
    (value.len() >= 7 && value.len() <= 40 && value.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| value[..7].to_ascii_lowercase())
}

fn normalize_version(value: &str) -> Option<String> {
    let value = value.trim().strip_prefix('v').unwrap_or(value.trim());
    let (core, suffix) = value
        .split_once(['-', '+'])
        .map_or((value, None), |(core, suffix)| (core, Some(suffix)));
    (core.split('.').count() == 3
        && core
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|part| {
            !part.is_empty()
                && part.len() <= 40
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        }))
    .then(|| value.to_owned())
}

fn compare_versions(a: &str, b: &str) -> i8 {
    let parts = |value: &str| {
        value
            .trim_start_matches('v')
            .split(['-', '+'])
            .next()
            .unwrap_or_default()
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    for index in 0..3 {
        if parts(a).get(index).unwrap_or(&0) != parts(b).get(index).unwrap_or(&0) {
            return if parts(a).get(index).unwrap_or(&0) > parts(b).get(index).unwrap_or(&0) {
                1
            } else {
                -1
            };
        }
    }
    0
}

fn cache_key(build: &BuildInfo, settings: &UpdateSettings) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        build.install,
        build.version,
        build.commit.as_deref().unwrap_or("-"),
        settings.image,
        settings.repo,
        settings.branch
    )
}

fn read_cache(path: &Path, key: &str) -> Option<UpdateState> {
    let cache: CachedUpdate = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (cache.key == key
        && cache.state.checked_at.is_some()
        && cache
            .state
            .checked_at
            .is_some_and(|checked_at| checked_at <= now())
        && cache.state.status != UpdateStatus::Pending
        && cache.state.status != UpdateStatus::Disabled)
        .then_some(cache.state)
}

pub(crate) async fn run_loop(app: App, mut shutdown: watch::Receiver<bool>) {
    let mut ticks = interval(Duration::from_secs(30));
    ticks.tick().await;
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            _ = ticks.tick() => app.update.check_if_due().await,
        }
    }
}

fn persist_cache(path: &Path, key: &str, state: &UpdateState) {
    let Ok(bytes) = serde_json::to_vec(&CachedUpdate {
        key: key.into(),
        state: state.clone(),
    }) else {
        return;
    };
    let _ = fs::create_dir_all(path.parent().unwrap_or_else(|| Path::new(".")));
    let temp = path.with_extension("tmp");
    if fs::write(&temp, bytes).is_ok() {
        let _ = fs::rename(temp, path);
    }
}

pub async fn android_latest(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<impl IntoResponse> {
    app.limit("app-update", &context.ip, app.config.rate_general)?;
    let Some(release) = read_android_release(&app.config.data).await else {
        return Err(ApiError::new(404, "NO_RELEASE"));
    };
    let mut body = json!({
        "versionCode": release.version_code,
        "versionName": release.version_name,
        "notes": release.notes,
        "size": release.size,
        "sha256": release.sha256,
        "publishedAt": release.published_at,
        "url": format!("/api/app/android/download/{}", release.file),
    });
    if let Some(minimum) = release.min_version_code {
        body["minVersionCode"] = json!(minimum);
    }
    if let Some(force) = release.force {
        body["force"] = json!(force);
    }
    Ok((
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(body),
    ))
}

pub async fn android_download(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    AxumPath(file): AxumPath<String>,
) -> ApiResult<Response> {
    app.limit("app-download", &context.ip, app.config.rate_upload)?;
    let Some(release) = read_android_release(&app.config.data).await else {
        return Err(ApiError::NOT_FOUND);
    };
    if file != release.file {
        return Err(ApiError::NOT_FOUND);
    }
    let path = android_dir(&app.config.data).join(&release.file);
    let mut input = tokio::fs::File::open(path)
        .await
        .map_err(|_| ApiError::NOT_FOUND)?;
    let mut bytes = Vec::with_capacity(release.size as usize);
    input
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ApiError::NOT_FOUND)?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.android.package-archive"),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(release.size));
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{}\"", release.file)).unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub async fn admin_report(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<impl IntoResponse> {
    crate::admin_session(&context)?;
    Ok(Json(app.update.report()))
}

pub async fn admin_check(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<impl IntoResponse> {
    crate::admin_session(&context)?;
    app.limit("update-check", &context.ip, app.config.rate_auth)?;
    app.update.check_now().await;
    Ok(Json(app.update.report()))
}

#[derive(Clone)]
struct AndroidRelease {
    version_code: u64,
    version_name: String,
    notes: String,
    file: String,
    sha256: String,
    size: u64,
    published_at: Option<String>,
    min_version_code: Option<u64>,
    force: Option<bool>,
}

async fn read_android_release(data_dir: &Path) -> Option<AndroidRelease> {
    let raw: Value = serde_json::from_slice(
        &tokio::fs::read(android_dir(data_dir).join("latest.json"))
            .await
            .ok()?,
    )
    .ok()?;
    let version_code = raw.get("versionCode")?.as_u64()?;
    let version_name = raw.get("versionName")?.as_str()?.to_owned();
    let file = raw.get("file")?.as_str()?.to_owned();
    let sha256 = raw.get("sha256")?.as_str()?.to_owned();
    let size = raw.get("size")?.as_u64()?;
    let notes = raw.get("notes").and_then(Value::as_str).unwrap_or_default();
    let min_version_code = raw.get("minVersionCode").and_then(Value::as_u64);
    let force = raw.get("force").and_then(Value::as_bool);
    if !(1..=2_100_000_000).contains(&version_code)
        || version_name.is_empty()
        || version_name.len() > 40
        || !version_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
        || file.len() < 5
        || file.len() > 125
        || !file.ends_with(".apk")
        || !file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        || file.starts_with('.')
        || file.contains("..")
        || notes.len() > 4000
        || raw.get("minVersionCode").is_some_and(|_| {
            min_version_code.is_none()
                || min_version_code.is_some_and(|minimum| minimum < 1 || minimum > version_code)
        })
        || raw.get("force").is_some_and(|_| force.is_none())
        || sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || !(1..=MAX_APK_BYTES).contains(&size)
    {
        return None;
    }
    let published_at = raw
        .get("publishedAt")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let metadata = tokio::fs::metadata(android_dir(data_dir).join(&file))
        .await
        .ok()?;
    (metadata.is_file() && metadata.len() == size).then_some(AndroidRelease {
        version_code,
        version_name,
        notes: notes.into(),
        file,
        sha256,
        size,
        published_at,
        min_version_code,
        force,
    })
}

fn android_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("app").join("android")
}

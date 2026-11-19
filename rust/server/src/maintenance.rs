//! Durable expiry and local-file garbage collection.
//!
//! Database changes commit before object deletion.  A failed unlink therefore
//! remains in `garbage` and is retried by the next pass or the next process.

use std::{collections::HashSet, path::Path, time::UNIX_EPOCH};

use serde_json::json;
use tokio::{
    sync::watch,
    time::{Duration, interval},
};

use crate::{ApiError, ApiResult, App, db, downloads, now};

pub async fn run_once(app: &App) -> ApiResult<()> {
    let time = now();
    let expired = app.db.run(move |db| db::expire(db, time)).await?;
    crate::uploads::abort_sessions(app, &expired.upload_ids).await;
    for item in &expired.items {
        app.realtime.publish(
            &item.space_id,
            json!({ "type": "item.deleted", "id": item.id }),
        );
    }
    let directory = downloads::files_dir(&app.config.data);
    flush_garbage(app, &directory).await;

    let referenced = app.db.run(|db| db::referenced_file_keys(&*db)).await?;
    let referenced: HashSet<String> = referenced.into_iter().collect();
    sweep_orphans(&directory, &referenced, time.saturating_sub(3_600_000)).await
}

pub async fn run_loop(app: App, mut shutdown: watch::Receiver<bool>) {
    // Run once before the listener accepts traffic so a restart promptly
    // releases expired reservations and retries the durable delete queue.
    if let Err(error) = run_once(&app).await {
        log_error("initial maintenance", &error);
    }
    let mut ticks = interval(Duration::from_millis(app.config.cleanup_interval_ms as u64));
    ticks.tick().await;
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            _ = ticks.tick() => {
                if let Err(error) = run_once(&app).await {
                    log_error("maintenance", &error);
                }
            }
        }
    }
}

async fn flush_garbage(app: &App, directory: &Path) {
    let Ok(keys) = app.db.run(|db| db::garbage_keys(&*db)).await else {
        return;
    };
    for key in keys {
        let Ok(path) = downloads::object_path(directory, &key) else {
            eprintln!("dropit: retaining invalid garbage key");
            continue;
        };
        match tokio::fs::remove_file(path).await {
            Ok(()) => {
                let _ = app.db.run(move |db| db::forget_garbage(db, &key)).await;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let _ = app.db.run(move |db| db::forget_garbage(db, &key)).await;
            }
            Err(error) => eprintln!("dropit: garbage retry failed: {error}"),
        }
    }
}

async fn sweep_orphans(
    directory: &Path,
    referenced: &HashSet<String>,
    older_than: i64,
) -> ApiResult<()> {
    let mut entries = match tokio::fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(ApiError::internal(error)),
    };
    while let Some(entry) = entries.next_entry().await.map_err(ApiError::internal)? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if referenced.contains(name) || downloads::object_path(directory, name).is_err() {
            continue;
        }
        let metadata = entry.metadata().await.map_err(ApiError::internal)?;
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().map_err(ApiError::internal)?;
        let millis = modified
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis() as i64)
            .unwrap_or(0);
        if millis < older_than {
            match tokio::fs::remove_file(entry.path()).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(ApiError::internal(error)),
            }
        }
    }
    Ok(())
}

fn log_error(label: &str, _error: &ApiError) {
    eprintln!("dropit: {label} failed; will retry");
}

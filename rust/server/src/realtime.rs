//! Private-space read-only WebSocket channels; all payloads retain the TS wire format.
use crate::{
    ApiError, ApiResult, App, RequestContext,
    db::{self, Device},
    device_from_values,
};
use axum::{
    Extension,
    extract::{
        Path, RawQuery, State, WebSocketUpgrade,
        rejection::PathRejection,
        ws::{CloseFrame, Message, WebSocket, rejection::WebSocketUpgradeRejection},
    },
    response::{IntoResponse, Response},
};
use futures_util::SinkExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

const MAX_PENDING_BYTES: usize = 1024 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Realtime {
    // Serializes snapshot subscription with the text transaction and its publish.
    pub gate: tokio::sync::Mutex<()>,
    hub: Mutex<Hub>,
}

#[derive(Default)]
struct Hub {
    next: u64,
    connections: HashMap<u64, Connection>,
}
struct Connection {
    space: String,
    ip: String,
    user: String,
    bearer: Option<String>,
    device: Option<Device>,
    active: bool,
    pending: usize,
    sender: mpsc::Sender<Arc<str>>,
    close: watch::Sender<bool>,
}

struct Subscription {
    id: u64,
    app: App,
    receiver: mpsc::Receiver<Arc<str>>,
    close: watch::Receiver<bool>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut hub = self.app.realtime.hub.lock().unwrap();
        if let Some(connection) = hub.connections.remove(&self.id) {
            hub.presence(&connection.space);
        }
    }
}

impl Realtime {
    pub fn new() -> Self {
        Self::default()
    }
    fn subscribe(
        app: App,
        space: String,
        ip: String,
        user: String,
        bearer: Option<String>,
        device: Option<Device>,
    ) -> ApiResult<Subscription> {
        let mut hub = app.realtime.hub.lock().map_err(ApiError::internal)?;
        if hub.connections.len() >= 256
            || hub.connections.values().filter(|c| c.ip == ip).count() >= 8
            || hub.connections.values().filter(|c| c.user == user).count() >= 8
        {
            return Err(ApiError::new(429, "SOCKET_LIMIT"));
        }
        let (sender, receiver) = mpsc::channel(256);
        let (close, closed) = watch::channel(false);
        hub.next += 1;
        let id = hub.next;
        hub.connections.insert(
            id,
            Connection {
                space,
                ip,
                user,
                bearer,
                device,
                sender,
                close,
                active: false,
                pending: 0,
            },
        );
        drop(hub);
        Ok(Subscription {
            id,
            app,
            receiver,
            close: closed,
        })
    }
    pub fn publish(&self, space: &str, event: Value) {
        self.hub.lock().unwrap().publish(space, event);
    }

    pub fn revoke_token(&self, token_id: &str) {
        let mut hub = self.hub.lock().unwrap();
        for connection in hub.connections.values_mut() {
            if connection.bearer.as_deref() == Some(token_id) {
                let _ = connection.close.send(true);
            }
        }
    }
}

impl Hub {
    fn publish(&mut self, space: &str, event: Value) {
        let payload: Arc<str> = event.to_string().into();
        for c in self.connections.values_mut().filter(|c| c.space == space) {
            if *c.close.borrow() {
                continue;
            }
            if c.pending + payload.len() > MAX_PENDING_BYTES
                || c.sender.try_send(payload.clone()).is_err()
            {
                let _ = c.close.send(true);
            } else {
                c.pending += payload.len();
            }
        }
    }
    fn presence(&mut self, space: &str) {
        // Connection IDs retain connect order, as in TS's insertion-ordered Map.
        let mut connections: Vec<_> = self
            .connections
            .iter()
            .filter(|(_, c)| c.space == space && c.active && !*c.close.borrow())
            .collect();
        connections.sort_by_key(|(id, _)| **id);
        let devices = connections.len();
        let mut peers = Vec::<Device>::new();
        let mut others = 0;
        for (_, c) in connections {
            if let Some(device) = &c.device {
                if !peers.iter().any(|p| p.id == device.id) {
                    peers.push(device.clone());
                }
            } else {
                others += 1;
            }
        }
        let mut event = json!({ "type": "presence", "devices": devices });
        if !peers.is_empty() {
            event["peers"] = json!(peers);
            if others > 0 {
                event["others"] = json!(others);
            }
        }
        self.publish(space, event);
    }
}

pub async fn websocket(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    RawQuery(query): RawQuery,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> ApiResult<Response> {
    // Like TS, Origin precedes scope authorization (including for signed-out clients).
    let (expected, source) = app
        .config
        .origin
        .as_ref()
        .map(|(o, s)| (o.as_str(), *s))
        .unwrap_or((
            context.request_origin.as_deref().unwrap_or_default(),
            "request",
        ));
    let received = context.received_origin.as_deref().unwrap_or_default();
    let allowed = !received.is_empty()
        && (received == expected
            || (source == "request"
                && expected
                    .strip_prefix("http://")
                    .is_some_and(|h| received == format!("https://{h}"))));
    let auth = context.require_auth()?.clone();
    if auth.bearer.is_none() && !allowed {
        let mut error = ApiError::new(403, "ORIGIN_REJECTED");
        error.details = Some(Box::new(serde_json::Map::from_iter([
            ("expected".into(), expected.into()),
            ("received".into(), received.into()),
            ("source".into(), source.into()),
        ])));
        return Err(error);
    }
    let Path(space) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user = auth.account.user.id.clone();
    let bearer = auth.bearer.as_ref().map(|bearer| bearer.id.clone());
    let scope = space.clone();
    let id = user.clone();
    app.db
        .run(move |db| db::space(db, &scope, &id, false))
        .await?;
    let device = parse_device(query.as_deref());
    let subscription = Realtime::subscribe(
        app.clone(),
        space.clone(),
        context.ip,
        user.clone(),
        bearer.clone(),
        device.clone(),
    )?;
    let upgrade = upgrade.map_err(|_| ApiError::new(500, "INTERNAL_ERROR"))?;
    Ok(upgrade
        .max_message_size(1024)
        .max_frame_size(1024)
        .on_upgrade(move |socket| {
            run(
                socket,
                subscription,
                space,
                user,
                auth.session_hash,
                bearer,
                device,
            )
        })
        .into_response())
}

pub async fn room_websocket(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    RawQuery(query): RawQuery,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> ApiResult<Response> {
    let (expected, source) = app
        .config
        .origin
        .as_ref()
        .map(|(origin, source)| (origin.as_str(), *source))
        .unwrap_or((
            context.request_origin.as_deref().unwrap_or_default(),
            "request",
        ));
    let received = context.received_origin.as_deref().unwrap_or_default();
    let allowed = !received.is_empty()
        && (received == expected
            || (source == "request"
                && expected
                    .strip_prefix("http://")
                    .is_some_and(|host| received == format!("https://{host}"))));
    if context
        .auth
        .as_ref()
        .is_none_or(|auth| auth.bearer.is_none())
        && !allowed
    {
        let mut error = ApiError::new(403, "ORIGIN_REJECTED");
        error.details = Some(Box::new(serde_json::Map::from_iter([
            ("expected".into(), expected.into()),
            ("received".into(), received.into()),
            ("source".into(), source.into()),
        ])));
        return Err(error);
    }
    let Path(room) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let room_space = crate::rooms::load_room(&app, &room).await?;
    let auth = context.auth.clone();
    let user = auth
        .as_ref()
        .map(|auth| auth.account.user.id.clone())
        .unwrap_or_else(|| format!("room:{}", context.ip));
    let bearer = auth
        .as_ref()
        .and_then(|auth| auth.bearer.as_ref())
        .map(|bearer| bearer.id.clone());
    let device = parse_device(query.as_deref());
    let subscription = Realtime::subscribe(
        app.clone(),
        room_space.id,
        context.ip,
        user.clone(),
        bearer.clone(),
        device,
    )?;
    let upgrade = upgrade.map_err(|_| ApiError::new(500, "INTERNAL_ERROR"))?;
    Ok(upgrade
        .max_message_size(1024)
        .max_frame_size(1024)
        .on_upgrade(move |socket| run_room(socket, subscription, room, bearer))
        .into_response())
}

fn parse_device(query: Option<&str>) -> Option<Device> {
    let mut values = HashMap::new();
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        values.entry(key.into_owned()).or_insert(value.into_owned());
    }
    device_from_values(
        values.get("device").map(String::as_str),
        values.get("name").map(String::as_str),
        values.get("kind").map(String::as_str),
    )
}

async fn authorized(app: &App, space: &str, user: &str, hash: &str, bearer: Option<&str>) -> bool {
    let space = space.to_owned();
    let user = user.to_owned();
    let hash = hash.to_owned();
    let bearer = bearer.map(str::to_owned);
    app.db
        .run(move |db| {
            db::principal_member(
                db,
                (!hash.is_empty()).then_some(hash.as_str()),
                bearer.as_deref(),
                &space,
                &user,
            )
        })
        .await
        .unwrap_or(false)
}

async fn run(
    mut socket: WebSocket,
    mut sub: Subscription,
    space: String,
    user: String,
    hash: String,
    bearer: Option<String>,
    device: Option<Device>,
) {
    let app = sub.app.clone();
    // The subscriber exists before taking the snapshot; holding gate prevents gaps.
    // Discard pre-snapshot events: the snapshot already contains those committed writes.
    let snapshot = {
        let _gate = app.realtime.gate.lock().await;
        if !authorized(&app, &space, &user, &hash, bearer.as_deref()).await {
            close(&mut socket, 1008, "Authorization expired").await;
            return;
        }
        while let Ok(payload) = sub.receiver.try_recv() {
            consume(&sub, payload.len());
        }
        let scope = space.clone();
        let id = user.clone();
        let session = hash.clone();
        app.db.run(move |db| {
            if let Some(device) = device
                && !session.is_empty()
            {
                db.execute("UPDATE sessions SET deviceId=?,deviceName=?,deviceKind=? WHERE sessionHash=?", rusqlite::params![device.id, device.name, device.kind, session])?;
            }
            let tx = db.transaction()?;
            let space = db::space(&tx, &scope, &id, false)?;
            db::snapshot(&tx, space)
        }).await
    };
    let Ok(snapshot) = snapshot else {
        close(&mut socket, 1011, "Snapshot unavailable").await;
        return;
    };
    if send(&mut socket, Message::Text(snapshot.to_string().into()))
        .await
        .is_err()
    {
        close(&mut socket, 1013, "Slow consumer").await;
        return;
    }
    {
        let mut hub = app.realtime.hub.lock().unwrap();
        if let Some(connection) = hub.connections.get_mut(&sub.id) {
            connection.active = true;
        }
        hub.presence(&space);
    }
    let mut validation = tokio::time::interval(Duration::from_secs(1));
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    validation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut alive = true;
    loop {
        tokio::select! {
            biased;
            _ = sub.close.changed() => { let code=if authorized(&app,&space,&user,&hash,bearer.as_deref()).await {1013} else {1008}; let reason=if code==1013 { "Slow consumer" } else { "Authorization expired" }; close(&mut socket, code, reason).await; break; }
            _ = validation.tick() => {
                if !authorized(&app, &space, &user, &hash, bearer.as_deref()).await { close(&mut socket, 1008, "Authorization expired").await; break; }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) => {
                    // recv queues the reply; flush it before releasing the transport.
                    let _ = tokio::time::timeout(SEND_TIMEOUT, socket.flush()).await;
                    break;
                }
                Some(Err(error)) => {
                    let inner = error.into_inner();
                    match inner.downcast_ref::<tungstenite::Error>() {
                        Some(tungstenite::Error::Capacity(_)) => close(&mut socket, 1009, "Max payload size exceeded").await,
                        Some(tungstenite::Error::Utf8(_)) => close(&mut socket, 1007, "Invalid UTF-8").await,
                        _ => {},
                    }
                    break;
                }
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Ping(data))) => { if send(&mut socket, Message::Pong(data)).await.is_err() { break } }
                Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => { close(&mut socket, 1008, "Read-only channel").await; break; }
                _ => break,
            },
            _ = heartbeat.tick() => {
                if !alive { break }
                alive = false;
                if send(&mut socket, Message::Ping(Vec::new().into())).await.is_err() { break }
            }
            payload = sub.receiver.recv() => {
                let Some(payload) = payload else { break };
                consume(&sub, payload.len());
                // Revalidate immediately before delivering data, not only on the timer.
                if !authorized(&app, &space, &user, &hash, bearer.as_deref()).await { close(&mut socket, 1008, "Authorization expired").await; break }
                if send(&mut socket, Message::Text(payload.to_string().into())).await.is_err() {
                    close(&mut socket, 1013, "Slow consumer").await; break;
                }
            }
        }
    }
}

async fn run_room(
    mut socket: WebSocket,
    mut sub: Subscription,
    room_token: String,
    bearer: Option<String>,
) {
    let app = sub.app.clone();
    let snapshot = {
        let _gate = app.realtime.gate.lock().await;
        if !room_authorized(&app, &room_token, bearer.as_deref()).await {
            close(&mut socket, 1008, "Authorization expired").await;
            return;
        }
        while let Ok(payload) = sub.receiver.try_recv() {
            consume(&sub, payload.len());
        }
        let token = room_token.clone();
        app.db
            .run(move |db| {
                let id = token
                    .split_once('.')
                    .map(|(id, _)| id)
                    .ok_or(ApiError::NOT_FOUND)?
                    .to_owned();
                db::snapshot(db, db::room(db, &id, crate::now())?)
            })
            .await
    };
    let Ok(snapshot) = snapshot else {
        close(&mut socket, 1011, "Snapshot unavailable").await;
        return;
    };
    if send(&mut socket, Message::Text(snapshot.to_string().into()))
        .await
        .is_err()
    {
        close(&mut socket, 1013, "Slow consumer").await;
        return;
    }
    {
        let mut hub = app.realtime.hub.lock().unwrap();
        if let Some(connection) = hub.connections.get_mut(&sub.id) {
            connection.active = true;
        }
        let channel = room_token
            .split_once('.')
            .map(|(id, _)| id)
            .unwrap_or_default();
        hub.presence(channel);
    }
    let mut validation = tokio::time::interval(Duration::from_secs(1));
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    validation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut alive = true;
    loop {
        tokio::select! {
            biased;
            _ = sub.close.changed() => { let code=if room_authorized(&app,&room_token,bearer.as_deref()).await {1013} else {1008}; let reason=if code==1013 { "Slow consumer" } else { "Authorization expired" }; close(&mut socket, code, reason).await; break; }
            _ = validation.tick() => { if !room_authorized(&app, &room_token, bearer.as_deref()).await { close(&mut socket, 1008, "Authorization expired").await; break; } }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) => { let _ = tokio::time::timeout(SEND_TIMEOUT, socket.flush()).await; break; }
                Some(Err(error)) => { let inner = error.into_inner(); match inner.downcast_ref::<tungstenite::Error>() { Some(tungstenite::Error::Capacity(_)) => close(&mut socket, 1009, "Max payload size exceeded").await, Some(tungstenite::Error::Utf8(_)) => close(&mut socket, 1007, "Invalid UTF-8").await, _ => {} } break; }
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Ping(data))) => { if send(&mut socket, Message::Pong(data)).await.is_err() { break; } }
                Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => { close(&mut socket, 1008, "Read-only channel").await; break; }
                _ => break,
            },
            _ = heartbeat.tick() => { if !alive { break; } alive = false; if send(&mut socket, Message::Ping(Vec::new().into())).await.is_err() { break; } }
            payload = sub.receiver.recv() => {
                let Some(payload) = payload else { break; };
                consume(&sub, payload.len());
                if !room_authorized(&app, &room_token, bearer.as_deref()).await { close(&mut socket, 1008, "Authorization expired").await; break; }
                if send(&mut socket, Message::Text(payload.to_string().into())).await.is_err() { close(&mut socket, 1013, "Slow consumer").await; break; }
            }
        }
    }
}

fn consume(sub: &Subscription, bytes: usize) {
    if let Some(c) = sub
        .app
        .realtime
        .hub
        .lock()
        .unwrap()
        .connections
        .get_mut(&sub.id)
    {
        c.pending = c.pending.saturating_sub(bytes);
    }
}
async fn send(socket: &mut WebSocket, message: Message) -> Result<(), ()> {
    tokio::time::timeout(SEND_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}
async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = send(
        socket,
        Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })),
    )
    .await;
}

async fn room_authorized(app: &App, token: &str, bearer: Option<&str>) -> bool {
    if crate::rooms::load_room(app, token).await.is_err() {
        return false;
    }
    if let Some(bearer) = bearer {
        let id = bearer.to_owned();
        return app.db.run(move |db| Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM access_tokens t JOIN users u ON u.id=t.userId WHERE t.id=? AND t.revoked=0 AND u.disabled=0 AND u.pending=0 AND (t.expiresAt IS NULL OR t.expiresAt>?))",rusqlite::params![id,crate::now()],|row|row.get::<_,bool>(0))?)).await.unwrap_or(false);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_is_bounded_and_flags_slow_consumer() {
        let (sender, _receiver) = mpsc::channel(256);
        let (close, closed) = watch::channel(false);
        let mut hub = Hub::default();
        hub.connections.insert(
            1,
            Connection {
                sender,
                close,
                space: "s".into(),
                user: "u".into(),
                bearer: None,
                ip: "i".into(),
                device: None,
                active: false,
                pending: 0,
            },
        );
        for _ in 0..20 {
            hub.publish("s", json!({"text": "x".repeat(65536)}));
        }
        assert!(*closed.borrow());
        assert!(hub.connections[&1].pending <= MAX_PENDING_BYTES);
        let pending = hub.connections[&1].pending;
        hub.publish("other-space", json!({"text": "private"}));
        assert_eq!(hub.connections[&1].pending, pending);
    }
}

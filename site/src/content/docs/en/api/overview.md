---
title: API overview
---

This page is an overview; the authoritative contract is [docs/api.md](../reference/) in the repository.

## Conventions

- Same-origin HTTP API under the `/api` prefix; everything is JSON except downloads, thumbnails, previews, media, OAuth redirects and `204`.
- Times are Unix milliseconds; sizes are bytes.
- Browsers use the server-side session cookie; the CLI and scripts use personal access tokens: `Authorization: Bearer <token>`.
- Cookie or anonymous write requests must send `Origin: <APP_ORIGIN>`; a valid Bearer token skips the Origin check.
- JSON requests need `Content-Type: application/json`.
- Error format: `{"error":{"code":"QUOTA_EXCEEDED"}}`; 429 responses include `Retry-After`.
- Health check: `GET /healthz` → `{"status":"ok"}`.
- Version: `GET /api/version` (no sign-in required) → `{"version":"0.1.0","commit":"ab078cf","buildDate":"…","install":"docker"}`.

## Endpoint groups

| Group | Main paths |
| --- | --- |
| Authentication | `GET /auth/providers`, `GET /auth/:provider`, `GET /auth/:provider/callback`, `POST /auth/logout`, `GET /me`, `GET /invites/:token` |
| Personal access tokens | `POST/GET /tokens`, `PATCH/DELETE /tokens/:id` |
| Device-code login | `POST /auth/device/authorize`, `POST /auth/device/token`, `GET /auth/device`, `POST /auth/device/approve`, `POST /auth/device/deny` |
| Signed-in devices | `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-others` (browser sessions only) |
| Admin | `/admin/users`, `/admin/users/:id/logout`, `GET /admin/users/:id/sessions`, `DELETE /admin/sessions/:id`, `/admin/invites`, `/admin/tokens`, `/admin/limits`, `/admin/limits/audit`, `GET /admin/update`, `POST /admin/update/check` |
| Spaces and rooms | `GET /spaces`, `POST /rooms` (optional `code`/`pin`), `POST /rooms/enter`, `PUT /rooms/:room/code`; personal invitations `GET/POST /me/invites`, `DELETE /me/invites/:id` |
| Items (`base` = `/spaces/:id` or `/rooms/:room` (access token)) | `GET base`, `GET base/items`, `POST base/items/text`, `POST base/items/file`, `PATCH base/items/:id`, `PATCH base/items/:id/labels`, `DELETE base/items/:id`, `GET base/items/:id/{download,thumbnail,preview,media}` |
| Groups | `GET/POST base/groups`, `PATCH/DELETE base/groups/:name` |
| Chunked uploads | `POST base/uploads`, `GET base/uploads/:id`, `PUT base/uploads/:id/chunks/:index`, `POST base/uploads/:id/complete`, `DELETE base/uploads/:id` |
| Share links | `POST/GET base/items/:id/shares`, `DELETE base/shares/:shareId`, public `GET /s/:token` and `/s/:token/{file,thumbnail,preview,media}` |
| Real-time | `GET base/ws` (WebSocket) |

## WebSocket

The server only pushes and does not accept client messages:

```ts
type Message =
  | {type: 'snapshot'; items: Item[]; groups?: string[]; serverTime: number; expiresAt: number | null}
  | {type: 'groups'; groups: string[]}
  | {type: 'item.created'; item: Item}
  | {type: 'item.updated'; item: Item}
  | {type: 'item.deleted'; id: string}
  | {type: 'presence'; devices: number; peers?: Array<{id: string; name: string; kind: string}>; others?: number};
```

`presence.devices` is the number of connections (several tabs in the same browser count separately); `peers` are the deduplicated named devices; `others` is the number of connections that didn't declare a device (such as the CLI). The UI's “online devices” count = online named devices + 1 “Other clients” row (when `others` is present), matching the number of rows marked online in the list.

On every connection, replace the local list with the first `snapshot`, then apply incremental events by `id`; after a disconnect, reconnect with exponential backoff (with jitter, up to 30 seconds). Stop retrying on 401/403/404.

## Examples

```bash
export DROPIT_URL=https://dropit.example.com
export DROPIT_TOKEN=...   # created on /settings

# List spaces
curl -s -H "Authorization: Bearer $DROPIT_TOKEN" $DROPIT_URL/api/spaces

# Send text
curl -s -X POST -H "Authorization: Bearer $DROPIT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"hello"}' $DROPIT_URL/api/spaces/<spaceId>/items/text

# Upload a file (single request)
curl -s -X POST -H "Authorization: Bearer $DROPIT_TOKEN" -H 'Content-Type: image/png' \
  -H 'X-File-Name: photo.png' --data-binary @photo.png $DROPIT_URL/api/spaces/<spaceId>/items/file
```

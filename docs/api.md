# dropit backend API (MVP)

Same-origin HTTP API under `/api`; all responses are JSON except downloads,
thumbnails, OAuth redirects and empty `204` responses. Dates are Unix milliseconds;
sizes are bytes. Requests use the server session cookie (`credentials: 'same-origin'`).
There are no passwords, bearer session tokens, CORS origins or public mock logins.

Every POST/PATCH/DELETE requires `Origin: <APP_ORIGIN>` (also for rooms/logout).
JSON requests require `Content-Type: application/json`. Failed authorization of a
known authenticated space and an unknown space both return `404 NOT_FOUND`.
Missing/expired/revoked session returns `401 UNAUTHENTICATED`.

## Authentication and invitations

| Method | Path | Response / request |
| --- | --- | --- |
| GET | `/auth/providers` | `{providers: ['github','google']}`; only configured providers appear |
| GET | `/auth/:provider?invite=:token` | Navigate the browser here; 302 to OAuth provider, sets flow-binding cookie. Optional invite is bound to this flow. |
| GET | `/auth/:provider/callback` | OAuth-only callback; state, browser cookie and PKCE required; sets session and redirects to `/`. Errors are JSON. |
| POST | `/auth/logout` | 204; immediately revokes this session, closes its sockets and clears cookie |
| GET | `/me` | `{user, usedBytes, quotaBytes, maxFileBytes, maxTextBytes, retentionMs}` |
| GET | `/invites/:token` | `{spaceName, expiresAt, remainingUses}`; invalid/revoked/used/expired: 404 |

`User = {id, email, name, role: 'admin'|'user', disabled: 0|1, createdAt}`.
The invite page does **not** create an account or consume a use. It sends the token
to the OAuth start URL. Only a successful verified OAuth identity can atomically
consume a use, create an account/private space and join the invited space. Existing
members do not spend additional uses on the same still-valid invitation. Existing
users may sign in without an invite. A consumed/expired token is never accepted,
even if the user previously joined through it. OAuth state is single-use and valid
for 10 minutes. Starting a new flow replaces the browser's previous flow cookie.

If `ADMIN_EMAILS` is empty, the first successfully authenticated identity becomes
admin. If configured, only a provider-verified matching email may bootstrap the
installation; other new identities require an invite. Matching configured emails
also become admins when created. Provider identities remain separate; we do not
silently link GitHub and Google accounts by email. No provider access/refresh token
is stored. Configure `ADMIN_EMAILS` before exposing an installation.

## Administration

All paths here require an enabled admin, otherwise 401/403.

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/admin/users` | `{users: [User & {usedBytes, quotaBytes}]}` |
| PATCH | `/admin/users/:id` | `{disabled: boolean}` → 204; disabling immediately revokes every session/socket. Enabling requires a new login. Last enabled admin cannot be disabled (`409 LAST_ADMIN`). |
| GET | `/admin/invites` | `{invites: [Invite]}` (no secret token) |
| POST | `/admin/invites` | `{spaceId, maxUses?: 1, expiresInHours?: 24}` → 201, `Invite & {token,url}`. Uses: 1–100; expiry: 1–720 hours. Admin must belong to target space. |
| DELETE | `/admin/invites/:id` | 204; immediate revocation |

`Invite = {id, spaceId, maxUses, uses, expiresAt, revoked: 0|1, createdBy}`.
The invitation token is returned only at creation; share the returned URL securely.
Only its SHA-256 digest is stored. Expired/revoked invitation records may be removed
by maintenance. There is no arbitrary member-join endpoint.

## Spaces, temporary rooms, entries

`GET /spaces` → `{spaces: [{id,name,ownerId,expiresAt:null}]}`. Includes the
user's automatically created private space and spaces joined by invitation.

`POST /rooms` (no body or account required) → 201,
`{token, expiresAt, url}`. The token has 256 random bits and acts as the room's
read/write capability. Share the URL only with participants. There is no room list,
search or enumeration endpoint. Unknown and expired capabilities both return 404.
Authenticated users accessing a room still use the **room** quota, not user quota.

Set `base` to `/spaces/:spaceId` or `/rooms/:roomToken` in the following table.
Space routes require membership; room routes require the unexpired capability.

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `base` | `{id,name,expiresAt,maxFileBytes,quotaBytes}` |
| GET | `base/items` | `{type:'snapshot', items:Item[],serverTime,expiresAt}`; current nonexpired entries, newest first |
| POST | `base/items/text` | `{text:string}` → 201 `{item:Item}`; nonblank UTF-8, max `MAX_TEXT_BYTES` |
| POST | `base/items/file` | **Raw binary body**, original type in `Content-Type`, filename in `X-File-Name: encodeURIComponent(name)` → 201 `{item:Item}` |
| GET | `base/items/:id/download` | Raw bytes, `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`. No range/resume support. |
| GET | `base/items/:id/thumbnail` | Sanitized, re-encoded `image/webp` up to 320×320; 404 if no thumbnail |
| DELETE | `base/items/:id` | 204; retract entry and stored file/thumbnail. In spaces, sender or space owner only; in rooms, every capability holder may retract. |
| WS | `base/ws` | Read-only event channel; exact `Origin` required, with session cookie for spaces |

```ts
interface Item {
  id: string;
  spaceId: string;
  userId: string | null; // uploader; null for room items
  kind: 'text' | 'file';
  text: string | null;
  filename: string | null; // sanitized display/download filename
  mime: string | null; // untrusted original MIME; never use to inline arbitrary data
  size: number; // original UTF-8 text/file bytes
  hasThumbnail: boolean;
  createdAt: number;
  expiresAt: number;
}
```

Example screenshot/file upload (XHR may be used for progress):

```ts
await fetch(`/api/spaces/${spaceId}/items/file`, {
  method: 'POST', credentials: 'same-origin',
  headers: {'Content-Type': file.type || 'application/octet-stream',
    'X-File-Name': encodeURIComponent(file.name)},
  body: file,
});
```

Images claimed as JPEG/PNG/WebP/GIF/AVIF are decoded with a 16-megapixel limit and
re-encoded for the thumbnail; malformed or oversized raster images return 415.
GIF preview uses the first frame. SVG/HTML and all other files are accepted for
**download only**, never inline-previewed or run. Clipboard text must be rendered
as a React text child / `textContent`, never HTML. Do not fetch arbitrary URLs from
text or original file MIME. Use only the thumbnail endpoint for image previews.

User quota counts all original text/file bytes **plus thumbnail bytes** uploaded
by that user across spaces. Room quota counts all entries in that room. Limits
are checked atomically after streaming, so concurrent uploads cannot overdraw a
quota; failed uploads are deleted. Entries per space are capped at `MAX_ITEMS`
(temporary rooms at min(100, MAX_ITEMS)). Listings/snapshots are complete and
bounded by this count; there is no pagination in MVP.

## WebSocket protocol and reconnect

Select `ws:`/`wss:` from the page's scheme:

```ts
const url = new URL(`/api/spaces/${spaceId}/ws`, location.href);
url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(url); // same-origin cookie sent by browser
```

Server → client JSON messages:

```ts
type Message =
  | {type: 'snapshot'; items: Item[]; serverTime: number; expiresAt: number | null}
  | {type: 'item.created'; item: Item}
  | {type: 'item.deleted'; id: string};
```

On **every** connection, replace the local list with the first `snapshot`, then
apply created events by upserting `item.id` and deleted events by removing `id`.
This reconciles entries created/deleted/expired while offline. Reconnect using
exponential backoff with jitter (e.g. 0.5s, 1s, 2s … max 30s), then consume the new
snapshot. Alternatively, `GET base/items` is an authoritative HTTP refresh. The
backend does not run browser reconnection code. Display expiry using serverTime;
refresh/suppress stale items on expiry. Stop retries after 401/403/404, logout or
known room expiry; require user login/join again.

Sockets accept no client data messages (close 1008); HTTP performs all writes.
Invalidated sessions/disabled users/expired rooms close sockets with code 1008.
Time-based authorization is checked every second and before each broadcast;
logout/disable explicitly revalidate immediately. Limits: 8 sockets per IP and
account, 256 total; slow consumers close 1013, shutdown 1001. Ping/pong checks run
every 30s. Writes/withdrawals/expiry send events to the same authorized channel.

## Error contract

```json
{"error":{"code":"QUOTA_EXCEEDED"}}
```

| HTTP | Codes / frontend action |
| --- | --- |
| 400 | `INVALID_INPUT`, `INVALID_JSON`, `JSON_REQUIRED`, `EMPTY_TEXT`, `EMPTY_FILE`, `UPLOAD_TIMEOUT`, `INVALID_FILENAME`, `OAUTH_STATE_INVALID`, `OAUTH_DENIED`, `OAUTH_PROVIDER_ERROR` |
| 401 | `UNAUTHENTICATED` → login |
| 403 | `FORBIDDEN`, `ORIGIN_REJECTED`, `USER_DISABLED`, `INVITATION_REQUIRED`, `INVITE_INVALID`, `VERIFIED_EMAIL_REQUIRED` |
| 404 | `NOT_FOUND`, `PROVIDER_UNAVAILABLE` |
| 409 | `LAST_ADMIN` |
| 413 | `BODY_TOO_LARGE`, `TEXT_TOO_LARGE`, `FILE_TOO_LARGE`, `QUOTA_EXCEEDED`, `ITEM_LIMIT` → show configured limit |
| 415 | `INVALID_IMAGE` → unsupported/corrupt/too many pixels |
| 429 | `RATE_LIMITED`, `UPLOAD_BUSY`, `SOCKET_LIMIT`; HTTP responses have integer `Retry-After` seconds |
| 500 | `INTERNAL_ERROR` → retry/report; no secrets or internals returned |

Rate windows default to 60s; limits are enforced separately by trusted client IP
and authenticated account. General: 240; auth: 20; invite: 10; upload/write: 30;
room create/write: 10; room access: 30. Auth also limits the verified provider identity across IPs. Limits are per process (MVP is one instance).
Missing Origin is rejected for writes, including command-line calls. With no
`TRUST_PROXY`, forwarding headers are ignored. When configured, CIDRs are walked
from the actual socket through X-Forwarded-For; the first untrusted hop is client IP.

## Storage and operations

SQLite uses WAL and versioned atomic migrations. Store the database and files on
a persistent local volume at `DATA_DIR`. Backup the SQLite database using SQLite's
backup API (or stop the service and copy the whole data directory), not by copying
the live `.sqlite` file alone. File storage and broadcasting are injected interfaces;
SQL remains in `SqliteRepository`. Avoid multiple server instances sharing these
files or database; distributed storage/broadcasting is outside MVP.

The server rejects expired content immediately even before periodic cleanup.
Maintenance removes database entries and queues deletion of file/thumbnail keys
transactionally. Failed deletions remain queued for retry. Unreferenced files from
an interrupted upload are reclaimed after one hour, excluding active uploads.
Normal failed uploads are removed immediately. Expired bytes are released from
quota during cleanup. `/healthz` returns `{status:'ok'}`.

OAuth setup: create a GitHub OAuth App (`read:user user:email`) and a Google OAuth
Web client (`openid email profile`). Register exact callback URLs
`<APP_ORIGIN>/api/auth/github/callback` and `<APP_ORIGIN>/api/auth/google/callback`.
Set client ID/secret only through environment variables. No real credentials are
needed for the automated tests. Flow references:
[GitHub OAuth web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).

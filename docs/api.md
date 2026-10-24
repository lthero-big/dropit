# dropit backend API

Same-origin HTTP API under `/api`; all responses are JSON except downloads,
thumbnails, media previews, OAuth redirects and empty `204` responses. Dates are Unix milliseconds;
sizes are bytes. Browsers use the server session cookie (`credentials: 'same-origin'`);
CLI clients use personal access tokens (PATs) in `Authorization: Bearer <token>`.
There are no passwords, CORS origins or public mock logins.

Cookie and anonymous POST/PATCH/DELETE requests require `Origin: <APP_ORIGIN>`
(also for rooms/logout). A valid Bearer token bypasses Origin checking, including
WebSocket upgrades. Any Authorization header selects Bearer authentication: malformed,
expired or revoked credentials return 401 even if a valid cookie is also present.
Cookies never add authority to a Bearer request. Tokens in URLs are not accepted.
The only unauthenticated machine exceptions are the two device endpoints below.
JSON requests require `Content-Type: application/json`. Failed authorization of a
known authenticated space and an unknown space both return `404 NOT_FOUND`.
Missing/expired/revoked session returns `401 UNAUTHENTICATED`.

## Authentication and invitations

| Method | Path | Response / request |
| --- | --- | --- |
| GET | `/auth/providers` | `{providers: ['github','google']}`; only configured providers appear |
| GET | `/auth/:provider?invite=:token` | Navigate the browser here; 302 to OAuth provider, sets flow-binding cookie. Optional invite is bound to this flow when it is still valid. Once any user exists, an invalid invite redirects to `{APP_ORIGIN}/login?error=INVITE_INVALID` and does not start a flow. While the users table is empty, an invalid invite is ignored and the flow starts without it, so the first sign-up can still proceed. Unknown provider names stay JSON `404`. Auth-start rate limits stay JSON `429` with `Retry-After`. |
| GET | `/auth/:provider/callback` | OAuth-only callback; state, browser cookie and PKCE required; sets session and redirects to `{APP_ORIGIN}/`. Browser-visible failures redirect to `{APP_ORIGIN}/login?error=CODE`. The code is one of `OAUTH_STATE_INVALID`, `OAUTH_DENIED`, `OAUTH_PROVIDER_ERROR`, `INVITE_INVALID`, `INVITATION_REQUIRED`, `USER_DISABLED`, `VERIFIED_EMAIL_REQUIRED`, `RATE_LIMITED`, `INTERNAL_ERROR`. Provider error text is not copied into the URL. |
| POST | `/auth/logout` | 204; immediately revokes this session, closes its sockets and clears cookie |
| GET | `/me` | `{user, usedBytes, quotaBytes, maxFileBytes, maxTextBytes, retentionMs}` |
| GET | `/invites/:token` | `{spaceName, expiresAt, remainingUses}`; invalid/revoked/used/expired: 404 |

`User = {id, email, name, role: 'admin'|'user', disabled: 0|1, pending: 0|1, createdAt}`.
`pending` is 1 until the first verified OAuth identity is bound. The invite page does
**not** create an account or consume a use. It sends the token to the OAuth start URL.
Only a successful verified OAuth identity can atomically consume a use, create an
account/private space and join the invited space. Existing members do not spend
additional uses on the same still-valid invitation. Existing users may sign in
without an invite. A consumed/expired token is never accepted, even if the user
previously joined through it. OAuth state is single-use and valid for 10 minutes.
Starting a new flow replaces the browser's previous flow cookie.

## Personal access tokens

PATs contain 256 random bits, encoded as 43 base64url characters. Only SHA-256
digests are stored. Raw tokens appear once in the creation/claim response; list,
rename and revocation responses never contain a raw token or its digest. Responses
are `Cache-Control: no-store`. Never log or put credentials in a URL.

| Method | Path | Body / response |
| --- | --- | --- |
| POST | `/tokens` | **Browser session + Origin only.** `{name, scopes?: ['read','write'], expiresInDays?: 90}` → 201, `Token & {token}`. Name: nonblank, max 80 characters. Scopes: a nonempty unique subset of `read`, `write`. Expiry: integer 1–3650 days, or `null` for never. |
| GET | `/tokens` | Own `{tokens: Token[]}`; browser session or Bearer with `read`. Includes revoked/expired metadata. |
| PATCH | `/tokens/:id` | **Browser session + Origin only.** `{name}` → 204; owner only. |
| DELETE | `/tokens/:id` | 204; owner only; browser + Origin or Bearer with `write`. |
| GET | `/admin/tokens?userId=` | Admin only; `{tokens: Token[]}`, optionally filtered by user. |
| DELETE | `/admin/tokens/:id` | Admin only; 204; revoke any user's token. |

`Token = {id,userId,name,scopes:('read'|'write')[],createdAt,lastUsedAt:number|null,
expiresAt:number|null,revoked:0|1}`. Last use is recorded when authenticating an HTTP
request or WS upgrade. GET/HEAD/OPTIONS (including WS) need `read`; mutations need
`write` (`403 INSUFFICIENT_SCOPE`). Scopes are independent; the default grants both.
PATs cannot mint PATs, rename tokens, or approve/deny devices
(`403 BROWSER_SESSION_REQUIRED`), even when accompanied by a browser cookie.
All existing membership, item ownership, quotas, IP/account limits and admin role
checks apply to PATs. There is also a separate `RATE_TOKEN` bucket for each token.
Revocation/disable immediately rejects further requests and closes established
sockets with 1008. Disable permanently revokes that user's existing PATs; enabling
the account does not revive them. Token expiry is checked on requests and socket
revalidation (every second and before broadcasts). Cookie logout/session revocation
does not revoke PATs. Bearer `POST /auth/logout` revokes the current PAT and leaves
browser cookies alone; this call requires `write` (a read-only CLI can discard its
local token and revoke it in the browser).

## Device authorization (CLI login)

Use JSON. The device application does not need a client secret. No new user is
created here; the person approving must already have a valid OAuth-backed session.

| Method | Path | Body / response |
| --- | --- | --- |
| POST | `/auth/device/authorize` | `{name, scopes?, expiresInDays?}` (same validation/defaults as PAT creation) → 200, `{device_code,user_code,verification_uri,verification_uri_complete,verification_id,expires_in:600,interval:5}`. |
| POST | `/auth/device/token` | `{device_code}` → 200, `{access_token,token_type:'Bearer',scope:'read write',expires_in:number|null,token:Token}` once approved. `scope` reflects the actual requested scopes; expiry starts at claim time. |
| GET | `/auth/device?user_code=ABCD-EFGH&verification_id=...` | **Browser session only.** `{name,ipSummary,scopes,expiresAt,tokenExpiresInDays:number|null}` for the pending request. No device secret or full IP is exposed. |
| POST | `/auth/device/approve` | **Browser session + Origin only.** `{user_code,verification_id?}` → 204; approves for the current user. |
| POST | `/auth/device/deny` | **Browser session + Origin only.** Same body → 204; permanent denial. |

Only authorize and token accept no Origin **when no session cookie is present**.
If Origin is sent, it must match APP_ORIGIN unless authenticating with a PAT.
Cookie-only requests retain the usual Origin rule. Neither endpoint sets cookies.
Application/validation/rate errors use the ordinary error envelope below.

The `verification_uri` is `{APP_ORIGIN}/device`. The complete URI carries only the
short user code and a public `verification_id`; it must never carry `device_code`.
The browser confirmation UI at `/device` (also embedded on `/settings`) displays the requested
device name, IP summary, scopes and lifetime before asking the user to allow it.
Preserve both query parameters across login. The device code is 256 random bits
and held only by the CLI. The user code is 8 random uppercase letters/digits,
excluding I/L/O/0/1, displayed with a hyphen. Input is case insensitive and accepts
spaces/hyphens. Both codes are stored only as SHA-256 digests. Requests expire
after 10 minutes. Approval alone does not create a PAT: successful claim does so
atomically and consumes the device code. Lost claim responses cannot be replayed;
restart device login and revoke the unused token in settings.

Polling protocol errors are HTTP 400 with a **string** `error`, for example
`{"error":"authorization_pending"}`. Wait at least `interval` seconds **before the
first poll and between polls**. Early polling returns
`{"error":"slow_down","interval":10}` and increases this flow's interval by five
seconds on every early poll. Use the returned interval for every subsequent poll.
Pending requests return `authorization_pending`; denied requests return
`access_denied`; expired, unknown and consumed codes return `expired_token`.
Stop on success, denial or expiry. HTTP 429 uses `Retry-After`.

Creation is limited by RATE_AUTH per IP, polling by RATE_GENERAL per IP, and browser
confirmation/decisions to five requests per account and IP per rate window.
The complete link's public verification_id binds typo attempts to one flow:
five incorrect codes permanently invalidate it (`access_denied` to the CLI).
Manual code entry may omit verification_id; unknown codes return uniform 404 and
are bounded by the account/IP limit because no flow can be identified. Expired,
already decided, locked and unknown confirmation requests return uniform 404.

When the users table is empty, the first successfully authenticated identity
becomes admin. That holds when `ADMIN_EMAILS` is unset and when the address is
not on the list. A missing, expired, or unknown invite does not block this
sign-up. The empty-table check and the insert run in one `BEGIN IMMEDIATE`
transaction, so two concurrent first logins create exactly one admin. The other
login is `INVITATION_REQUIRED`. `ADMIN_EMAILS` is optional and additive: a later
new identity whose provider-verified email matches is also created as admin.
Every other new identity requires an invite. Provider identities remain
separate; we do not silently link GitHub and Google accounts by email. No
provider access/refresh token is stored.

## Administration

All paths here require an enabled admin, otherwise 401/403.

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/admin/users` | `{users: [User & {usedBytes, quotaBytes, quotaOverride}]}`. `quotaBytes` is the effective quota. `quotaOverride` is the stored override, or `null` when the installation default applies. |
| POST | `/admin/users` | `{email, name?: string, role?: 'admin' or 'user', quotaBytes?: number}` → 201, `User & {usedBytes, quotaBytes, quotaOverride}`. Pre-creates a pending account and its private space. No password and no invite token. The first later OAuth login whose **verified** email matches (case-insensitive) binds that identity, clears `pending`, and does not create a second user or space. A different provider subject with the same email is not linked and still needs an invite or admin bootstrap. Email must not already belong to any user (`409 EMAIL_IN_USE`). `ADMIN_EMAILS` matches are stored as `admin`. `quotaBytes` when omitted is the installation default (`quotaOverride: null`); when set, 1 byte through 100 GiB. |
| PATCH | `/admin/users/:id` | At least one of `{disabled?: boolean, role?: 'admin'\|'user', name?: string, quotaBytes?: number\|null}` → 204. `quotaBytes: null` clears the override. Disabling immediately revokes every session/socket. Enabling requires a new login. Role and quota apply to the next request on existing sessions. The last enabled admin cannot be disabled or demoted (`409 LAST_ADMIN`). Email cannot be changed. |
| POST | `/admin/users/:id/logout` | 204. Deletes every session for that user and closes their sockets. The account stays enabled; they can sign in again. Unknown id: `404`. |
| GET | `/admin/limits` | Read-only installation limits from the environment: `{maxFileBytes, maxTextBytes, maxItems, userQuotaBytes, retentionMs, roomQuotaBytes, roomMaxFileBytes, roomRetentionMs, rateWindowMs, rateGeneral, rateAuth, rateInvite, rateUpload, rateRoom, sessionMs}`. There is no write API; change the environment and restart. |
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
| PATCH | `base/items/:id` | `{text:string}` → 200 `{item:Item}`. Text only. Same blank and size rules as create. `createdAt` and `expiresAt` stay; `updatedAt` becomes the edit time. Quota counts `newSize - oldSize` and always allows a shrink. Spaces: the author only (`403` for anyone else, including the space owner). Rooms: any current capability holder. Files return `400 INVALID_INPUT`. Unknown id or another space returns `404`. |
| PATCH | `base/items/:id/labels` | `{pinned?: boolean, tags?: string[]}` → 200 `{item:Item}`. At least one field. Replaces the tag list when `tags` is sent; omitted `tags` leaves them. Does not change `createdAt`, `updatedAt`, text, or quota. Spaces: item author or space owner. Rooms: any current capability holder. A tag is 1–24 characters after trimming and stripping a leading `#`, with no whitespace or commas, at most 8 unique tags. |
| POST | `base/items/file` | **Raw binary body**, original type in `Content-Type`, filename in `X-File-Name: encodeURIComponent(name)` → 201 `{item:Item}` |
| GET | `base/items/:id/download` | Raw bytes, `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`. `Accept-Ranges: bytes`; single `Range` supports resume (206/416). |
| GET | `base/items/:id/thumbnail` | Sanitized, re-encoded `image/webp` up to 320×320; 404 if no thumbnail |
| GET | `base/items/:id/media` | Inline video or audio after a magic-byte allowlist. `Content-Type` is the sniffed type, never the upload header. `Accept-Ranges: bytes`; a single `Range` returns `206` or `416`. SVG, HTML, images and unknown bytes are `404`. `Content-Disposition: inline`, `nosniff`. |
| DELETE | `base/items/:id` | 204; retract entry and stored file/thumbnail. In spaces, sender or space owner only; in rooms, every capability holder may retract. |
| POST | `base/items/:id/shares` | `{expiresIn:'1h'\|'1d'\|'7d'\|'never', maxViews?: number\|null}` → 201 `{id,itemId,expiresAt,maxViews,views,revoked,createdAt,token,url}`. `maxViews` null or omitted is unlimited; otherwise 1–100 (`1` is one-time). Same manager as retract: item author or space owner; any current room capability. |
| GET | `base/items/:id/shares` | `{shares:[Share]}`. No token. Same manager as create. |
| DELETE | `base/shares/:shareId` | 204; immediate revocation. Same manager as create. |

`Share = {id,itemId,expiresAt:number|null,maxViews:number|null,views,revoked:0|1,createdAt}`.
The raw token is returned only at creation (`url` is `{APP_ORIGIN}/s/{token}`). Only its SHA-256
is stored. Unknown, expired, revoked, exhausted and malformed tokens are all `404 NOT_FOUND`.
There is no list, search or enumeration endpoint for tokens.

## Public share links

No session cookie. `GET` only. Rate-limited per IP and per token. A link never outlives its
clip: item retention, room expiry and retraction all make the link `404`. `expiresIn:'never'`
means the link itself has no extra deadline.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/s/:token` | `{item,linkExpiresAt,views,maxViews,access}`. Consumes one view. `item` is `{kind,text,filename,mime,size,hasThumbnail,createdAt,expiresAt,pinned,tags}` with no ids. `access` authorizes file, thumbnail and media requests for 10 minutes without a second view. |
| GET | `/s/:token/file?access=` | Raw bytes, `application/octet-stream`, attachment, `nosniff`; single Range (206/416). A valid unexpired `access` does not consume another view. Without `access`, this request consumes one view and returns a new ticket in `X-Share-Access` and a resumable URL in `Content-Location`. Reuse that ticket for all later ranges of this download. |
| GET | `/s/:token/thumbnail?access=` | Sanitized `image/webp`, or 404. Same view rules as the file route. |
| GET | `/s/:token/media?access=` | Same sniffed inline media and `Range` behavior as the member media route. Same view rules as the file route. |

The second metadata read of a one-time link is `404`. Refreshing the page counts as another view.
Repeated ranges with the same unexpired access ticket spend no extra views, including
416 retries. Each new unticketed request is a new view. Tickets expire in ten minutes
and stop working immediately on link revocation/item removal/expiry. The existing
single-ticket-per-share policy remains: a new metadata/direct open replaces its ticket.

For downloads, `Range: bytes=START-END`, `bytes=START-` and `bytes=-SUFFIX` are
supported. A satisfiable range returns 206 with Content-Range/Content-Length;
out-of-bounds/reversed ranges return 416 with `Content-Range: bytes */SIZE`.
Malformed/unsupported units and multiple ranges are ignored (full 200).
Authorization is checked before range processing. HEAD returns corresponding
headers without the body. Download endpoints retain attachment + nosniff on 206/416.

`WS base/ws` is read-only: spaces need a session cookie with exact Origin, or a
Bearer token with `read`. Anonymous rooms still require exact Origin; a Bearer
request to a room is also checked for scope, expiry, disable and revocation.

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
  updatedAt: number; // equals createdAt until the text is edited in place
  expiresAt: number;
  pinned: boolean; // pinned clips sort ahead of unpinned clips; createdAt order is unchanged inside each group
  tags: string[]; // 0–8 labels, each 1–24 characters, no whitespace
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
GIF preview uses the first frame. Image previews use only the thumbnail endpoint.
SVG and HTML are accepted for **download only** and are never inline-previewed,
even when the client sends `video/*` or a media filename. Video and audio
previews use `/media` only after the stored bytes match an allowlist (MP4,
QuickTime, WebM, Ogg, WAV, MP3, FLAC). The response type comes from those bytes.
Clipboard text is plain text by default. A markdown toggle may render a fixed
subset (headings, lists, quotes, code, emphasis, `http`/`https` links) as React
elements. It does not parse raw HTML, images, or other URL schemes. Do not fetch
arbitrary URLs from text or the original file MIME.

User quota counts all original text/file bytes **plus thumbnail bytes** uploaded
by that user across spaces. The limit is that user's `quotaOverride` when set,
otherwise `USER_QUOTA_BYTES` (also returned as `quotaBytes` on `GET /me`).
Lowering a quota does not delete existing entries; further uploads and text
edits that grow past the limit fail with `QUOTA_EXCEEDED` until usage drops
below the new limit. Shrinking a text item is always allowed. Room quota counts all
entries in that room and is not affected by per-user overrides. Limits
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

Node CLI clients can use `new WebSocket(url, {headers: {Authorization: 'Bearer ' +
token}})` from `ws`; Origin is optional for a valid PAT. Never send the PAT as a
query parameter or WebSocket subprotocol. Native browser WebSocket continues to
use cookies and the existing Origin requirement.

Server → client JSON messages:

```ts
type Message =
  | {type: 'snapshot'; items: Item[]; serverTime: number; expiresAt: number | null}
  | {type: 'item.created'; item: Item}
  | {type: 'item.updated'; item: Item}
  | {type: 'item.deleted'; id: string}
  | {type: 'presence'; devices: number};
```

`presence.devices` is the number of open sockets on this space or room. It is
sent after the snapshot and again when a socket leaves. It carries no names or
addresses. On **every** connection, replace the local list with the first `snapshot`, then
apply created and updated events by upserting `item.id` (pinned clips stay above the others, then `createdAt`)
and deleted events by removing `id`. `presence` does not change the list.
This reconciles entries created, edited, deleted or expired while offline. Reconnect using
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

OAuth start and callback navigations are the exception: browser-visible failures
redirect to `/login?error=CODE` instead of this JSON body. Unknown provider names
and auth-start rate limits still use JSON.

| HTTP | Codes / frontend action |
| --- | --- |
| 400 | `INVALID_INPUT`, `INVALID_JSON`, `JSON_REQUIRED`, `EMPTY_TEXT`, `EMPTY_FILE`, `UPLOAD_TIMEOUT`, `INVALID_FILENAME`, `OAUTH_STATE_INVALID`, `OAUTH_DENIED`, `OAUTH_PROVIDER_ERROR` |
| 401 | `UNAUTHENTICATED` → login |
| 403 | `FORBIDDEN`, `ORIGIN_REJECTED`, `USER_DISABLED`, `INVITATION_REQUIRED`, `INVITE_INVALID`, `VERIFIED_EMAIL_REQUIRED` |
| 403 | `INSUFFICIENT_SCOPE`, `BROWSER_SESSION_REQUIRED` for PATs |
| 404 | `NOT_FOUND`, `PROVIDER_UNAVAILABLE` |
| 416 | Download/media range unsatisfiable; Content-Range contains `bytes */SIZE` |
| 409 | `LAST_ADMIN`, `EMAIL_IN_USE` |
| 413 | `BODY_TOO_LARGE`, `TEXT_TOO_LARGE`, `FILE_TOO_LARGE`, `QUOTA_EXCEEDED`, `ITEM_LIMIT` → show configured limit |
| 415 | `INVALID_IMAGE` → unsupported/corrupt/too many pixels |
| 429 | `RATE_LIMITED`, `UPLOAD_BUSY`, `SOCKET_LIMIT`; HTTP responses have integer `Retry-After` seconds |
| 500 | `INTERNAL_ERROR` → retry/report; no secrets or internals returned |

Rate windows default to 60s; limits are enforced separately by trusted client IP
and authenticated account. General: 240; auth: 20; invite: 10; upload/write: 30;
room create/write: 10; room access: 30. Auth also limits the verified provider identity across IPs. Limits are per process (MVP is one instance).
Missing Origin is rejected for cookie/anonymous writes; valid PATs and the two
cookie-free device endpoints follow the machine rules above. PATs have an additional
120 requests/token/window by default (`RATE_TOKEN`). With no
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

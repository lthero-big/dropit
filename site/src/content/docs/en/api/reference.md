---
title: API contract
description: The authoritative HTTP API and WebSocket contract.
---

Same-origin HTTP API under `/api`; all responses are JSON except downloads,
thumbnails, image/media previews, OAuth redirects and empty `204` responses. Dates are Unix milliseconds;
sizes are bytes. Browsers use the server session cookie (`credentials: 'same-origin'`);
CLI clients use personal access tokens (PATs) in `Authorization: Bearer <token>`.
There are no CORS origins or public mock logins. Passwords are optional per account (scrypt, see “Password sign-in and first run”).

Cookie and anonymous POST/PUT/PATCH/DELETE requests require `Origin: <APP_ORIGIN>`
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
| GET | `/auth/providers` | `{providers: ['github','google'], password: true, registration: 'invite', setupRequired: false}`; only configured OAuth providers appear |
| GET | `/auth/:provider?invite=:token` | Navigate the browser here; 302 to OAuth provider, sets flow-binding cookie. Optional invite is bound to this flow when it is still valid. Once any user exists, an invalid invite redirects to `{APP_ORIGIN}/login?error=INVITE_INVALID` and does not start a flow. While the users table is empty, an invalid invite is ignored and the flow starts without it, so the first sign-up can still proceed. Unknown provider names stay JSON `404`. Auth-start rate limits stay JSON `429` with `Retry-After`. |
| GET | `/auth/:provider/callback` | OAuth-only callback; state, browser cookie and PKCE required; sets session and redirects to `{APP_ORIGIN}/`. Browser-visible failures redirect to `{APP_ORIGIN}/login?error=CODE`. The code is one of `OAUTH_STATE_INVALID`, `OAUTH_DENIED`, `OAUTH_PROVIDER_ERROR`, `INVITE_INVALID`, `INVITATION_REQUIRED`, `REGISTRATION_CLOSED`, `USER_DISABLED`, `VERIFIED_EMAIL_REQUIRED`, `RATE_LIMITED`, `INTERNAL_ERROR`. Provider error text is not copied into the URL. |
| POST | `/auth/logout` | 204; immediately revokes this session, closes its sockets and clears cookie |
| GET | `/me` | `{user, hasPassword, mustChangePassword, usedBytes, reservedBytes, quotaBytes, maxFileBytes, maxTextBytes, retentionMs}` |
| GET | `/invites/:token` | `{personal, spaceName \| null, inviterName?, expiresAt, remainingUses}`; `personal: true` is a user-created invitation that only opens registration (no space is joined). Invalid/revoked/used/expired: 404 |

`User = {id, email, name, role: 'admin'|'user', disabled: 0|1, pending: 0|1, createdAt}`.
`pending` is 1 until the first verified OAuth identity is bound or the first password sign-in. The invite page does
**not** create an account or consume a use. It sends the token to the OAuth start URL.
Only a successful verified OAuth identity can atomically consume a use, create an
account/private space and join the invited space. Existing members do not spend
additional uses on the same still-valid invitation. Existing users may sign in
without an invite. A consumed/expired token is never accepted, even if the user
previously joined through it. OAuth state is single-use and valid for 10 minutes.
Starting a new flow replaces the browser's previous flow cookie.

## Password sign-in and first run (RHEA-190 auth step 2)

| Method | Path | Response / request |
| --- | --- | --- |
| GET | `/setup` | `{required, providers}`; `required` is true only while no account exists |
| POST | `/setup` | `{code, email, password, name?}` → 201 `{user, mustChangePassword:false}` and a session cookie. Creates the first **admin**. `code` is the one-time `dropit setup code: XXXX-XXXX` printed in the server log at startup (case, dashes and spaces ignored). Wrong code `403 SETUP_CODE_INVALID`; already set up `409 SETUP_DONE`; rate limited per IP (`RATE_AUTH`) and globally (`5 × RATE_AUTH`) per window |
| POST | `/auth/password/login` | `{email, password, invite?}` → `{user, mustChangePassword}` and a session cookie. Unknown email and wrong password both return `401 INVALID_CREDENTIALS` (the hash is always computed). `USER_DISABLED` only after a correct password. Rate limited per IP and per email (`RATE_AUTH`). A valid `invite` joins its space; a pre-created (pending) account becomes active |
| POST | `/auth/password/register` | `{email, password, name?, invite?}` → 201 `{user}` and a session. Subject to the registration policy: `closed` → `403 REGISTRATION_CLOSED`; `invite` (default) needs a valid invite (`403 INVITATION_REQUIRED` / `INVITE_INVALID`); `open` accepts anyone. Always a normal user (never admin, `ADMIN_EMAILS` does not apply because the email is not verified). An email already used by any account `409 EMAIL_IN_USE`. Before `/setup` `409 SETUP_REQUIRED` |
| PUT | `/me/password` | Browser session only. `{currentPassword?, newPassword}` → `{hasPassword:true, mustChangePassword:false, revokedSessions}`. `currentPassword` is required when the account already has a password (`400 CURRENT_PASSWORD_INVALID`, `PASSWORD_UNCHANGED`); an OAuth-only account can add one without it. Other sessions of the account are revoked |
| POST | `/admin/users/:id/password` | Admin browser session. → `{temporaryPassword, mustChangePassword:true}`. Shown once. Revokes that user's sessions; the next sign-in must change it |
| GET / PUT | `/admin/registration` | `{policy:'closed'|'invite'|'open', default:'invite', userInvites:{enabled, defaultLimit}, updatedAt, updatedBy}`; PUT `{policy?, userInvites?: {enabled?: boolean, defaultLimit?: 0–1000}}` (at least one). `userInvites` controls whether normal users may create personal invitations (default on, 5 each). |

`GET /auth/providers` also returns `password: true`, `registration` (the policy) and
`setupRequired`. `GET /me` adds `hasPassword` and `mustChangePassword`; `GET /admin/users`
adds `hasPassword`, `mustChangePassword` and `providers` per user. `POST /admin/users` accepts
`temporaryPassword: true` and then returns the generated `temporaryPassword` once.

Passwords are 8–256 characters, NFKC-normalised, stored as `scrypt$N$r$p$salt$hash`
(N=16384, r=8, p=1, 16-byte random salt, 64-byte key) and compared with
`timingSafeEqual`. While `mustChangePassword` is set, a **browser** session gets
`403 PASSWORD_CHANGE_REQUIRED` on everything except `/me`, `/me/password`, `/auth/logout`,
`/auth/providers`, `/site`, `/version` and `/setup`; personal access tokens are not blocked
(revoke them in 设置 → 访问令牌 if a password was compromised). Password accounts can bind
GitHub / Google in 设置 → 登录方式, and with a password set the last OAuth identity can be unlinked.

Offline recovery: `docker exec dropit dropit-admin reset-password <email>` sets a
temporary password (printed once), forces a change and signs the account out;
`dropit-admin list-users` lists accounts.

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
| PATCH | `/admin/users/:id` | At least one of `{disabled?: boolean, role?: 'admin'\|'user', name?: string, quotaBytes?: number\|null, inviteLimit?: number\|null}` → 204. `quotaBytes: null` clears the override. `inviteLimit` (integer 0–1000) is this user's personal-invite limit; `null` falls back to the site default. Disabling immediately revokes every session/socket. Enabling requires a new login. Role and quota apply to the next request on existing sessions. The last enabled admin cannot be disabled or demoted (`409 LAST_ADMIN`). Email cannot be changed. |
| POST | `/admin/users/:id/logout` | 204. Deletes every session for that user and closes their sockets. The account stays enabled; they can sign in again. Unknown id: `404`. |
| GET | `/admin/limits` | `{key: {value, default, overridden, min, max}}` for each of the 23 runtime limits below. `default` is the environment-derived value at process startup; `overridden` means a SQLite override exists (even if equal to the default). |
| PATCH | `/admin/limits` | Partial `{key: positiveInteger \| null}` → 200, same description map as GET. `null` removes that override. Requires an admin and browser Origin or a Bearer with `write` scope. The entire candidate is validated and all overrides/audit rows commit atomically. Empty objects, unknown/read-only keys, invalid types, ranges or cross-field policy → `400 INVALID_LIMITS`; no partial writes. |
| GET | `/admin/limits/audit?limit=50&cursor=123` | `{entries: LimitAudit[], nextCursor: number \| null}`; newest first. `limit`: integer 1–100 (default 50); optional `cursor`: positive integer, exclusive audit id from the preceding page's `nextCursor`. Invalid pagination → `400 INVALID_INPUT`. Read-only admin Bearers may read limits and audits. |
| GET | `/site` | Public. `{origin: string \| null, source: 'admin' \| 'env' \| 'request', requestOrigin}`: the pinned site address (APP_ORIGIN) if any and this request's own origin; the login page uses it to explain mismatches. |
| GET | `/admin/site` | Admin browser session. Site address view: `origin`, `source`, `adminOrigin`, `envOrigin`, `requestOrigin`, `effectiveOrigin`, `production`, `secureCookies`, `trustProxy`, `updatedAt`, `updatedBy`, `callbacks: [{provider, label, url}]`. |
| PUT | `/admin/site` | `{origin: string \| null, confirm?: boolean}`; `null`/`""` clears the admin value (falls back to env `APP_ORIGIN`, then the request origin). Admin browser session + Origin required. Not a bare origin → `400 INVALID_ORIGIN`; differs from the caller's Origin without `confirm: true` → `409 ORIGIN_CONFIRM_REQUIRED {origin, current}`. Applies immediately. `ORIGIN_REJECTED` errors carry `{expected, received, source}` next to `code`. |
| GET | `/admin/invites` | `{invites: [Invite]}` (no secret token); every invitation, including personal ones, with `status` (`open`/`used`/`expired`/`revoked`), `createdByEmail`, `joinSpace` |
| POST | `/admin/invites` | `{spaceId, maxUses?: 1, expiresInHours?: 24}` → 201, `Invite & {token,url}`. Uses: 1–100; expiry: 1–720 hours. Admin must belong to target space. |
| DELETE | `/admin/invites/:id` | 204; immediate revocation |

`Invite = {id, spaceId, maxUses, uses, expiresAt, revoked: 0|1, createdBy, joinSpace: 0|1, createdAt}`.
`joinSpace: 0` is a **personal invitation**: single use, only opens registration (the new account gets its
own private space and does not join the inviter's). It is spent only when it creates a new account, and a used
invitation can no longer be revoked (`409 INVITE_USED`). `registration: 'closed'` blocks personal invitations too.

### Personal invitations (any signed-in user)

| Method | Path | Response / request |
| --- | --- | --- |
| GET | `/me/invites` | `{enabled, limit, used, remaining, registration, invites: [{id, status, expiresAt, createdAt, ...}]}`; own invitations only. `limit` = per-user override or the site default (admins are not limited) |
| POST | `/me/invites` | `{expiresInHours?: 168}` (1–720) → 201 `{id, token, url, expiresAt}`. The token is shown once. `403 INVITES_DISABLED` when the admin switched it off; `409 INVITE_LIMIT_REACHED` at the limit. Browser session + Origin or a `write` Bearer |
| DELETE | `/me/invites/:id` | 204; revokes an unused invitation (frees one slot). Own invitations only; `404` otherwise, `409 INVITE_USED` when spent |

An invitation counts against the limit while it is used, or while it is neither revoked nor expired.
The invitation token is returned only at creation; share the returned URL securely.
Only its SHA-256 digest is stored. Expired/revoked invitation records may be removed
by maintenance. There is no arbitrary member-join endpoint.

### Runtime limit policy

Editable keys are `maxFileBytes`, `maxTextBytes`, `maxItems`, `userQuotaBytes`,
`retentionMs`, `roomQuotaBytes`, `roomMaxFileBytes`, `roomRetentionMs`,
`rateWindowMs`, `rateGeneral`, `rateAuth`, `rateInvite`, `rateUpload`, `rateRoom`,
`sessionMs`, `uploadChunkBytes`, `uploadChunkTimeoutMs`, `rateChunk`,
`uploadChunksPerSession`, `uploadChunksPerUser`, `uploadChunksGlobal`,
`uploadSessionsPerUser`, and `uploadSessionsGlobal`. All durations use milliseconds and sizes use bytes. See
[backend configuration](../../config/backend-config/#runtime-overrides-and-hard-ceilings)
for hard ceilings. `min`/`max` describe each key's absolute bounds; the complete
effective configuration must also satisfy:

- `roomMaxFileBytes < maxFileBytes`, `roomQuotaBytes < userQuotaBytes`.
- `roomRetentionMs <= retentionMs` and `roomRetentionMs <= 86400000` (24 hours).
- `rateAuth`, `rateInvite`, `rateUpload` each `< rateGeneral`; `rateRoom < rateUpload`.

Coupled changes may be sent in one PATCH, e.g.
`{"maxFileBytes":10485760,"roomMaxFileBytes":2097152}`. Resets are validated
against the other effective values too; reset coupled keys together if needed.
`{"maxFileBytes":null,"roomMaxFileBytes":null}` restores their environment defaults.
Secrets, origin, proxy configuration, paths, OAuth credentials, `rateToken`, and
all other startup settings cannot be changed or read through this API.

`LimitAudit = {id, actorId, actorEmail, createdAt, key, oldValue, newValue,
oldOverride: number|null, newOverride: number|null}`. `actorEmail` is captured at
change time; ids are monotonic and `createdAt` is epoch milliseconds. Each changed
override produces one row, including a reset or setting an explicit value equal
to the default. Repeating the same override or resetting an unset key is a no-op
and produces no row. Failed changes produce no rows. Audit pagination stays
stable when newer changes arrive between pages.

Successful changes apply immediately to subsequent requests, including `/me`,
space/room metadata, validation, quotas and rate limits. An upload already in
flight keeps its starting file-size limit; quota/item-count checks still use
the effective configuration at commit. Lowering quotas/counts/file sizes does
not delete existing content or block its download. Explicit per-user quotas
remain authoritative over `userQuotaBytes`.

Retention is assigned on creation: `retentionMs` affects new entries and
`roomRetentionMs` affects new rooms. Existing entry/room `expiresAt` timestamps
stay unchanged, including edits, pins and shares. Room entries are also bounded
by their room's existing expiry. No content is retroactively extended/deleted.
`sessionMs` affects only newly issued OAuth sessions/cookies, never existing
sessions, PATs, device flows or share links.

Rate thresholds use existing live counters immediately. A window-duration change
keeps each active bucket's count and original reset time; newly created buckets
use the new duration. Counters are not cleared by PATCH, even on no-ops/resets.
Rate counts remain per-process and reset on process restart.

## Spaces, temporary rooms, entries

`GET /spaces` → `{spaces: [{id,name,ownerId,expiresAt:null}]}`. Includes the
user's automatically created private space and spaces joined by invitation.

`POST /rooms` (no account required; body optional `{deviceKey?, code?, pin?}`) → 201,
`{token, expiresAt, url, reused, code, hasPin}`. **A room has exactly one code, and its link is `/r/<code>`**
(the code *is* the link; changing the code changes the link). The code is either random — **6 characters**
from an alphabet without look-alikes (no `0 O 1 l I`), case-sensitive — or a custom `code`
(`A–Z a–z 0–9 _ -`, 3–32 characters, case-sensitive). An optional `pin` (4–32 characters, stored as a scrypt
hash) works with random and custom codes alike. A taken code returns `409 CODE_TAKEN`; invalid values return
`400 INVALID_CODE` / `INVALID_PIN`. There is no room list, search or enumeration endpoint.
Authenticated users accessing a room still use the **room** quota, not user quota.

The code is **not** an API credential. `token` is an *access token* (`<id>.<proof>`): keep it, it is what the
room routes below accept. Anyone else turns the code into their own access token through `POST /rooms/enter`,
which checks the PIN (if set) and is rate limited — so opening `/r/<code>` and typing the code both require the
PIN. The room owner and anyone who entered before keep their access token, and are therefore **not asked for the
PIN again** when the owner sets or changes the PIN or the code.

| Method | Path | Body / response |
| --- | --- | --- |
| POST | `/rooms/enter` | `{code, pin?}` → `{token, expiresAt, code, hasPin, url}`. `404 NOT_FOUND` for unknown/expired codes, `401 PIN_REQUIRED`, `403 PIN_INVALID`, `429 RATE_LIMITED` with `Retry-After` after too many misses |
| GET | `/rooms/:room` | `{id, name, expiresAt, code, hasPin, url}` for an access token |
| PUT | `/rooms/:room/code` | Room owner only (device key), `{deviceKey, code?, pin?}` (at least one) → `{code, hasPin, url}`. `code: "<custom>"` sets a custom code, `code: null` or `""` draws a new random code; `pin: "<pin>"` sets/replaces the PIN, `pin: null` or `""` removes it; an omitted field stays as it is. `403` for non-owners, `409 CODE_TAKEN` |

Wrong codes and PINs are counted per client IP and per code with the `RATE_AUTH` budget.
**Old links:** rooms created before this version received a code when the database was migrated (schema 16:
every live room without a code gets a random 6-character code; rooms that already had a code keep it and its
PIN). Their 43-character `/rooms/<token>` links (and the token itself) keep working and the web app redirects
them to `/r/<code>`. Share links `/s/<token>` are unchanged (6 characters, older long links stay valid).

Set `base` to `/spaces/:spaceId` or `/rooms/:room` in the following table, where `:room` is an access token
from `POST /rooms` / `POST /rooms/enter` (or an old 43-character room token). A room code is not accepted there.
Space routes require membership; room routes require the unexpired capability.

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `base` | `{id,name,expiresAt,maxFileBytes,quotaBytes}` |
| GET | `base/items` | `{type:'snapshot', items:Item[], groups:string[], serverTime,expiresAt}`; current nonexpired entries, newest first |
| POST | `base/items/text` | `{text:string, group?:string\|null}` → 201 `{item:Item}`; nonblank UTF-8, max `MAX_TEXT_BYTES`. An unknown `group` name is created on the fly (see Groups). |
| PATCH | `base/items/:id` | `{text:string}` → 200 `{item:Item}`. Text only. Same blank and size rules as create. `createdAt` and `expiresAt` stay; `updatedAt` becomes the edit time. Quota counts `newSize - oldSize` and always allows a shrink. Spaces: the author only (`403` for anyone else, including the space owner). Rooms: any current capability holder. Files return `400 INVALID_INPUT`. Unknown id or another space returns `404`. |
| PATCH | `base/items/:id/labels` | `{pinned?: boolean, tags?: string[], group?: string\|null}` → 200 `{item:Item}`. At least one field. `group: null` (or `''`) moves the item out of its group. Replaces the tag list when `tags` is sent; omitted `tags` leaves them. Does not change `createdAt`, `updatedAt`, text, or quota. Spaces: item author or space owner. Rooms: any current capability holder. A tag is 1–24 characters after trimming and stripping a leading `#`, with no whitespace or commas, at most 8 unique tags. |
| POST | `base/items/file` | **Raw binary body**, original type in `Content-Type`, filename in `X-File-Name: encodeURIComponent(name)`, optional `X-Dropit-Group: encodeURIComponent(group)` → 201 `{item:Item}` |
| GET | `base/items/:id/download` | Raw bytes, `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`. `Accept-Ranges: bytes`; single `Range` supports resume (206/416). |
| GET | `base/items/:id/thumbnail` | Sanitized, re-encoded `image/webp` up to 320×320; 404 if no thumbnail |
| GET | `base/items/:id/preview` | Sanitized `image/webp`, longest edge 2048px, aspect preserved, no enlargement; only previously validated raster uploads. `Content-Disposition: inline`, `nosniff`, `Cache-Control: private, max-age=N` (at most 60 seconds, capped by item expiry). Nonmembers/unknown items/nonimages return 404. |
| GET | `base/items/:id/media` | Inline video or audio after a magic-byte allowlist. `Content-Type` is the sniffed type, never the upload header. `Accept-Ranges: bytes`; a single `Range` returns `206` or `416`. SVG, HTML, images and unknown bytes are `404`. `Content-Disposition: inline`, `nosniff`. |
| DELETE | `base/items/:id` | 204; retract entry and stored file/thumbnail. In spaces, sender or space owner only; in rooms, every capability holder may retract. |
| POST | `base/items/:id/shares` | `{expiresIn:'1h'\|'1d'\|'7d'\|'never', maxViews?: number\|null}` → 201 `{id,itemId,expiresAt,maxViews,views,revoked,createdAt,token,url}`. `maxViews` null or omitted is unlimited; otherwise 1–100 (`1` is one-time). Same manager as retract: item author or space owner; any current room capability. |
| GET | `base/items/:id/shares` | `{shares:[Share]}`. No token. Same manager as create. |
| DELETE | `base/shares/:shareId` | 204; immediate revocation. Same manager as create. |

| GET | `base/groups` | `{groups:string[]}` in creation order |
| POST | `base/groups` | `{name}` → 201 `{groups}`. `409 GROUP_EXISTS`, `409 GROUP_LIMIT` (24 max), `400 INVALID_GROUP` |
| PATCH | `base/groups/:name` | `{name}` → 200 `{groups}`; items in the group move with it. `404 GROUP_NOT_FOUND` |
| DELETE | `base/groups/:name` | 200 `{groups}`; its items become ungrouped (nothing is deleted) |

### Groups and device identity (RHEA-190 step 5)

Groups are per space / room named buckets (1–24 characters after trimming, no
control characters, not `全部` or `未分组`; at most 24). Every change is broadcast
as a `groups` WebSocket message. Same permission as reading and writing items.

Any item-creating request (`items/text`, `items/file`, `uploads/:id/complete`) may
carry the sending device so other devices can say where a clip came from:

| Header | Value |
| --- | --- |
| `X-Dropit-Device` | stable client id, `[A-Za-z0-9_-]{6,64}` |
| `X-Dropit-Device-Name` | `encodeURIComponent(name)`, up to 40 characters (e.g. `Mac · Chrome`) |
| `X-Dropit-Device-Kind` | `mac` \| `phone` \| `pad` \| `pc` \| `cli` (others fall back to `pc`) |
| `X-Dropit-Group` | `encodeURIComponent(group)` for binary uploads (text uses the body field) |

All are optional; malformed values are ignored rather than rejected, so old
clients behave exactly as before (`item.device` and `item.group` are `null`).

`Share = {id,itemId,expiresAt:number|null,maxViews:number|null,views,revoked:0|1,createdAt}`.
The raw token is returned only at creation (`url` is `{APP_ORIGIN}/s/{token}`). Only its SHA-256
is stored. Unknown, expired, revoked, exhausted and malformed tokens are all `404 NOT_FOUND`.
There is no list, search or enumeration endpoint for tokens.

## Resumable file uploads

Use the same `base` as items: `/spaces/:spaceId` or `/rooms/:roomToken`, under `/api`.
Cookie/Origin and Bearer scope rules match the existing file endpoint (PUT requires
`write`, GET requires `read`). Space sessions belong to their creating user, even
in a shared space; another member or the space owner cannot read, write, complete
or cancel them. Every holder of the current room capability may resume/cancel a
room upload. Invalid, expired, completed, cancelled, cross-user or wrong-base
upload ids return the same `404 NOT_FOUND`. There is no session-list endpoint.

| Method | Path | Body / response |
| --- | --- | --- |
| POST | `base/uploads` | JSON `{filename,size,mime}` → 201 `{uploadId,chunkSize,expiresAt,received:[]}`. Positive safe integer size; filename 1–4096 characters, MIME 1–200 characters. Rejects declared sizes above the current member/room file limit. |
| PUT | `base/uploads/:id/chunks/:index` | Raw bytes → 204. Zero-based integer index (no sign/leading zeros). Exactly `chunkSize` bytes, except the last chunk is exactly the remaining declared bytes. Any order; parallel requests allowed within limits. Optional `X-Chunk-SHA256` is 64 hexadecimal characters (case insensitive). |
| GET | `base/uploads/:id` | `{size,chunkSize,expiresAt,received:[index,…]}`. Sorted committed indices only; query after interruption/restart and send only the missing chunks. |
| POST | `base/uploads/:id/complete` | No body → 201 `{item:Item}` after all chunks, assembled length and media/quota validation. Creates exactly one ordinary item and broadcasts `item.created`. |
| DELETE | `base/uploads/:id` | 204; aborts active work, releases reservation and removes temporary chunks. Subsequent requests return 404. |

The default chunk size is **8 MiB**; it is fixed at creation for that upload.
The final partial chunk can be smaller. Retrying identical bytes for an existing
index succeeds without storing another copy. Different bytes for an existing
index return `409 CHUNK_CONFLICT` and retain the first copy. Invalid checksums
(`400 INVALID_CHECKSUM`), SHA mismatches (`400 CHECKSUM_MISMATCH`), short chunks
(`400 CHUNK_SIZE_MISMATCH`), oversized chunks (`413 FILE_TOO_LARGE`), stream
interruptions and `400 UPLOAD_TIMEOUT` leave the session available for retry;
failed chunks never appear in `received`. Checksum validation precedes duplicate
handling. Excess chunk concurrency returns `429 CHUNK_BUSY` with `Retry-After`.

Creation reserves the declared bytes **and one item slot** in a SQLite immediate
transaction. Pending bytes count against the creating user's aggregate quota
(or the room's quota); ordinary text/file creates and text growth count these
reservations too. They are not items and never appear in a board snapshot.
`GET /me` reports `reservedBytes` separately from stored `usedBytes`; available
bytes are `quotaBytes - usedBytes - reservedBytes`. Expiry is absolute 24 hours
from creation, capped by room expiry, and is never extended by activity. Expired
reservations stop counting immediately; maintenance queues/removes their files.
Disable and explicit cancellation also discard unfinished sessions, including
active writes. Restart retains sessions and received chunks on the data volume.

Complete streams chunks in index order without buffering the whole file. It uses
the same filename cleaning, raster decoder pixel ceiling (16 Mi pixels), thumbnail
generation and atomic quota checks as ordinary uploads. Magic bytes also trigger
raster validation in the session protocol even if MIME says octet-stream.
Thumbnail bytes count at commit in addition to the declared size; the reservation
is converted to actual storage atomically. Current quota/item/file limits apply
at complete. The new session protocol rejects SVG (also SVG disguised as a PNG)
and corrupt/oversized rasters with 415. Other unknown bytes remain download-only;
inline audio/video continues to require its separate magic-byte allowlist.
The legacy endpoint retains download-only SVG/HTML compatibility.

Calling complete before all chunks arrive returns `400 UPLOAD_INCOMPLETE` and
**discards the session**, as do assembled-size, decoder, quota and file-limit
failures: no item remains. Create a new session after these failures. Concurrent
complete/chunk work returns `409 UPLOAD_IN_PROGRESS` without discarding it; wait
for those requests before completing. A successful complete consumes the id;
query the ordinary item snapshot if its response was lost. A retry after success
returns 404, preventing duplicate items.

Each PUT has its own `uploadChunkTimeoutMs` deadline (default 120 seconds). There
is no total file deadline; legacy streaming uploads also have no 120-second total
request deadline. PUTs use independent `rateChunk` IP/account/PAT buckets (default
2000/window); they do **not** consume general, ordinary upload, room-access,
room-write or ordinary PAT request buckets. Thus a 100-chunk upload does not hit
`rateUpload`/`rateToken`. Session creation/completion still use the ordinary write
limits; session GET/DELETE use general (and room-access) limits.

Runtime limits also bound simultaneous chunks per upload/account/global (defaults
3/6/16) and unfinished sessions per account/global (8/128). Signed-in room users
share their account bucket with spaces; anonymous holders share the room bucket.
IP chunk rate and global concurrency/session caps also apply. Lowering caps keeps
existing work and rejects new work until below the new thresholds. See the
[configuration list](../../config/backend-config/#runtime-overrides-and-hard-ceilings).

## Public share links

No session cookie. `GET` only. Rate-limited per IP and per token. A link never outlives its
clip: item retention, room expiry and retraction all make the link `404`. `expiresIn:'never'`
means the link itself has no extra deadline.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/s/:token` | `{item,linkExpiresAt,views,maxViews,access}`. Consumes one view. `item` is `{kind,text,filename,mime,size,hasThumbnail,createdAt,expiresAt,pinned,tags}` with no ids. `access` authorizes file, thumbnail, image preview and media requests for 10 minutes without a second view. |
| GET | `/s/:token/file?access=` | Raw bytes, `application/octet-stream`, attachment, `nosniff`; single Range (206/416). A valid unexpired `access` does not consume another view. Without `access`, this request consumes one view and returns a new ticket in `X-Share-Access` and a resumable URL in `Content-Location`. Reuse that ticket for all later ranges of this download. |
| GET | `/s/:token/thumbnail?access=` | Sanitized `image/webp`, or 404. Same view rules as the file route. |
| GET | `/s/:token/preview?access=` | Same sanitized 2048px WebP as the member/room preview route; inline, nosniff, `Cache-Control: no-store`. Same view accounting as thumbnail: valid `access` spends no additional view; without valid access, consumes one view. Expired/revoked/exhausted links return 404 (an existing unexpired ticket can still read an exhausted link). |
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
  group: string | null; // demo-style group, null when ungrouped
  device: {id: string; name: string; kind: 'mac' | 'phone' | 'pad' | 'pc' | 'cli'} | null; // sender device, if reported
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
`/preview` revalidates the original with the same decoded-pixel limit and re-encodes
it as WebP with a longest edge of 2048px, preserving aspect and applying EXIF
orientation without enlarging small images. Both thumbnail and preview strip
EXIF and other metadata; GIF uses only the first frame. Files without a validated
raster thumbnail return `404 NOT_FOUND`; corrupt/oversized image data returns
`415 INVALID_IMAGE` without decoder details. The existing member/room and share
rate limits also cover previews. Each server instance allows at most two active
preview generations across member, room and share routes; additional requests
return `429 PREVIEW_BUSY` with `Retry-After: 1`.
SVG and HTML are accepted for **download only** and are never inline-previewed,
even when the client sends `video/*` or a media filename. Video and audio
previews use `/media` only after the stored bytes match an allowlist (MP4,
QuickTime, WebM, Ogg, WAV, MP3, FLAC). The response type comes from those bytes.
Clipboard text is plain text by default. A markdown toggle may render a fixed
subset (headings, lists, quotes, code, emphasis, `http`/`https` links) as React
elements. It does not parse raw HTML, images, or other URL schemes. Do not fetch
arbitrary URLs from text or the original file MIME.

User quota counts all original text/file bytes **plus thumbnail bytes** uploaded
by that user across spaces. Large image previews are generated on demand, never
stored or cached by the server, and **do not count toward user or room quotas**.
There is no preview cache/key to delete on retraction, expiry or cleanup; only
the original and thumbnail remain in storage. The `Item` structure is unchanged.
The limit is that user's `quotaOverride` when set,
otherwise the effective `userQuotaBytes` runtime limit (environment default
`USER_QUOTA_BYTES`, also returned as `quotaBytes` on `GET /me`).
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

Optionally add `?device=<id>&name=<encoded name>&kind=<kind>` (same rules as the
`X-Dropit-Device*` headers) so this socket shows up by name in `presence.peers`.

Node CLI clients can use `new WebSocket(url, {headers: {Authorization: 'Bearer ' +
token}})` from `ws`; Origin is optional for a valid PAT. Never send the PAT as a
query parameter or WebSocket subprotocol. Native browser WebSocket continues to
use cookies and the existing Origin requirement.

Server → client JSON messages:

```ts
type Message =
  | {type: 'snapshot'; items: Item[]; groups?: string[]; serverTime: number; expiresAt: number | null}
  | {type: 'groups'; groups: string[]}
  | {type: 'item.created'; item: Item}
  | {type: 'item.updated'; item: Item}
  | {type: 'item.deleted'; id: string}
  | {type: 'presence'; devices: number; peers?: Array<{id: string; name: string; kind: string}>; others?: number};
```

`presence.devices` is the number of open sockets on this space or room. It is
sent after the snapshot and again when a socket leaves. It carries no
addresses; `peers` lists the distinct named devices currently connected (only
present when at least one socket identified itself). Several tabs of one browser are
several sockets but one peer. `others` (only when `peers` is present and it is non-zero)
is the number of sockets that named no device, such as the CLI; the web UI shows them as
one “Other clients” (`其他客户端`) row and counts “online devices” (`在线设备`) as distinct peers plus that row, never `devices`. On **every** connection, replace the local list with the first `snapshot`, then
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
| 400 | `INVALID_INPUT`, `INVALID_LIMITS`, `INVALID_JSON`, `JSON_REQUIRED`, `EMPTY_TEXT`, `EMPTY_FILE`, `UPLOAD_TIMEOUT`, `INVALID_FILENAME`, `INVALID_CHUNK_INDEX`, `INVALID_CHECKSUM`, `CHECKSUM_MISMATCH`, `CHUNK_SIZE_MISMATCH`, `UPLOAD_INCOMPLETE`, `OAUTH_STATE_INVALID`, `OAUTH_DENIED`, `OAUTH_PROVIDER_ERROR`, `INVALID_GROUP` |
| 401 | `UNAUTHENTICATED` → login |
| 403 | `FORBIDDEN`, `ORIGIN_REJECTED`, `USER_DISABLED`, `INVITATION_REQUIRED`, `INVITE_INVALID`, `VERIFIED_EMAIL_REQUIRED` |
| 403 | `INSUFFICIENT_SCOPE`, `BROWSER_SESSION_REQUIRED` for PATs |
| 404 | `NOT_FOUND`, `PROVIDER_UNAVAILABLE`, `GROUP_NOT_FOUND` |
| 416 | Download/media range unsatisfiable; Content-Range contains `bytes */SIZE` |
| 409 | `LAST_ADMIN`, `EMAIL_IN_USE`, `CHUNK_CONFLICT`, `UPLOAD_IN_PROGRESS`, `GROUP_EXISTS`, `GROUP_LIMIT` |
| 413 | `BODY_TOO_LARGE`, `TEXT_TOO_LARGE`, `FILE_TOO_LARGE`, `QUOTA_EXCEEDED`, `ITEM_LIMIT` → show configured limit |
| 415 | `INVALID_IMAGE` → unsupported/corrupt/too many pixels |
| 429 | `RATE_LIMITED`, `UPLOAD_BUSY`, `CHUNK_BUSY`, `UPLOAD_SESSION_LIMIT`, `SOCKET_LIMIT`; HTTP responses have integer `Retry-After` seconds |
| 500 | `INTERNAL_ERROR` → retry/report; no secrets or internals returned |

Rate windows default to 60s; limits are enforced separately by trusted client IP
and authenticated account. General: 240; auth: 20; invite: 10; upload/write: 30;
room create/write: 10; room access: 30. Chunk PUT: 2000 in separate buckets as described above. Auth also limits the verified provider identity across IPs. Limits are per process (MVP is one instance).
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
Normal failed writes are removed immediately. Committed chunks are referenced until
complete/cancel/expiry, and use the same deletion retry queue. Expired item bytes are released from
quota during cleanup. `/healthz` returns `{status:'ok'}`.

OAuth setup: create a GitHub OAuth App (`read:user user:email`) and a Google OAuth
Web client (`openid email profile`). Register exact callback URLs
`<APP_ORIGIN>/api/auth/github/callback` and `<APP_ORIGIN>/api/auth/google/callback`.
Set client ID/secret only through environment variables. No real credentials are
needed for the automated tests. Flow references:
[GitHub OAuth web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).

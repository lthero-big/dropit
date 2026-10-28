---
title: Security model
---

## Identity and sessions

- Only OAuth (GitHub / Google) is supported, with no passwords; the OAuth flow uses state + PKCE, the state is single-use and valid for 10 minutes, and provider access/refresh tokens are never stored.
- A new identity needs a valid invitation or an admin pre-created account; the first user is the exception (and becomes admin). Identities from different providers are not merged by email.
- Sessions are random server-side tokens and the database stores only their SHA-256; with `NODE_ENV=production` and an https site address cookies are Secure (`__Host-` prefix) and HSTS is enabled; with an http site address cookies are not Secure (browsers would drop them) and the log and admin panel warn.
- Disabling a user immediately revokes their sessions, personal access tokens and WebSockets.

## Tokens and capability links

| Credential | Entropy | Storage | Notes |
| --- | --- | --- | --- |
| Session | Random | SHA-256 | Browser cookie |
| Personal access token | 256-bit | SHA-256 | `read` / `write` scopes, optional expiry, returned only once at creation |
| Invitation | Random | SHA-256 | Limited uses, time-limited, revocable |
| Temporary room | 256-bit | Hash | The link itself grants read/write |
| Share link | 256-bit | SHA-256 | Read-only, time- and view-limited, revocable; every invalid case returns a uniform `404` |
| Device code | 256-bit | SHA-256 | Expires after 10 minutes, must be approved in a browser |

There is no token enumeration endpoint. Tokens may not be passed in URL query parameters (share / room / invitation links are themselves capabilities).

## Request validation

- Cookie requests, anonymous write requests and WebSockets must carry an `Origin`; Bearer requests never gain cookie privileges on top.
- With a site address set, `Origin` must match it exactly. Without one it must match the request's own address: host from the `Host` header, scheme from the connection (`X-Forwarded-Proto` / `X-Forwarded-Host` only from `TRUST_PROXY` peers); an `https://` page on the same host is also accepted (TLS terminated by an unlisted proxy).
- Without a site address, `Host` tricks such as DNS rebinding can reach only anonymous endpoints because cookies are host-scoped; pin the site address for public deployments.
- Changing the site address requires an admin browser session, and a value different from the current address needs confirmation.
- Personal access tokens cannot create tokens, rename, or approve devices (a browser session is required).
- When `TRUST_PROXY` is empty, `X-Forwarded-For` is ignored; once configured, each hop is verified starting from the real socket.
- Multi-dimensional rate limiting (IP, account, token, provider identity); over-limit requests get `429` + `Retry-After`.

## Content handling

- Text is shown as plain text by default; Markdown rendering supports only a safe subset — no raw HTML, no embedded images, and links are http/https only.
- Images are only displayed as WebP re-encoded by sharp; video / audio are inlined based on a file-header allowlist, ignoring the MIME type declared at upload.
- SVG and HTML are never inlined; original files are downloaded with `Content-Disposition: attachment` and `nosniff`.
- Uploads are limited by actual bytes, and quotas are checked inside a transaction.

## Operational advice

- Production must use HTTPS; bind the container only to loopback or an internal address and expose it through a reverse proxy.
- Don't commit OAuth credentials to the repository; use `env_file` or a secrets manager.
- Share links and room links are capabilities — confirm the recipient before passing them on.

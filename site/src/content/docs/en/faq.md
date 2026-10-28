---
title: FAQ
---

**There is no sign-in button on the login page?**
No OAuth provider is configured. Set `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` as a pair and restart.

**After signing in I'm sent back to the login page with an error?**
The error code is in `/login?error=CODE`: `INVITATION_REQUIRED` means an invitation is required; `VERIFIED_EMAIL_REQUIRED` means the provider did not return a verified email; `OAUTH_STATE_INVALID` is usually a mismatched callback URL or `APP_ORIGIN`, or the flow timed out (10 minutes).

**Requests return `403 ORIGIN_REJECTED`?**
When a site address is set (`APP_ORIGIN` or “Admin → Site address”), it must exactly match the origin in the browser's address bar (scheme, host and port). The login page and error message show the expected and the current address: use the expected one, or change the site address to the current one. If a wrong value locks you out of the admin panel, start once with `RESET_APP_ORIGIN=1`. The `dropit APP_ORIGIN:` startup log line shows the effective value.

**Can't sign in over HTTP in production mode?**
You can now: with an http site address cookies are not Secure, and the log and admin panel only warn. Public instances should still use HTTPS. If the browser uses https while the site address says http (or the other way round), see the previous answer.

**Rate limiting hits everyone / every client shows the proxy's IP?**
Behind a reverse proxy, set `TRUST_PROXY` to the proxy address (when nginx on the host reaches the container you usually also need to add the Docker gateway address).

**Large file uploads fail (413)?**
Check that the proxy's `client_max_body_size` is larger than `UPLOAD_CHUNK_BYTES`, and check `MAX_FILE_BYTES` and the quota settings.

**WebSocket keeps disconnecting?**
Make sure the proxy forwards the `Upgrade` / `Connection` headers, and set a long `proxy_read_timeout`.

**Can I run multiple instances?**
No. The current design is a single process; rate limits, broadcasts and presence are kept in memory.

**How do I back up?**
Back up `DATA_DIR/dropit.sqlite` with the SQLite backup API and also back up the whole data directory; or stop the service and copy the whole volume.

**Forgot who the admin is / all admins are disabled?**
The last enabled admin cannot be disabled or demoted, so the system always keeps at least one admin. You can also add an email to `ADMIN_EMAILS` so that an account later registered with that email becomes admin.

**Can I use it commercially? What is the license?**
Yes. dropit is released under [GNU AGPL-3.0-only](https://github.com/lthero-big/dropit/blob/main/LICENSE): you may use, modify, distribute and use it commercially for free; but if you distribute a modified version, or let others use a modified version as a network service, you must make the complete source code available to those users under AGPL-3.0. If you deploy it unmodified, giving users the address of this repository is enough.

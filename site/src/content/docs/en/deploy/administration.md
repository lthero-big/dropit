---
title: Admin panel
---

The admin panel lives at `/admin` and is only accessible to enabled admins.

## Where admins come from

- First run: while no account exists, create the first admin at `/setup` with the `dropit setup code` from the startup log, or with `ADMIN_EMAIL` / `ADMIN_PASSWORD` on an empty database.
- When the user table is empty, the first identity to sign in successfully via OAuth also becomes admin (a transaction guarantees only one under concurrency) — only possible when OAuth is configured through the environment, and it needs no setup code.
- Emails listed in `ADMIN_EMAILS` become admin when they later register through OAuth (provider-verified email); password sign-up is unaffected and always creates a normal user.
- Admins can promote other users to admin; the last enabled admin cannot be disabled or demoted.

## Users

![Admin → Users](https://raw.githubusercontent.com/lthero-big/dropit/main/docs/screenshots/admin-users.png)

- **Pre-create**: create a pending account by email (role and quota can be set); the first provider-verified OAuth sign-in with that email is bound to this account. With “Generate a temporary password” the password is shown once; signing in with it activates the account and asks for a new password right away.
- **Reset password**: “Reset password” in the user editor shows a one-time temporary password and signs the user out everywhere; the next sign-in must change it first (until then the browser session can only change the password or sign out). The user list shows each person's sign-in methods (password / GitHub / Google).
- **Command-line reset**: when you lost your own admin password, `docker exec dropit dropit-admin reset-password <email>` updates the database directly and prints a temporary password; `dropit-admin list-users` lists accounts.
- **Disable / enable**: disabling immediately revokes all of the user's sessions and WebSockets.
- **Signed-in devices**: in the user editor, view the user's signed-in devices (browser · OS · IP range · last activity) and sign out an individual device.
- **Force sign-out (all devices)**: deletes all of the user's sessions; the account stays enabled and can sign in again.
- **Quota**: set per-user overrides, or restore the installation defaults.
- Emails cannot be changed; identities from different providers are not merged automatically by email.


## Registration policy

“Admin → Registration” decides who can create a new account, for both password sign-up and first OAuth sign-in:

- **Invite-only** (default): needs a valid invitation link, or an account the admin pre-created for that email. Invitation links can be accepted with OAuth or by setting a password.
- **Closed**: no new accounts; existing accounts sign in as usual.
- **Open**: anyone can register (as a normal user) with email + password or OAuth. Password sign-up does **not** verify the email, so someone can squat an address; keep public instances invite-only.

## Invitations

- Choose the target space, number of uses (1–100) and validity (1–720 hours) to generate an invitation link `/invite/<token>`.
- The token is returned only once at creation; the database stores only its SHA-256. Invitations can be revoked at any time.

## Registration invitations (admins only)

- Only admins invite people to register: Admin → Invites, type “Registration invite”, with a use count and expiry and no cap. The invitee gets their own account and private space and joins no space.
- Normal users cannot create registration invitations (`/api/me/invites` and `POST /api/admin/invites` answer 403). They can invite existing accounts into their own space from Settings → Space members; such an invite cannot create an account.
- Per user, “Space invite limit” in the user editor caps open space invites (empty = default 5, 0 = none; admins are not limited).
- The Invites list shows every invitation with its type, creator and status, and admins can revoke them. Registration invitations made by normal users in older versions are flagged and no longer register anyone.

## Personal access tokens

- Admins can view and revoke every user's tokens; users manage their own on `/settings`.

## Runtime limits

![Admin → Limits](https://raw.githubusercontent.com/lthero-big/dropit/main/docs/screenshots/admin-limits.png)

- The limits editor shows each setting's current value, environment default, whether it is overridden, and its lower/upper bounds.
- Changes are validated as a whole, committed atomically and recorded in an audit log (paginated). See [Configuration](../../config/configuration/#runtime-overrides) for the detailed rules.

## Site address

- “Admin → Site address” shows the effective address and its source (admin setting / environment / request address), and whether cookies are Secure and proxies are trusted.
- Input must be scheme + host or IP + port (e.g. `https://dropit.example.com`, `http://192.168.1.10:8787`) without a path. It applies immediately and wins over `APP_ORIGIN`. “Clear” falls back to the env value or the request address.
- A value different from the current address needs confirmation; afterwards use the new address. If you lock yourself out, start once with `RESET_APP_ORIGIN=1`.
- The GitHub / Google OAuth callback URLs are listed ready to copy.

## Version and updates

- “Admin → Updates” shows the current version, short git hash, build time and install method (Docker image / compose local build / source).
- By default the server checks Docker Hub or GitHub for a new version every 12 hours and caches the result; you can “Check now” (repeat clicks within 60 seconds reuse the previous result).
- When a new version is available, a notice appears at the top of the admin and settings pages with a copyable upgrade command matching your install method. The server never upgrades itself; for fully automatic updates see [Deployment → Automatic updates](../deployment/#automatic-updates-optional).
- For offline deployments set `UPDATE_CHECK=false`.

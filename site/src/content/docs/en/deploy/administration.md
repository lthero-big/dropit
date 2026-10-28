---
title: Admin panel
---

The admin panel lives at `/admin` and is only accessible to enabled admins.

## Where admins come from

- When the user table is empty, the first identity to sign in successfully via OAuth becomes admin (a transaction guarantees only one under concurrency).
- Verified emails listed in `ADMIN_EMAILS` also become admin when they register later.
- Admins can promote other users to admin; the last enabled admin cannot be disabled or demoted.

## Users

- **Pre-create**: create a pending account by email (role and quota can be set); the first provider-verified OAuth sign-in with that email is bound to this account.
- **Disable / enable**: disabling immediately revokes all of the user's sessions and WebSockets.
- **Signed-in devices**: in the user editor, view the user's signed-in devices (browser · OS · IP range · last activity) and sign out an individual device.
- **Force sign-out (all devices)**: deletes all of the user's sessions; the account stays enabled and can sign in again.
- **Quota**: set per-user overrides, or restore the installation defaults.
- Emails cannot be changed; identities from different providers are not merged automatically by email.

## Invitations

- Choose the target space, number of uses (1–100) and validity (1–720 hours) to generate an invitation link `/invite/<token>`.
- The token is returned only once at creation; the database stores only its SHA-256. Invitations can be revoked at any time.

## Personal access tokens

- Admins can view and revoke every user's tokens; users manage their own on `/settings`.

## Runtime limits

- The limits editor shows each setting's current value, environment default, whether it is overridden, and its lower/upper bounds.
- Changes are validated as a whole, committed atomically and recorded in an audit log (paginated). See [Configuration](../../config/configuration/#runtime-overrides) for the detailed rules.

## Version and updates

- “Admin → Updates” shows the current version, short git hash, build time and install method (Docker image / compose local build / source).
- By default the server checks Docker Hub or GitHub for a new version every 12 hours and caches the result; you can “Check now” (repeat clicks within 60 seconds reuse the previous result).
- When a new version is available, a notice appears at the top of the admin and settings pages with a copyable upgrade command matching your install method. The server never upgrades itself; for fully automatic updates see [Deployment → Automatic updates](../deployment/#automatic-updates-optional).
- For offline deployments set `UPDATE_CHECK=false`.

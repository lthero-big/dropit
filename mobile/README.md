# dropit Android (RHEA-190)

Capacitor shell. No built-in server: first run asks for an https URL and checks `/api/version`.
Login uses the device-code flow (`/api/auth/device/*`), opens `/device` in the system browser,
and stores a per-device token in Capacitor Preferences.

- Tests: `npm test`
- APK: run the **Android APK** workflow (workflow_dispatch); the debug APK is an artifact. No tag, no release.

## After login: the full web UI in the app (RHEA-190 ui)

- The app keeps only two native screens: server address and device login (scopes `read write web`).
- After login it asks `POST /api/app-session/ticket` (Bearer device token, needs the `web` scope) for a
  one-time, 60-second ticket and opens `GET /api/app-session?ticket=…` in its own WebView. The server sets
  a normal browser session cookie and redirects to `/`, so the web UI is the same as in a browser and the
  user does not sign in twice. An existing browser session in the WebView is kept (no new session row).
- Old app tokens without `web` get `403 INSUFFICIENT_SCOPE`; the app revokes them and runs device login once
  more. Servers without the endpoint (404) simply show the web UI's own login page.
- Only the configured server's origin stays in the app (`DropitSharePlugin.shouldOverrideLoad`); other
  http(s) links open in the system browser. Android back goes back in the web UI, then leaves the app.
- On that origin only, `www/inject.js` adds a small button (bottom right) with 「从剪贴板发送」 and
  「应用设置」. The clipboard is read natively only after a tap, via the origin-restricted `DropitApp`
  bridge (`WebViewCompat.addWebMessageListener`); the text is posted with the page's own session cookie.
- Share target: `ACTION_SEND` / `ACTION_SEND_MULTIPLE` (text, images, any file). A share opens the app page,
  which sends it (files are streamed natively, Bearer, https only) and then returns to the web UI.
- Web downloads (`Content-Disposition: attachment`) go to Downloads via `DownloadManager` with the session cookie.
  The name comes from `filename*=` (RFC 5987) and the type from the extension when the server sends
  `application/octet-stream` (`DownloadName.java`, unit tested); `blob:`/`data:` downloads show a hint.
- 「退出登录并更换服务器」 revokes the device token and clears the WebView cookies.

## Signing and versions

The APK workflow signs every build with one fixed key from the repository secrets
`ANDROID_KEYSTORE_B64` (base64 PKCS12, alias `dropit`) and `ANDROID_KEYSTORE_PASSWORD`, so a new APK
installs over the previous one. Builds signed with the older throwaway CI keys (0.2.0 and before)
must be uninstalled once. Without the secrets (forks, local builds) Gradle uses a normal debug key.

Upgrades keep the login: the server URL and device token live in Capacitor Preferences
(SharedPreferences `CapacitorStorage`), the server origin for the native side in SharedPreferences
`dropit_app`, and the web session in the WebView cookie store. Android keeps all app data on an
in-place update with the same `applicationId` and signing key, and the app never clears them on a
version change; only 「退出登录并更换服务器」, an uninstall or 「清除数据」 do. A revoked or expired token
(401) leads back to the device-code page; network errors keep the token and offer 重试.

The setup, login and settings pages show `版本 <versionName> · <commit> · <date>`; the workflow writes
`www/build-info.js` and names the file `dropit-android-<version>-<commit>.apk`. Bump `versionCode` and
`versionName` in `android/app/build.gradle` (and `www/build-info.js`) for each release to the phone.

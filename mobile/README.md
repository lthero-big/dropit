# dropit Android (RHEA-190)

Capacitor shell. No built-in server: first run asks for an https URL and checks `/api/version`.
Login uses the device-code flow (`/api/auth/device/*`), opens `/device` in the system browser,
and stores a per-device token in Capacitor Preferences.

- Tests: `npm test`
- APK: run the **Android APK** workflow (workflow_dispatch); the debug APK is an artifact. No tag, no release.

## Signed-in home (RHEA-190 br)

- Native list of the 50 newest items of your own space (Bearer device token, );
  tap a text item to copy it (). Image items show their thumbnail.
- 「从剪贴板发送到 dropit」 reads the clipboard only when tapped, in the foreground, and posts it as text.
- Share target:  /  intent filters (text, images, any file).
   captures the intent; text is posted from JS, files are streamed natively from their
   URI to  (chunked, Bearer, only to the configured https server).
- 「在应用内打开网页版」 loads the configured server inside the app WebView ( allows only that
  host; other hosts still go to the system browser). Android back returns to the native screens.

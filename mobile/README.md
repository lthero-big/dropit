# dropit Android (RHEA-190)

Capacitor shell. No built-in server: first run asks for an https URL and checks `/api/version`.
Login uses the device-code flow (`/api/auth/device/*`), opens `/device` in the system browser,
and stores a per-device token in Capacitor Preferences.

- Tests: `npm test`
- APK: run the **Android APK** workflow (workflow_dispatch); the debug APK is an artifact. No tag, no release.

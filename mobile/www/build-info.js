// RHEA-190 fx: shown in the app so builds can be told apart. The Android APK workflow rewrites this
// file with the commit it builds; keep version/code in step with versionName/versionCode in android/app/build.gradle.
// RHEA-190 au: code is only a fallback for the update check (the native side reports the real versionCode).
export const BUILD = { version: '0.3.2', code: 5, commit: 'dev', date: '' };

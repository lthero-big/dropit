// RHEA-190 au: the Android app asks its own dropit server whether a newer APK exists.
// The operator publishes an APK with scripts/publish-android-apk.mjs, which copies it to
// DATA_DIR/app/android/ and writes latest.json next to it. Nothing here is required: without a
// manifest GET /api/app/android/latest answers 404 NO_RELEASE and the app says so.
// Pure part (manifest rules); the disk reads live in the files.ts adapter (readAndroidRelease, apkStream).
import { join } from 'node:path';

export interface AndroidRelease {
  versionCode: number;
  versionName: string;
  notes: string;
  file: string;
  sha256: string;
  size: number;
  publishedAt: string | null;
}

export const ANDROID_RELEASE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.apk$/;
export const MAX_APK_BYTES = 200 * 1024 * 1024;
export const androidReleaseDir = (dataDir: string) => join(dataDir, 'app', 'android');

/** Validates a parsed latest.json; null when anything is missing or out of range. */
export function parseAndroidRelease(raw: unknown): AndroidRelease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const { versionCode, versionName, file, sha256, size } = r;
  const notes = r.notes ?? '';
  const publishedAt = r.publishedAt ?? null;
  if (typeof versionCode !== 'number' || !Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) return null;
  if (typeof versionName !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/.test(versionName)) return null;
  if (typeof notes !== 'string' || notes.length > 4000) return null;
  if (typeof file !== 'string' || !ANDROID_RELEASE_FILE.test(file) || file.includes('..')) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_APK_BYTES) return null;
  if (publishedAt !== null && (typeof publishedAt !== 'string' || publishedAt.length > 40)) return null;
  return { versionCode, versionName, notes, file, sha256, size, publishedAt };
}

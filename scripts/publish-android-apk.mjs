#!/usr/bin/env node
// RHEA-190 au: publish an Android APK on this dropit server, so the app's 「检查更新」 finds it.
//   node scripts/publish-android-apk.mjs <apk> --code 5 --name 0.3.2 [--notes "…"] [--dir DATA_DIR/app/android]
// Copies the APK to <dir>/dropit-android-<name>.apk, writes <dir>/latest.json atomically (temp + rename)
// and removes older APKs from <dir>. --dir defaults to $DATA_DIR/app/android, else ./data/app/android.
// Docker: publish into a local directory, then copy it into the volume, e.g.
//   node scripts/publish-android-apk.mjs app.apk --code 5 --name 0.3.2 --dir /tmp/dropit-apk
//   docker exec dropit mkdir -p /data/app/android && docker cp /tmp/dropit-apk/. dropit:/data/app/android/
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

function fail(message) { console.error(`publish-android-apk: ${message}`); process.exit(2); }
const args = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const [apk] = positional;
if (!apk) fail('usage: publish-android-apk.mjs <apk> --code <versionCode> --name <versionName> [--notes text] [--dir path]');
const code = Number(opts.code);
if (!Number.isSafeInteger(code) || code < 1 || code > 2100000000) fail('--code must be the APK versionCode (a positive integer)');
const name = String(opts.name ?? '');
if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/.test(name)) fail('--name must be the APK versionName, e.g. 0.3.2');
const notes = String(opts.notes ?? '');
if (notes.length > 4000) fail('--notes is longer than 4000 characters');
const dir = resolve(opts.dir ?? join(process.env.DATA_DIR || 'data', 'app', 'android'));
const info = await stat(apk).catch(() => fail(`cannot read ${apk}`));
if (!info.isFile() || info.size < 1 || info.size > 200 * 1024 * 1024) fail('the APK must be a file of at most 200 MB');

const file = `dropit-android-${name}.apk`;
await mkdir(dir, { recursive: true });
await copyFile(apk, join(dir, `${file}.tmp`));
await rename(join(dir, `${file}.tmp`), join(dir, file));
const digest = createHash('sha256');
for await (const chunk of createReadStream(join(dir, file))) digest.update(chunk);
const manifest = { versionCode: code, versionName: name, notes, file, sha256: digest.digest('hex'), size: info.size, publishedAt: new Date().toISOString() };
await writeFile(join(dir, 'latest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`);
await rename(join(dir, 'latest.json.tmp'), join(dir, 'latest.json'));
for (const old of await readdir(dir)) if (old.endsWith('.apk') && old !== file) await unlink(join(dir, old));
console.log(`published ${basename(apk)} as ${join(dir, file)} (versionCode ${code}, ${info.size} bytes, sha256 ${manifest.sha256})`);

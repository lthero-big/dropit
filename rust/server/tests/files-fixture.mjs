import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixture.mjs';

const TINY_WEBP = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
  'base64',
);

/** Minimal magic prefixes. These are not playable or decodable images. */
export const MEDIA = {
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypisom'), Buffer.from('payload-mp4')]),
  m4a: Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypM4A '), Buffer.from('audio')]),
  quicktime: Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.from('mov')]),
  webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm-prefix')]),
  wav: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]),
  flac: Buffer.from('fLaCstream'),
  mp3: Buffer.from('ID3mpeg'),
  avif: Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.from('stored-avif')]),
  png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]),
  html: Buffer.from('<html><script>alert(1)</script></html>'),
  bin: Buffer.from('not an image'),
  range: Buffer.from('0123456789'),
  hold: Buffer.alloc(1024 * 1024, 0x61),
};

export async function seedFiles(directory, metadata, referenceRoot) {
  const db = new DatabaseSync(resolve(directory, 'dropit.sqlite'));
  const files = resolve(directory, 'files');
  await mkdir(files, { mode: 0o700 });
  const now = Date.now();
  const rows = [];
  const insert = (label, bytes, { filename, mime, thumbnail = false, expiresAt = now + 86400000, space = metadata.aliceSpace, user = metadata.alice.id } = {}) => {
    const id = `file-${label}`;
    const fileKey = randomUUID();
    const thumbnailKey = thumbnail ? randomUUID() : null;
    rows.push({ label, id, fileKey, thumbnailKey, bytes: bytes.toString('base64'), filename, mime, size: bytes.length });
    return { id, fileKey, thumbnailKey, expiresAt, space, user, filename, mime, size: bytes.length, bytes };
  };
  const planned = [
    insert('range', MEDIA.range, { filename: '范围 名.txt', mime: 'text/plain' }),
    insert('hold', MEDIA.hold, { filename: 'hold.bin', mime: 'application/octet-stream' }),
    insert('mp4', MEDIA.mp4, { filename: 'clip.mp4', mime: 'text/html' }),
    insert('m4a', MEDIA.m4a, { filename: 'song.m4a', mime: 'application/octet-stream' }),
    insert('quicktime', MEDIA.quicktime, { filename: 'clip.mov', mime: 'video/quicktime' }),
    insert('webm', MEDIA.webm, { filename: 'clip.webm', mime: 'video/webm' }),
    insert('wav', MEDIA.wav, { filename: 'tone.wav', mime: 'audio/wav' }),
    insert('flac', MEDIA.flac, { filename: 'tone.flac', mime: 'audio/flac' }),
    insert('mp3', MEDIA.mp3, { filename: 'tone.mp3', mime: 'audio/mpeg' }),
    insert('avif', MEDIA.avif, { filename: 'still.avif', mime: 'image/avif', thumbnail: true }),
    insert('png', MEDIA.png, { filename: 'still.png', mime: 'image/png', thumbnail: true }),
    insert('html', MEDIA.html, { filename: 'page.html', mime: 'video/mp4' }),
    insert('bin', MEDIA.bin, { filename: 'a"b%c;d.txt', mime: 'application/octet-stream' }),
    insert('nofile', Buffer.alloc(0), { filename: null, mime: null }),
    insert('emptyname', MEDIA.bin, { filename: '', mime: 'application/octet-stream' }),
    insert('missing', MEDIA.bin, { filename: 'gone.bin', mime: 'application/octet-stream' }),
    insert('expired', MEDIA.bin, { filename: 'old.bin', mime: 'application/octet-stream', expiresAt: now - 1000 }),
    insert('bob', MEDIA.bin, { filename: 'bob.bin', mime: 'application/octet-stream', space: metadata.bobSpace, user: metadata.bob.id }),
  ];
  planned.find(row => row.id === 'file-nofile').fileKey = null;
  const statement = db.prepare(`INSERT INTO items
    (id,spaceId,userId,kind,text,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt,pinned,tags)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of planned) {
    const stored = row.id === 'file-nofile' ? null : row.fileKey;
    const thumb = row.thumbnailKey;
    if (stored && row.id !== 'file-missing') {
      await writeFile(resolve(files, stored), row.bytes, { mode: 0o600 });
    }
    if (thumb) await writeFile(resolve(files, thumb), TINY_WEBP, { mode: 0o600 });
    statement.run(
      row.id, row.space, row.user, 'file', null, row.filename, row.mime, row.size,
      row.size + (thumb ? TINY_WEBP.length : 0), stored, thumb, now, row.expiresAt, now, 0, '[]',
    );
  }
  db.close();
  const catalog = {
    referenceRoot,
    files: Object.fromEntries(planned.map(row => [row.id.replace(/^file-/, ''), {
      id: row.id,
      size: row.id === 'file-nofile' ? 0 : row.size,
      filename: row.filename,
      hasThumbnail: Boolean(row.thumbnailKey),
    }])),
  };
  await writeFile(resolve(directory, 'files.json'), JSON.stringify(catalog, null, 2) + '\n');
  return catalog;
}

if (process.argv[1] && process.argv[1].endsWith('files-fixture.mjs')) {
  const directory = resolve(process.argv[2] ?? 'data/files-manual');
  const metadata = await fixture(directory);
  await seedFiles(directory, metadata);
  console.log('TS schema-19 file fixture created');
}

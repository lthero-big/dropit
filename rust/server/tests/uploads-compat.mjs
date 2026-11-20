import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
const rustBin = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
const maxFile = 1024 * 1024;
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'rust/server/data/uploads-'));
const processes = new Set();
const evidence = [];
let checks = 0;

function note(label, detail) {
  evidence.push({ label, ...detail });
  console.log('EVIDENCE ' + label + ' ' + JSON.stringify(detail));
}

async function prepareReference() {
  const directory = resolve(temporary, 'ts-reference');
  await mkdir(directory);
  const archive = execFileSync('git', ['archive', baseline, '--',
    'apps/server', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@dropit/server...'],
    { cwd: directory, stdio: 'pipe' });
  execFileSync('pnpm', ['--filter', '@dropit/server', 'build'], { cwd: directory, stdio: 'pipe' });
  console.log('PASS upload reference built from ' + baseline);
  return directory;
}

function loadSharp(referenceRoot) {
  const require = createRequire(resolve(referenceRoot, 'apps/server/package.json'));
  return require('sharp');
}

function loadSqlite(referenceRoot) {
  const require = createRequire(resolve(referenceRoot, 'apps/server/package.json'));
  return require('better-sqlite3');
}

async function start(kind, data, extra = {}) {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((ok, reject) => socket.close(error => error ? reject(error) : ok()));
  const origin = 'http://dropit.test';
  const child = spawn(kind === 'rust' ? rustBin : process.execPath,
    kind === 'rust' ? [] : [resolve(referenceRoot, 'apps/server/dist/index.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port),
        APP_ORIGIN: origin, UPDATE_CHECK: '0', RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_UPLOAD: '500',
        RATE_INVITE: '100', RATE_ROOM: '100', RATE_CHUNK: '2000',
        UPLOAD_CHUNK_BYTES: String(64 * 1024),
        MAX_FILE_BYTES: String(maxFile),
        // TS validateLimits requires roomMaxFileBytes < maxFileBytes. Default room cap is 5 MiB.
        ROOM_MAX_FILE_BYTES: String(512 * 1024),
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  processes.add(child);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(kind + ' exited\n' + output);
    if (output.includes('dropit listening on port ')) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/healthz');
        await response.arrayBuffer();
        if (response.status === 200) {
          const started = { kind, child, url: 'http://127.0.0.1:' + port, origin, data, output: '' };
          child.stdout.on('data', () => { started.output = output; });
          child.stderr.on('data', () => { started.output = output; });
          started.output = output;
          return started;
        }
      } catch { /* not ready */ }
    }
    await delay(25);
  }
  throw new Error(kind + ' failed readiness\n' + output);
}

async function stop(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (server.child.exitCode === null) {
    server.child.kill('SIGKILL');
    await Promise.race([exited, delay(1000)]);
  }
  processes.delete(server.child);
}

function cookieOf(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

async function login(server, email) {
  const response = await fetch(server.url + '/api/auth/password/login', {
    method: 'POST',
    headers: { origin: server.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password-e\u0301-🔐' }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return cookieOf(response);
}

async function request(server, path, { method = 'GET', cookie, headers = {}, body } = {}) {
  const requestHeaders = { origin: server.origin, ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  const response = await fetch(server.url + path, { method, headers: requestHeaders, body, redirect: 'manual' });
  const bytes = Buffer.from(await response.arrayBuffer());
  checks++;
  return { status: response.status, headers: response.headers, bytes };
}

function codeOf(response) {
  if (response.status < 400) return null;
  return JSON.parse(response.bytes.toString()).error.code;
}

function itemOf(response) {
  const body = JSON.parse(response.bytes.toString());
  assert.equal(body.item.fileKey, undefined);
  assert.equal(body.item.thumbnailKey, undefined);
  assert.equal(body.item.storedBytes, undefined);
  return body.item;
}

function stable(item) {
  return {
    kind: item.kind, filename: item.filename, mime: item.mime, size: item.size,
    hasThumbnail: item.hasThumbnail, pinned: item.pinned, tags: item.tags,
    group: item.group ?? null, device: item.device ?? null, text: item.text ?? null, userId: item.userId,
  };
}

async function fileNames(data) {
  const directory = resolve(data, 'files');
  try {
    return (await readdir(directory)).filter(name => /^[a-f0-9-]{36}$/.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function postFile(server, cookie, space, bytes, headers = {}) {
  return request(server, '/api/spaces/' + space + '/items/file', {
    method: 'POST', cookie, body: bytes, headers,
  });
}

async function postStream(server, cookie, space, total, headers = {}) {
  const chunk = Buffer.alloc(64 * 1024, 7);
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.length, total - sent);
      controller.enqueue(chunk.subarray(0, size));
      sent += size;
    },
  });
  const response = await fetch(server.url + '/api/spaces/' + space + '/items/file', {
    method: 'POST',
    headers: { origin: server.origin, cookie, ...headers },
    body, duplex: 'half',
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  checks++;
  return { status: response.status, headers: response.headers, bytes };
}

function holdUpload(server, cookie, space) {
  return new Promise((resolveHold, reject) => {
    const url = new URL(server.url);
    const socket = connect(url.port, url.hostname, () => {
      socket.write(
        'POST /api/spaces/' + space + '/items/file HTTP/1.1\r\n' +
        'Host: ' + url.host + '\r\n' +
        'Origin: ' + server.origin + '\r\n' +
        'Cookie: ' + cookie + '\r\n' +
        'Content-Type: application/octet-stream\r\n' +
        'Content-Length: 200000\r\n' +
        'X-File-Name: hold.bin\r\n\r\n',
      );
      resolveHold(socket);
    });
    socket.on('error', reject);
  });
}

async function imageInfo(sharp, bytes) {
  const meta = await sharp(bytes).metadata();
  const raw = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return {
    format: meta.format, width: meta.width, height: meta.height,
    exif: meta.exif ?? null, icc: meta.icc ?? null, xmp: meta.xmpAsString ?? null,
    orientation: meta.orientation ?? null,
    channels: raw.info.channels,
    pixel: [raw.data[0], raw.data[1], raw.data[2]],
  };
}

function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoi + 1;
  const table = new Map();
  const bits = [];
  const write = (code, size) => {
    for (let bit = 0; bit < size; bit++) bits.push((code >>> bit) & 1);
  };
  write(clear, codeSize);
  let prefix = String.fromCharCode(indices[0]);
  for (let index = 1; index < indices.length; index++) {
    const symbol = String.fromCharCode(indices[index]);
    const joined = prefix + symbol;
    if (table.has(joined)) {
      prefix = joined;
      continue;
    }
    write(prefix.length === 1 ? prefix.charCodeAt(0) : table.get(prefix), codeSize);
    table.set(joined, nextCode++);
    if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    prefix = symbol;
    if (nextCode >= 4096) {
      write(clear, codeSize);
      table.clear();
      codeSize = minCodeSize + 1;
      nextCode = eoi + 1;
    }
  }
  write(prefix.length === 1 ? prefix.charCodeAt(0) : table.get(prefix), codeSize);
  write(eoi, codeSize);
  const bytes = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8 && index + bit < bits.length; bit++) value |= bits[index + bit] << bit;
    bytes.push(value);
  }
  return Buffer.from(bytes);
}

function gifFrame(width, height, index, delay) {
  const pixels = Buffer.alloc(width * height, index);
  const packed = lzw(pixels, 8);
  const blocks = [];
  for (let offset = 0; offset < packed.length; offset += 255) {
    const slice = packed.subarray(offset, offset + 255);
    blocks.push(Buffer.from([slice.length]), slice);
  }
  return Buffer.concat([
    Buffer.from([0x21, 0xf9, 0x04, 0x00, delay & 255, delay >> 8, 0x00, 0x00]),
    Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, width & 255, width >> 8, height & 255, height >> 8, 0x00, 0x08]),
    Buffer.concat(blocks),
    Buffer.from([0x00]),
  ]);
}

function twoFrameGif(width, height) {
  return Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([width & 255, width >> 8, height & 255, height >> 8, 0x81, 0x00, 0x00]),
    Buffer.from([255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0]),
    gifFrame(width, height, 0, 10),
    gifFrame(width, height, 1, 10),
    Buffer.from([0x3b]),
  ]);
}

function boxes(buf, start = 0, end = buf.length) {
  const found = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) break;
    found.push({ type, offset, header, size, body: offset + header });
    offset += size;
  }
  return found;
}

function findBox(buf, type) {
  const walk = (start, end) => {
    for (const box of boxes(buf, start, end)) {
      if (box.type === type) return box;
      if (box.type === 'meta' && box.body + 4 < box.offset + box.size) {
        const nested = walk(box.body + 4, box.offset + box.size);
        if (nested) return nested;
      }
      if (['iprp', 'ipco', 'moov'].includes(box.type)) {
        const nested = walk(box.body, box.offset + box.size);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(0, buf.length);
}

function patchIspe(buf, width, height) {
  const ispe = findBox(buf, 'ispe');
  if (!ispe) throw new Error('fixture AVIF has no ispe');
  const copy = Buffer.from(buf);
  copy.writeUInt32BE(width, ispe.body + 4);
  copy.writeUInt32BE(height, ispe.body + 8);
  return copy;
}

function readIlocExtent(buf, iloc) {
  let cursor = iloc.body;
  const version = buf[cursor];
  cursor += 4;
  const offsetSize = buf[cursor] >> 4;
  const lengthSize = buf[cursor] & 0x0f;
  cursor++;
  const baseSize = buf[cursor] >> 4;
  const indexSize = version >= 1 ? buf[cursor] & 0x0f : 0;
  cursor++;
  const count = version < 2 ? buf.readUInt16BE(cursor) : buf.readUInt32BE(cursor);
  cursor += version < 2 ? 2 : 4;
  const itemBytes = version < 2 ? 2 : 4;
  const extents = [];
  for (let item = 0; item < count; item++) {
    cursor += itemBytes;
    if (version === 1 || version === 2) cursor += 2;
    cursor += 2;
    let base = 0;
    for (let byte = 0; byte < baseSize; byte++) base = base * 256 + buf[cursor++];
    const extentCount = buf.readUInt16BE(cursor);
    cursor += 2;
    for (let extent = 0; extent < extentCount; extent++) {
      if (indexSize) cursor += indexSize;
      let offset = 0;
      for (let byte = 0; byte < offsetSize; byte++) offset = offset * 256 + buf[cursor++];
      const lengthAt = cursor;
      let length = 0;
      for (let byte = 0; byte < lengthSize; byte++) length = length * 256 + buf[cursor++];
      extents.push({ offset: base + offset, length, lengthAt, lengthSize });
    }
  }
  return extents;
}

function extractCoded(buf) {
  const iloc = findBox(buf, 'iloc');
  const extent = readIlocExtent(buf, iloc)[0];
  return buf.subarray(extent.offset, extent.offset + extent.length);
}

function spliceCoded(container, coded) {
  const iloc = findBox(container, 'iloc');
  const extent = readIlocExtent(container, iloc)[0];
  const mdat = boxes(container).find(box => box.type === 'mdat');
  if (!mdat) throw new Error('AVIF container has no mdat');
  if (extent.offset < mdat.body || extent.offset + extent.length > mdat.offset + mdat.size) {
    throw new Error('iloc extent is outside mdat');
  }
  const before = container.subarray(0, mdat.body);
  const after = container.subarray(mdat.offset + mdat.size);
  const next = Buffer.concat([before, coded, after]);
  const size = 8 + coded.length;
  next.writeUInt32BE(size, mdat.offset);
  if (extent.lengthSize !== 4) throw new Error('unexpected iloc length size ' + extent.lengthSize);
  next.writeUInt32BE(coded.length, extent.lengthAt);
  return next;
}

async function makeImages(sharp) {
  const solid = (width, height, background, format) => sharp({
    create: { width, height, channels: 3, background },
  })[format]().toBuffer();
  const png = (width, height, background = { r: 20, g: 140, b: 220 }) => solid(width, height, background, 'png');
  const images = {
    bin: Buffer.from('dropit file bytes\n'),
    png500: await png(500, 400),
    png10: await png(10, 10),
    png48: await png(48, 24, { r: 240, g: 10, b: 10 }),
    jpeg48: await solid(48, 24, { r: 10, g: 180, b: 30 }, 'jpeg'),
    webp8: await solid(8, 4, { r: 10, g: 20, b: 200 }, 'webp'),
    gifStill: await solid(48, 24, { r: 250, g: 5, b: 5 }, 'gif'),
    gif2: twoFrameGif(32, 16),
    jpegOrient: await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: { r: 30, g: 60, b: 90 } },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"></svg>'),
    tiffDeclared: Buffer.from('not-a-tiff'),
    avif8: await sharp({
      create: { width: 8, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).avif({ quality: 50, effort: 0, chromaSubsampling: '4:4:4' }).toBuffer(),
  };
  images.pngSvg = Buffer.concat([images.png10, Buffer.from('<svg/>')]);
  images.avifHugeIspe = patchIspe(images.avif8, 4097, 4097);
  const huge = await sharp({
    create: { width: 4097, height: 4097, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).avif({ quality: 20, effort: 0 }).toBuffer();
  images.avifForged = spliceCoded(images.avif8, extractCoded(huge));
  images.png4096 = await png(4096, 4096, { r: 1, g: 2, b: 3 });
  const sources = {
    png500: await imageInfo(sharp, images.png500),
    jpegOrient: await sharp(images.jpegOrient).metadata(),
    gif2: await imageInfo(sharp, images.gif2),
    avif8: await sharp(images.avif8).metadata(),
  };
  note('sources', {
    png500: { width: sources.png500.width, height: sources.png500.height, bytes: images.png500.length },
    jpegOrient: { width: sources.jpegOrient.width, height: sources.jpegOrient.height, orientation: sources.jpegOrient.orientation, bytes: images.jpegOrient.length },
    gif2: { width: sources.gif2.width, height: sources.gif2.height, pixel: sources.gif2.pixel, bytes: images.gif2.length },
    avif8: { width: sources.avif8.width, height: sources.avif8.height, format: sources.avif8.format, bytes: images.avif8.length },
    png4096: images.png4096.length,
    avifForged: images.avifForged.length,
    pngSvg: images.pngSvg.length,
  });
  assert.equal(sources.jpegOrient.orientation, 6);
  assert.equal(sources.gif2.pixel[0] > 240 && sources.gif2.pixel[2] < 15, true);
  assert.ok(images.pngSvg.length < 4096);
  return images;
}

async function expectError(server, cookie, space, bytes, headers, status, code) {
  const before = await fileNames(server.data);
  const response = await postFile(server, cookie, space, bytes, headers);
  assert.equal(response.status, status, response.bytes.toString());
  assert.equal(codeOf(response), code, response.bytes.toString());
  assert.deepEqual(await fileNames(server.data), before, code + ' left a file');
  return response;
}

async function derived(sharp, bytes, edge) {
  const info = await imageInfo(sharp, bytes);
  assert.equal(info.format, 'webp');
  assert.equal(info.exif, null);
  assert.equal(info.icc, null);
  assert.equal(info.xmp, null);
  assert.ok(info.orientation == null || info.orientation === 1);
  assert.equal(bytes.includes(Buffer.from('EXIF')), false);
  assert.equal(bytes.includes(Buffer.from('XMP')), false);
  return info;
}

let referenceRoot;
try {
  referenceRoot = await prepareReference();
  const sharp = loadSharp(referenceRoot);
  const Database = loadSqlite(referenceRoot);
  const images = await makeImages(sharp);
  const seed = resolve(temporary, 'seed');
  const metadata = await fixture(seed, { referenceRoot });
  const seedDb = new Database(resolve(seed, 'dropit.sqlite'));
  seedDb.prepare("DELETE FROM runtime_limits WHERE key='uploadChunkBytes'").run();
  seedDb.close();
  const space = metadata.aliceSpace;
  const results = {};
  for (const kind of ['ts', 'rust']) {
    const data = resolve(temporary, kind);
    await cp(seed, data, { recursive: true });
    results[kind] = { server: await start(kind, data) };
    results[kind].alice = await login(results[kind].server, 'alice@example.test');
    results[kind].bob = await login(results[kind].server, 'bob@example.test');
    results[kind].viewer = await login(results[kind].server, 'viewer@example.test');
    results[kind].temporary = await login(results[kind].server, 'temporary@example.test');
  }
  const pair = [
    [results.ts.server, results.ts.alice],
    [results.rust.server, results.rust.alice],
  ];

  async function both(bytes, headers) {
    const uploaded = [];
    for (const [server, cookie] of pair) {
      const response = await postFile(server, cookie, space, bytes, headers);
      assert.equal(response.status, 201, server.kind + ' ' + response.bytes.toString());
      uploaded.push(itemOf(response));
    }
    assert.deepEqual(stable(uploaded[1]), stable(uploaded[0]));
    return uploaded;
  }

  async function downloadEquals(items, bytes, mime) {
    for (const [index, [server, cookie]] of pair.entries()) {
      const response = await request(server, '/api/spaces/' + space + '/items/' + items[index].id + '/download', { cookie });
      assert.equal(response.status, 200, server.kind);
      assert.equal(response.bytes.equals(bytes), true);
      assert.equal(response.headers.get('content-type'), mime);
      assert.match(response.headers.get('content-disposition'), /^attachment;/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }

  const bin = await both(images.bin, { 'content-type': 'application/octet-stream', 'x-file-name': 'notes.bin' });
  assert.equal(bin[0].kind, 'file');
  assert.equal(bin[0].hasThumbnail, false);
  assert.equal(bin[0].size, images.bin.length);
  assert.equal(bin[0].filename, 'notes.bin');
  await downloadEquals(bin, images.bin, 'application/octet-stream');
  console.log('PASS A1');

  for (const [server, cookie] of pair) {
    await expectError(server, cookie, space, Buffer.alloc(0), { 'content-type': 'application/octet-stream', 'content-length': '0' }, 400, 'EMPTY_FILE');
  }
  console.log('PASS A2');

  const over = Buffer.alloc(maxFile + 1, 1);
  for (const [server, cookie] of pair) {
    await expectError(server, cookie, space, over, { 'content-type': 'application/octet-stream', 'x-file-name': 'over.bin' }, 413, 'FILE_TOO_LARGE');
    const streamed = await postStream(server, cookie, space, maxFile + 1, { 'content-type': 'application/octet-stream', 'x-file-name': 'stream.bin' });
    assert.equal(streamed.status, 413, server.kind + ' ' + streamed.bytes.toString());
    assert.equal(codeOf(streamed), 'FILE_TOO_LARGE');
  }
  console.log('PASS A3');

  const encodedName = '../..%5Cbad%00%0D%0A%E5%90%8D.png';
  const named = await both(images.png500, { 'content-type': 'image/png', 'x-file-name': encodedName });
  assert.equal(named[0].filename, '_.._bad___名.png');
  assert.equal(named[0].hasThumbnail, true);
  assert.equal([...named[0].filename].some(char => char === '\\' || char === '/' || char === '\0' || char === '\r' || char === '\n'), false);
  const untyped = await both(images.png500, { 'x-file-name': 'plain.png' });
  assert.equal(untyped[0].mime, 'application/octet-stream');
  assert.equal(untyped[0].hasThumbnail, false);
  console.log('PASS A4');

  for (const [server, cookie] of pair) {
    await expectError(server, cookie, space, images.bin, { 'content-type': 'application/octet-stream', 'x-file-name': 'a'.repeat(4097) }, 400, 'INVALID_FILENAME');
    await expectError(server, cookie, space, images.bin, { 'content-type': 'application/octet-stream', 'x-file-name': '%' }, 400, 'INVALID_FILENAME');
  }
  console.log('PASS A5 A6');

  for (const [server, cookie] of pair) {
    const before = await fileNames(server.data);
    const holds = await Promise.all([1, 2, 3, 4].map(() => holdUpload(server, cookie, space)));
    await delay(250);
    const busy = await postFile(server, cookie, space, images.bin, { 'content-type': 'application/octet-stream', 'x-file-name': 'fifth.bin' });
    assert.equal(busy.status, 429, server.kind + ' ' + busy.bytes.toString() + '\n' + server.output);
    assert.equal(codeOf(busy), 'UPLOAD_BUSY');
    for (const socket of holds) socket.destroy();
    await delay(300);
    assert.deepEqual(await fileNames(server.data), before, server.kind + ' hold leaked a file');
    const again = await postFile(server, cookie, space, images.bin, { 'content-type': 'application/octet-stream', 'x-file-name': 'after-busy.bin' });
    assert.equal(again.status, 201, server.kind + ' slot was not released');
  }
  console.log('PASS A7');

  for (const kind of ['ts', 'rust']) {
    const response = await postFile(results[kind].server, results[kind].viewer, space, images.bin, { 'content-type': 'application/octet-stream' });
    assert.equal(response.status, 403, response.bytes.toString());
    assert.equal(codeOf(response), 'READ_ONLY');
    const temporaryResponse = await postFile(results[kind].server, results[kind].temporary, space, images.bin, { 'content-type': 'application/octet-stream' });
    assert.equal(temporaryResponse.status, 403);
    assert.equal(codeOf(temporaryResponse), 'PASSWORD_CHANGE_REQUIRED');
    const stranger = await request(results[kind].server, '/api/spaces/' + space + '/items/' + bin[kind === 'ts' ? 0 : 1].id + '/download', { cookie: results[kind].bob });
    assert.equal(stranger.status, 404);
    assert.equal(codeOf(stranger), 'NOT_FOUND');
  }
  console.log('PASS A8 A9 temporary-password');

  const grouped = await both(images.bin, {
    'content-type': 'application/octet-stream',
    'x-file-name': 'grouped.bin',
    'x-dropit-group': encodeURIComponent('上传分组'),
    'x-dropit-device': 'device1',
    'x-dropit-device-name': encodeURIComponent('测试设备'),
    'x-dropit-device-kind': 'phone',
  });
  assert.equal(grouped[0].group, '上传分组');
  assert.deepEqual(grouped[0].device, { id: 'device1', name: '测试设备', kind: 'phone' });
  for (const [server, cookie] of pair) {
    await expectError(server, cookie, space, images.bin, { 'content-type': 'application/octet-stream', 'x-dropit-group': '%' }, 400, 'INVALID_GROUP');
    await expectError(server, cookie, space, images.bin, { 'content-type': 'application/octet-stream', 'x-dropit-group': encodeURIComponent('全部') }, 400, 'INVALID_GROUP');
  }
  console.log('PASS group and device');

  const svg = await both(images.svg, { 'content-type': 'image/svg+xml', 'x-file-name': 'pic.svg' });
  const html = await both(images.svg, { 'content-type': 'text/html', 'x-file-name': 'pic.html' });
  assert.equal(svg[0].hasThumbnail, false);
  assert.equal(html[0].hasThumbnail, false);
  for (const [index, [server, cookie]] of pair.entries()) {
    for (const action of ['thumbnail', 'media']) {
      const response = await request(server, '/api/spaces/' + space + '/items/' + svg[index].id + '/' + action, { cookie });
      assert.equal(response.status, 404, server.kind + ' ' + action);
    }
    const download = await request(server, '/api/spaces/' + space + '/items/' + svg[index].id + '/download', { cookie });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
  }
  console.log('PASS E7');

  for (const [server, cookie] of pair) {
    await expectError(server, cookie, space, images.svg, { 'content-type': 'image/png', 'x-file-name': 'fake.png' }, 415, 'INVALID_IMAGE');
  }
  console.log('PASS E8');

  const pngSvg = await both(images.pngSvg, { 'content-type': 'image/png', 'x-file-name': 'trail.png' });
  assert.equal(pngSvg[0].hasThumbnail, true);
  console.log('PASS E8b');

  const sized = await both(images.png500, { 'content-type': 'image/png; charset=utf-8', 'x-file-name': 'sized.png' });
  for (const [index, [server, cookie]] of pair.entries()) {
    const thumb = await request(server, '/api/spaces/' + space + '/items/' + sized[index].id + '/thumbnail', { cookie });
    assert.equal(thumb.status, 200, server.kind);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    assert.equal(thumb.headers.get('cache-control'), 'no-store');
    const info = await derived(sharp, thumb.bytes, 320);
    assert.deepEqual([info.width, info.height], [320, 256], server.kind + ' thumbnail ' + info.width + 'x' + info.height);
    note('E9-' + server.kind, { width: info.width, height: info.height, bytes: thumb.bytes.length });
  }
  console.log('PASS E9');

  const tiff = await both(images.tiffDeclared, { 'content-type': 'image/tiff', 'x-file-name': 'scan.tiff' });
  assert.equal(tiff[0].hasThumbnail, false);
  await downloadEquals(tiff, images.tiffDeclared, 'application/octet-stream');
  console.log('PASS E11');

  const boundary = await both(images.png4096, { 'content-type': 'image/png', 'x-file-name': 'edge.png' });
  assert.equal(boundary[0].hasThumbnail, true);
  console.log('PASS E5-legacy');

  const avif = await both(images.avif8, { 'content-type': 'image/avif', 'x-file-name': 'tiny.avif' });
  assert.equal(avif[0].hasThumbnail, true, 'TS AVIF thumbnail missing');
  assert.equal(avif[1].hasThumbnail, true, 'Rust AVIF thumbnail missing\n' + results.rust.server.output);
  for (const [index, [server, cookie]] of pair.entries()) {
    const thumb = await request(server, '/api/spaces/' + space + '/items/' + avif[index].id + '/thumbnail', { cookie });
    assert.equal(thumb.status, 200, server.kind + ' ' + thumb.bytes.toString());
    const preview = await request(server, '/api/spaces/' + space + '/items/' + avif[index].id + '/preview', { cookie });
    assert.equal(preview.status, 200, server.kind + '\n' + server.output);
    assert.equal(preview.headers.get('content-type'), 'image/webp');
    assert.equal(preview.headers.get('content-disposition'), 'inline');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(preview.headers.get('cache-control'), 'private, max-age=60');
    const info = await derived(sharp, preview.bytes);
    assert.deepEqual([info.width, info.height], [8, 4], server.kind);
    note('E10-' + server.kind, { width: info.width, height: info.height, pixel: info.pixel, thumbBytes: thumb.bytes.length, previewBytes: preview.bytes.length });
  }
  const rustPixel = evidence.find(item => item.label === 'E10-rust').pixel;
  assert.ok(rustPixel[0] > 200 && rustPixel[1] < 40 && rustPixel[2] < 40, 'AVIF red pixel ' + rustPixel);
  console.log('PASS E10 F12');

  for (const [server, cookie] of pair) {
    await expectError(server, cookie, space, images.avifHugeIspe, { 'content-type': 'image/avif', 'x-file-name': 'huge-ispe.avif' }, 415, 'INVALID_IMAGE');
    await expectError(server, cookie, space, images.avifForged, { 'content-type': 'image/avif', 'x-file-name': 'forged.avif' }, 415, 'INVALID_IMAGE');
  }
  assert.match(results.rust.server.output, /avif picture allocations=0 reason=ispe/);
  assert.match(results.rust.server.output, /avif picture allocations=0 reason=dav1d/);
  assert.equal(/avif picture allocations=[1-9]/.test(results.rust.server.output), false, results.rust.server.output);
  note('E13', { rustLog: results.rust.server.output.split('\n').filter(line => line.includes('avif picture allocations')) });
  console.log('PASS E13');

  const previews = [
    ['png48', images.png48, 'image/png', 48, 24],
    ['jpeg48', images.jpeg48, 'image/jpeg', 48, 24],
    ['webp8', images.webp8, 'image/webp', 8, 4],
    ['gifStill', images.gifStill, 'image/gif', 48, 24],
  ];
  for (const [label, bytes, mime, width, height] of previews) {
    const uploaded = await both(bytes, { 'content-type': mime, 'x-file-name': label });
    for (const [index, [server, cookie]] of pair.entries()) {
      const beforeFiles = await fileNames(server.data);
      const meBefore = await request(server, '/api/me', { cookie });
      const preview = await request(server, '/api/spaces/' + space + '/items/' + uploaded[index].id + '/preview', { cookie });
      assert.equal(preview.status, 200, server.kind + ' ' + label);
      const info = await derived(sharp, preview.bytes);
      assert.deepEqual([info.width, info.height], [width, height], server.kind + ' ' + label);
      assert.deepEqual(await fileNames(server.data), beforeFiles);
      const meAfter = await request(server, '/api/me', { cookie });
      assert.equal(JSON.parse(meAfter.bytes.toString()).usedBytes, JSON.parse(meBefore.bytes.toString()).usedBytes);
      note('F1-' + label + '-' + server.kind, { width: info.width, height: info.height, pixel: info.pixel });
    }
  }
  console.log('PASS F1');

  const oriented = await both(images.jpegOrient, { 'content-type': 'image/jpeg', 'x-file-name': 'orient.jpg' });
  for (const [index, [server, cookie]] of pair.entries()) {
    const preview = await request(server, '/api/spaces/' + space + '/items/' + oriented[index].id + '/preview', { cookie });
    const info = await derived(sharp, preview.bytes);
    assert.deepEqual([info.width, info.height], [1024, 2048], server.kind + ' ' + info.width + 'x' + info.height);
    note('F2-' + server.kind, { width: info.width, height: info.height, orientation: info.orientation, exif: info.exif });
  }
  console.log('PASS F2');

  const gif = await both(images.gif2, { 'content-type': 'image/gif', 'x-file-name': 'anim.gif' });
  for (const [index, [server, cookie]] of pair.entries()) {
    const preview = await request(server, '/api/spaces/' + space + '/items/' + gif[index].id + '/preview', { cookie });
    const info = await derived(sharp, preview.bytes);
    assert.deepEqual([info.width, info.height], [32, 16], server.kind);
    assert.ok(info.pixel[0] > 240 && info.pixel[2] < 15, server.kind + ' pixel ' + info.pixel);
    note('F3-' + server.kind, { width: info.width, height: info.height, pixel: info.pixel });
  }
  console.log('PASS F3');

  for (const [index, [server, cookie]] of pair.entries()) {
    const missing = await request(server, '/api/spaces/' + space + '/items/' + bin[index].id + '/preview', { cookie });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('content-disposition'), null);
    const wrongSpace = await request(server, '/api/spaces/' + metadata.bobSpace + '/items/' + bin[index].id + '/preview', { cookie });
    assert.equal(wrongSpace.status, 404);
    const anonymous = await request(server, '/api/spaces/' + space + '/items/' + bin[index].id + '/preview', {});
    assert.equal(anonymous.status, 401);
    const stranger = await request(server, '/api/spaces/' + space + '/items/' + bin[index].id + '/preview', { cookie: kindCookie(server, results) });
    assert.equal(stranger.status, 404);
  }
  console.log('PASS F4 F5');

  const expiring = await both(images.png48, { 'content-type': 'image/png', 'x-file-name': 'expire.png' });
  for (const [index, [server, cookie]] of pair.entries()) {
    const expiresAt = Date.now() + 2500;
    const db = new Database(resolve(server.data, 'dropit.sqlite'));
    db.prepare('UPDATE items SET expiresAt=? WHERE id=?').run(expiresAt, expiring[index].id);
    db.close();
    const before = Date.now();
    const preview = await request(server, '/api/spaces/' + space + '/items/' + expiring[index].id + '/preview', { cookie });
    const after = Date.now();
    assert.equal(preview.status, 200, server.kind + ' ' + preview.bytes.toString());
    const actual = Number(preview.headers.get('cache-control').replace('private, max-age=', ''));
    const allowed = new Set([before, after].map(time => Math.min(60, Math.floor((expiresAt - time) / 1000))));
    assert.equal(allowed.has(actual), true, server.kind + ' max-age ' + actual + ' not in ' + [...allowed]);
    note('F11-' + server.kind, { actual, allowed: [...allowed] });
  }
  console.log('PASS F11');

  const rustMeBefore = JSON.parse((await request(results.rust.server, '/api/me', { cookie: results.rust.alice })).bytes.toString());
  const rustFilesBefore = await fileNames(results.rust.server.data);
  const quotaFile = Buffer.alloc(4096, 9);
  for (const kind of ['ts', 'rust']) {
    const server = results[kind].server;
    const cookie = results[kind].alice;
    const me = JSON.parse((await request(server, '/api/me', { cookie })).bytes.toString());
    const db = new Database(resolve(server.data, 'dropit.sqlite'));
    db.prepare('UPDATE users SET quotaBytes=? WHERE id=?').run(me.usedBytes + quotaFile.length, metadata.alice.id);
    db.close();
    const raced = await Promise.all([0, 1].map(() => postFile(server, cookie, space, quotaFile, {
      'content-type': 'application/octet-stream', 'x-file-name': 'quota.bin',
    })));
    const statuses = raced.map(response => response.status).sort();
    assert.deepEqual(statuses, [201, 413], kind + ' ' + raced.map(response => response.status + codeOf(response)).join(','));
    assert.equal(raced.find(response => response.status === 413) && codeOf(raced.find(response => response.status === 413)), 'QUOTA_EXCEEDED');
    const after = JSON.parse((await request(server, '/api/me', { cookie })).bytes.toString());
    assert.equal(after.usedBytes, me.usedBytes + quotaFile.length, kind + ' usedBytes');
    const reset = new Database(resolve(server.data, 'dropit.sqlite'));
    reset.prepare('UPDATE users SET quotaBytes=NULL WHERE id=?').run(metadata.alice.id);
    reset.close();
  }
  const rustFilesAfterQuota = await fileNames(results.rust.server.data);
  assert.equal(rustFilesAfterQuota.length, rustFilesBefore.length + 1, 'quota loser left a file');
  assert.equal(JSON.parse((await request(results.rust.server, '/api/me', { cookie: results.rust.alice })).bytes.toString()).usedBytes, rustMeBefore.usedBytes + quotaFile.length);
  console.log('PASS quota race');

  for (const [server, cookie] of pair) {
    const created = await request(server, '/api/spaces/' + space + '/items/text', {
      method: 'POST', cookie, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'retract me' }),
    });
    assert.equal(created.status, 201, created.bytes.toString());
    const id = JSON.parse(created.bytes.toString()).item.id;
    const removed = await request(server, '/api/spaces/' + space + '/items/' + id, { method: 'DELETE', cookie });
    assert.equal(removed.status, 204, server.kind + ' ' + removed.bytes.toString());
    const snapshot = await request(server, '/api/spaces/' + space + '/items', { cookie });
    assert.equal(JSON.parse(snapshot.bytes.toString()).items.some(item => item.id === id), false);
  }
  console.log('PASS text DELETE');

  const dbTs = new Database(resolve(results.ts.server.data, 'dropit.sqlite'));
  const dbRust = new Database(resolve(results.rust.server.data, 'dropit.sqlite'));
  for (const db of [dbTs, dbRust]) {
    db.prepare('INSERT INTO members (spaceId, userId, role) VALUES (?, ?, ?)').run(space, metadata.bob.id, 'editor');
    db.close();
  }
  const bobFile = [];
  for (const kind of ['ts', 'rust']) {
    const response = await postFile(results[kind].server, results[kind].bob, space, images.bin, {
      'content-type': 'application/octet-stream', 'x-file-name': 'bob.bin',
    });
    assert.equal(response.status, 201, kind + ' ' + response.bytes.toString());
    bobFile.push(itemOf(response));
  }
  for (const [index, kind] of ['ts', 'rust'].entries()) {
    const forbidden = await request(results[kind].server, '/api/spaces/' + space + '/items/' + named[index].id, {
      method: 'DELETE', cookie: results[kind].bob,
    });
    assert.equal(forbidden.status, 403, kind);
    assert.equal(codeOf(forbidden), 'FORBIDDEN');
    const removed = await request(results[kind].server, '/api/spaces/' + space + '/items/' + bobFile[index].id, {
      method: 'DELETE', cookie: results[kind].alice,
    });
    assert.equal(removed.status, 204, kind + ' owner delete');
  }
  console.log('PASS editor FORBIDDEN and owner delete');

  const retractFiles = await fileNames(results.rust.server.data);
  const retractUpload = await postFile(results.rust.server, results.rust.alice, space, images.png48, {
    'content-type': 'image/png', 'x-file-name': 'gone.png',
  });
  const retractItem = itemOf(retractUpload);
  const added = (await fileNames(results.rust.server.data)).filter(name => !retractFiles.includes(name));
  assert.equal(added.length, 2);
  for (const name of added) {
    const mode = (await stat(resolve(results.rust.server.data, 'files', name))).mode & 0o777;
    assert.equal(mode, 0o600, name);
  }
  const dirMode = (await stat(resolve(results.rust.server.data, 'files'))).mode & 0o777;
  assert.equal(dirMode, 0o700);
  const deleted = await request(results.rust.server, '/api/spaces/' + space + '/items/' + retractItem.id, {
    method: 'DELETE', cookie: results.rust.alice,
  });
  assert.equal(deleted.status, 204);
  for (const action of ['download', 'thumbnail', 'preview']) {
    const response = await request(results.rust.server, '/api/spaces/' + space + '/items/' + retractItem.id + '/' + action, {
      cookie: results.rust.alice,
    });
    assert.equal(response.status, 404, action);
  }
  const afterDelete = await fileNames(results.rust.server.data);
  assert.equal(added.some(name => afterDelete.includes(name)), false);
  console.log('PASS A10');

  const tsThumb = await request(results.ts.server, '/api/spaces/' + space + '/items/' + avif[0].id + '/thumbnail', { cookie: results.ts.alice });
  const tsDownload = await request(results.ts.server, '/api/spaces/' + space + '/items/' + avif[0].id + '/download', { cookie: results.ts.alice });
  assert.equal(tsDownload.bytes.equals(images.avif8), true);

  await stop(results.rust.server);
  const e12Key = randomUUID();
  const e12Thumb = randomUUID();
  await mkdir(resolve(results.rust.server.data, 'files'), { recursive: true });
  await writeFile(resolve(results.rust.server.data, 'files', e12Key), images.avif8);
  await writeFile(resolve(results.rust.server.data, 'files', e12Thumb), tsThumb.bytes);
  const e12Db = new Database(resolve(results.rust.server.data, 'dropit.sqlite'));
  const nowMs = Date.now();
  const e12Id = randomUUID();
  e12Db.prepare(`INSERT INTO items (id,spaceId,userId,kind,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt,pinned,tags)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,'[]')`).run(
    e12Id, space, metadata.alice.id, 'file', 'stored.avif', 'image/avif', images.avif8.length,
    images.avif8.length + tsThumb.bytes.length, e12Key, e12Thumb, nowMs, nowMs + 86400000, nowMs,
  );
  e12Db.close();
  results.rust.server = await start('rust', results.rust.server.data);
  results.rust.alice = await login(results.rust.server, 'alice@example.test');
  const e12Files = await fileNames(results.rust.server.data);
  const e12Me = JSON.parse((await request(results.rust.server, '/api/me', { cookie: results.rust.alice })).bytes.toString());
  const e12Download = await request(results.rust.server, '/api/spaces/' + space + '/items/' + e12Id + '/download', { cookie: results.rust.alice });
  const e12StoredThumb = await request(results.rust.server, '/api/spaces/' + space + '/items/' + e12Id + '/thumbnail', { cookie: results.rust.alice });
  const e12Preview = await request(results.rust.server, '/api/spaces/' + space + '/items/' + e12Id + '/preview', { cookie: results.rust.alice });
  assert.equal(e12Download.bytes.equals(images.avif8), true);
  assert.equal(e12StoredThumb.bytes.equals(tsThumb.bytes), true, 'stored thumbnail was re-encoded');
  assert.equal(e12Preview.status, 200, results.rust.server.output);
  const e12Info = await derived(sharp, e12Preview.bytes);
  assert.deepEqual([e12Info.width, e12Info.height], [8, 4]);
  assert.deepEqual(await fileNames(results.rust.server.data), e12Files);
  assert.equal(JSON.parse((await request(results.rust.server, '/api/me', { cookie: results.rust.alice })).bytes.toString()).usedBytes, e12Me.usedBytes);
  note('E12', { download: e12Download.bytes.length, thumbnail: e12StoredThumb.bytes.length, preview: [e12Info.width, e12Info.height] });
  console.log('PASS E12');

  const g1 = await postFile(results.rust.server, results.rust.alice, space, images.png48, {
    'content-type': 'image/png', 'x-file-name': 'restart.png',
  });
  const g1Item = itemOf(g1);
  const g1Download = await request(results.rust.server, '/api/spaces/' + space + '/items/' + g1Item.id + '/download', { cookie: results.rust.alice });
  const g1Thumb = await request(results.rust.server, '/api/spaces/' + space + '/items/' + g1Item.id + '/thumbnail', { cookie: results.rust.alice });
  await stop(results.rust.server);
  results.rust.server = await start('rust', results.rust.server.data);
  results.rust.alice = await login(results.rust.server, 'alice@example.test');
  const g1DownloadAgain = await request(results.rust.server, '/api/spaces/' + space + '/items/' + g1Item.id + '/download', { cookie: results.rust.alice });
  const g1ThumbAgain = await request(results.rust.server, '/api/spaces/' + space + '/items/' + g1Item.id + '/thumbnail', { cookie: results.rust.alice });
  assert.equal(g1DownloadAgain.bytes.equals(g1Download.bytes), true);
  assert.equal(g1ThumbAgain.bytes.equals(g1Thumb.bytes), true);
  console.log('PASS G1');

  await stop(results.rust.server);
  results.rust.server = await start('rust', results.rust.server.data, { DROPIT_PREVIEW_HOLD_MS: '1500' });
  results.rust.alice = await login(results.rust.server, 'alice@example.test');
  const f9Files = await fileNames(results.rust.server.data);
  const f9Promise = request(results.rust.server, '/api/spaces/' + space + '/items/' + g1Item.id + '/preview', { cookie: results.rust.alice });
  await delay(200);
  const f9Delete = await request(results.rust.server, '/api/spaces/' + space + '/items/' + g1Item.id, {
    method: 'DELETE', cookie: results.rust.alice,
  });
  assert.equal(f9Delete.status, 204);
  const f9Preview = await f9Promise;
  assert.equal(f9Preview.status, 404, 'F9 status ' + f9Preview.status + '\n' + results.rust.server.output);
  const f9After = await fileNames(results.rust.server.data);
  assert.equal(f9After.length < f9Files.length, true);
  assert.equal(f9After.length, f9Files.length - 2);
  console.log('PASS F9');

  const f10Item = itemOf(await postFile(results.rust.server, results.rust.alice, space, images.png48, {
    'content-type': 'image/png', 'x-file-name': 'busy-preview.png',
  }));
  const f10 = await Promise.all([1, 2, 3].map(() => request(results.rust.server, '/api/spaces/' + space + '/items/' + f10Item.id + '/preview', {
    cookie: results.rust.alice,
  })));
  const f10Statuses = f10.map(response => response.status).sort();
  assert.deepEqual(f10Statuses, [200, 200, 429], f10.map(response => response.status + (codeOf(response) || '')).join(',') + '\n' + results.rust.server.output);
  assert.equal(codeOf(f10.find(response => response.status === 429)), 'PREVIEW_BUSY');
  console.log('PASS F10');

  const beforeDisconnect = await fileNames(results.rust.server.data);
  await new Promise((resolveHold, reject) => {
    const url = new URL(results.rust.server.url);
    const socket = connect(url.port, url.hostname, () => {
      socket.write(
        'POST /api/spaces/' + space + '/items/file HTTP/1.1\r\n' +
        'Host: ' + url.host + '\r\nOrigin: ' + results.rust.server.origin + '\r\n' +
        'Cookie: ' + results.rust.alice + '\r\nContent-Type: application/octet-stream\r\n' +
        'Content-Length: 1000\r\nX-File-Name: partial.bin\r\n\r\nhello',
      );
      setTimeout(() => { socket.destroy(); resolveHold(); }, 80);
    });
    socket.on('error', () => {});
    socket.on('close', () => {});
    socket.setTimeout(2000, () => reject(new Error('disconnect socket hung')));
  });
  await delay(300);
  assert.deepEqual(await fileNames(results.rust.server.data), beforeDisconnect, 'disconnect left a file');
  const snapshot = JSON.parse((await request(results.rust.server, '/api/spaces/' + space + '/items', { cookie: results.rust.alice })).bytes.toString());
  assert.equal(snapshot.items.some(item => item.filename === 'partial.bin'), false);
  console.log('PASS disconnect cleanup');

  const capData = resolve(temporary, 'cap');
  await cp(seed, capData, { recursive: true });
  const capServer = await start('rust', capData, { MAX_ITEMS: '2' });
  const capCookie = await login(capServer, 'alice@example.test');
  const capRace = await Promise.all([0, 1].map(() => postFile(capServer, capCookie, space, images.bin, {
    'content-type': 'application/octet-stream', 'x-file-name': 'cap.bin',
  })));
  assert.deepEqual(capRace.map(response => response.status).sort(), [201, 413]);
  assert.equal(codeOf(capRace.find(response => response.status === 413)), 'ITEM_LIMIT');
  const capFiles = await fileNames(capData);
  assert.equal(capFiles.length, 1, 'item-cap loser left a file');
  await stop(capServer);
  console.log('PASS item-cap race');

  await chunkSessions(results, space, metadata.bobSpace, images, Database, sharp);

  await writeFile(resolve(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS upload checks ' + checks + ' HTTP responses');
} finally {
  await Promise.all([...processes].map(async child => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([exited, delay(1000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }));
  if (process.env.KEEP_UPLOAD_TMP !== '1') await rm(temporary, { recursive: true, force: true });
}

function kindCookie(server, results) {
  return server.kind === 'ts' ? results.ts.bob : results.rust.bob;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function chunkParts(bytes, size) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += size) parts.push(bytes.subarray(offset, offset + size));
  return parts;
}

async function openUpload(server, cookie, space, bytes, filename, mime) {
  const response = await request(server, '/api/spaces/' + space + '/uploads', {
    method: 'POST', cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename, size: bytes.length, mime }),
  });
  return response;
}

async function putChunk(server, cookie, space, id, index, bytes, headers = {}) {
  return request(server, '/api/spaces/' + space + '/uploads/' + id + '/chunks/' + index, {
    method: 'PUT', cookie, body: bytes, headers,
  });
}

async function finishUpload(server, cookie, space, id, headers = {}) {
  return request(server, '/api/spaces/' + space + '/uploads/' + id + '/complete', {
    method: 'POST', cookie, headers,
  });
}

async function chunkSessions(results, space, otherSpace, images, Database, sharp) {
  const chunkSize = 64 * 1024;
  const pair = [
    [results.ts.server, results.ts.alice, 'ts'],
    [results.rust.server, results.rust.alice, 'rust'],
  ];

  for (const [server, cookie, kind] of pair) {
    const created = await openUpload(server, cookie, space, images.bin, '../..\\bad\u0000名.bin', 'APPLICATION/OCTET-STREAM; charset=utf-8');
    assert.equal(created.status, 201, kind + ' ' + created.bytes.toString());
    const body = JSON.parse(created.bytes.toString());
    assert.equal(body.chunkSize, chunkSize);
    assert.deepEqual(body.received, []);
    assert.equal(typeof body.expiresAt, 'number');
    const put = await putChunk(server, cookie, space, body.uploadId, 0, images.bin, {
      'x-chunk-sha256': sha256(images.bin),
    });
    assert.equal(put.status, 204, kind + ' ' + put.bytes.toString());
    const again = await putChunk(server, cookie, space, body.uploadId, 0, images.bin);
    assert.equal(again.status, 204, kind + ' identical retry');
    const status = await request(server, '/api/spaces/' + space + '/uploads/' + body.uploadId, { cookie });
    assert.deepEqual(JSON.parse(status.bytes.toString()).received, [0]);
    const item = itemOf(await finishUpload(server, cookie, space, body.uploadId));
    assert.equal(item.filename, '_.._bad_名.bin');
    assert.equal(item.filename.includes('\\') || item.filename.includes('/') || item.filename.includes('\0'), false);
    assert.equal(item.mime, 'application/octet-stream');
    assert.equal(item.hasThumbnail, false);
    assert.equal(item.size, images.bin.length);
    const download = await request(server, '/api/spaces/' + space + '/items/' + item.id + '/download', { cookie });
    assert.equal(download.status, 200);
    assert.equal(download.bytes.equals(images.bin), true);
    const repeat = await finishUpload(server, cookie, space, body.uploadId);
    assert.equal(repeat.status, 404, kind + ' repeat complete');
    assert.equal(codeOf(repeat), 'NOT_FOUND');
    const me = JSON.parse((await request(server, '/api/me', { cookie })).bytes.toString());
    note(kind + '-C1', { status: created.status, chunkSize: body.chunkSize, filename: item.filename, download: download.bytes.length, reservedBytes: me.reservedBytes });
  }
  console.log('PASS C1 create resume identical complete');

  for (const [server, cookie, kind] of pair) {
    const payload = Buffer.concat([Buffer.alloc(chunkSize, 1), Buffer.alloc(100, 2)]);
    const created = JSON.parse((await openUpload(server, cookie, space, payload, 'parts.bin', 'application/octet-stream')).bytes.toString());
    const parts = chunkParts(payload, chunkSize);
    const second = await putChunk(server, cookie, space, created.uploadId, 1, parts[1]);
    assert.equal(second.status, 204, kind + ' out of order');
    const early = await finishUpload(server, cookie, space, created.uploadId);
    assert.equal(early.status, 400);
    assert.equal(codeOf(early), 'UPLOAD_INCOMPLETE');
    const missing = await request(server, '/api/spaces/' + space + '/uploads/' + created.uploadId, { cookie });
    assert.equal(missing.status, 404, kind + ' failed complete kept the session');
    const badIndex = await openUpload(server, cookie, space, images.bin, 'index.bin', 'application/octet-stream');
    const session = JSON.parse(badIndex.bytes.toString());
    const overIndex = await putChunk(server, cookie, space, session.uploadId, 1, images.bin);
    assert.equal(overIndex.status, 400);
    assert.equal(codeOf(overIndex), 'INVALID_CHUNK_INDEX');
    const leading = await putChunk(server, cookie, space, session.uploadId, '01', images.bin);
    assert.equal(leading.status, 400);
    assert.equal(codeOf(leading), 'INVALID_CHUNK_INDEX');
    const short = await putChunk(server, cookie, space, session.uploadId, 0, images.bin.subarray(0, 2));
    assert.equal(short.status, 400);
    assert.equal(codeOf(short), 'CHUNK_SIZE_MISMATCH');
    const long = await putChunk(server, cookie, space, session.uploadId, 0, Buffer.concat([images.bin, Buffer.from('x')]));
    assert.equal(long.status, 413);
    assert.equal(codeOf(long), 'FILE_TOO_LARGE');
    const empty = await request(server, '/api/spaces/' + space + '/uploads/' + session.uploadId + '/chunks/0', {
      method: 'PUT', cookie, headers: { 'content-length': '0' },
    });
    assert.equal(empty.status, 400);
    assert.equal(codeOf(empty), 'EMPTY_FILE');
    const badSum = await putChunk(server, cookie, space, session.uploadId, 0, images.bin, { 'x-chunk-sha256': 'ab' });
    assert.equal(badSum.status, 400);
    assert.equal(codeOf(badSum), 'INVALID_CHECKSUM');
    const mismatch = await putChunk(server, cookie, space, session.uploadId, 0, images.bin, { 'x-chunk-sha256': 'a'.repeat(64) });
    assert.equal(mismatch.status, 400);
    assert.equal(codeOf(mismatch), 'CHECKSUM_MISMATCH');
    const stored = await putChunk(server, cookie, space, session.uploadId, 0, images.bin);
    assert.equal(stored.status, 204);
    const conflict = await putChunk(server, cookie, space, session.uploadId, 0, Buffer.alloc(images.bin.length, 9));
    assert.equal(conflict.status, 409);
    assert.equal(codeOf(conflict), 'CHUNK_CONFLICT');
    const kept = await request(server, '/api/spaces/' + space + '/uploads/' + session.uploadId, { cookie });
    assert.deepEqual(JSON.parse(kept.bytes.toString()).received, [0]);
    await request(server, '/api/spaces/' + space + '/uploads/' + session.uploadId, { method: 'DELETE', cookie });
    note(kind + '-C2', { incomplete: early.status, conflict: conflict.status, short: short.status, long: long.status });
  }
  console.log('PASS C2 order conflict checksum bounds');

  for (const [server, cookie, kind] of pair) {
    const created = JSON.parse((await openUpload(server, cookie, space, images.png48, 'photo.png', 'image/png')).bytes.toString());
    assert.equal((await putChunk(server, cookie, space, created.uploadId, 0, images.png48)).status, 204);
    const done = await finishUpload(server, cookie, space, created.uploadId, {
      'x-dropit-group': encodeURIComponent('分片组'),
      'x-dropit-device': 'chunk-device',
      'x-dropit-device-name': encodeURIComponent('分片设备'),
      'x-dropit-device-kind': 'pc',
    });
    const item = itemOf(done);
    assert.equal(item.hasThumbnail, true);
    assert.equal(item.group, '分片组');
    assert.deepEqual(item.device, { id: 'chunk-device', name: '分片设备', kind: 'pc' });
    const download = await request(server, '/api/spaces/' + space + '/items/' + item.id + '/download', { cookie });
    assert.equal(download.bytes.equals(images.png48), true);
    const thumb = await request(server, '/api/spaces/' + space + '/items/' + item.id + '/thumbnail', { cookie });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    const info = await derived(sharp, thumb.bytes, 320);
    assert.ok(info.width <= 320 && info.height <= 320);
    const ranged = await request(server, '/api/spaces/' + space + '/items/' + item.id + '/download', {
      cookie, headers: { range: 'bytes=0-3' },
    });
    assert.equal(ranged.status, 206, kind + ' ' + ranged.bytes.toString());
    assert.equal(ranged.bytes.equals(images.png48.subarray(0, 4)), true);
    const media = await request(server, '/api/spaces/' + space + '/items/' + item.id + '/media', { cookie });
    assert.equal(media.status, 404, kind + ' png is not media');
    note(kind + '-C3', { thumb: thumb.bytes.length, width: info.width, height: info.height, range: ranged.status });
  }
  console.log('PASS C3 image thumbnail range');

  for (const [server, cookie, kind] of pair) {
    const svg = JSON.parse((await openUpload(server, cookie, space, images.svg, 'pic.svg', 'image/svg+xml')).bytes.toString());
    await putChunk(server, cookie, space, svg.uploadId, 0, images.svg);
    const rejected = await finishUpload(server, cookie, space, svg.uploadId);
    assert.equal(rejected.status, 415, kind);
    assert.equal(codeOf(rejected), 'INVALID_IMAGE');
    const disguised = Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), Buffer.alloc(8, 1)]);
    const fake = JSON.parse((await openUpload(server, cookie, space, disguised, 'fake.bin', 'application/octet-stream')).bytes.toString());
    await putChunk(server, cookie, space, fake.uploadId, 0, disguised);
    const sniffed = await finishUpload(server, cookie, space, fake.uploadId);
    assert.equal(sniffed.status, 415);
    assert.equal(codeOf(sniffed), 'INVALID_IMAGE');
    const legacy = await postFile(server, cookie, space, images.svg, { 'content-type': 'image/svg+xml', 'x-file-name': 'legacy.svg' });
    assert.equal(legacy.status, 201, kind + ' legacy SVG must stay download-only');
    const corrupt = JSON.parse((await openUpload(server, cookie, space, Buffer.from('not-png'), 'bad.png', 'image/png')).bytes.toString());
    await putChunk(server, cookie, space, corrupt.uploadId, 0, Buffer.from('not-png'));
    const broken = await finishUpload(server, cookie, space, corrupt.uploadId);
    assert.equal(broken.status, 415);
    assert.equal(codeOf(broken), 'INVALID_IMAGE');
    const huge = JSON.parse((await openUpload(server, cookie, space, images.png4096, 'edge.png', 'image/png')).bytes.toString());
    for (const [index, part] of chunkParts(images.png4096, chunkSize).entries()) {
      const put = await putChunk(server, cookie, space, huge.uploadId, index, part);
      assert.equal(put.status, 204, kind + ' 4096 chunk ' + index);
    }
    const edge = await finishUpload(server, cookie, space, huge.uploadId);
    assert.equal(edge.status, 201, kind + ' ' + edge.bytes.toString());
    assert.equal(itemOf(edge).hasThumbnail, true);
    note(kind + '-C4', { svg: rejected.status, disguised: sniffed.status, corrupt: broken.status, edge: edge.status });
  }
  console.log('PASS C4 svg corrupt pixel edge');

  for (const [server, cookie, kind] of pair) {
    const editor = await openUpload(server, results[kind].bob, space, images.bin, 'editor.bin', 'application/octet-stream');
    assert.equal(editor.status, 201, kind + ' editor create ' + editor.bytes.toString());
    const editorId = JSON.parse(editor.bytes.toString()).uploadId;
    const ownerPeek = await request(server, '/api/spaces/' + space + '/uploads/' + editorId, { cookie });
    assert.equal(ownerPeek.status, 404, kind + ' owner cannot see another member session');
    await request(server, '/api/spaces/' + space + '/uploads/' + editorId, { method: 'DELETE', cookie: results[kind].bob });
    const hidden = await openUpload(server, cookie, otherSpace, images.bin, 'hidden.bin', 'application/octet-stream');
    assert.equal(hidden.status, 404, kind + ' non-member');
    const viewer = await openUpload(server, results[kind].viewer, space, images.bin, 'view.bin', 'application/octet-stream');
    assert.equal(viewer.status, 403);
    assert.equal(codeOf(viewer), 'READ_ONLY');
    const temporary = await openUpload(server, results[kind].temporary, space, images.bin, 'temp.bin', 'application/octet-stream');
    assert.equal(temporary.status, 403);
    assert.equal(codeOf(temporary), 'PASSWORD_CHANGE_REQUIRED');
    const mine = JSON.parse((await openUpload(server, cookie, space, images.bin, 'mine.bin', 'application/octet-stream')).bytes.toString());
    const otherGet = await request(server, '/api/spaces/' + space + '/uploads/' + mine.uploadId, { cookie: results[kind].bob });
    assert.equal(otherGet.status, 404);
    await request(server, '/api/spaces/' + space + '/uploads/' + mine.uploadId, { method: 'DELETE', cookie });
  }
  console.log('PASS C5 auth');

  for (const [server, cookie, kind] of pair) {
    const payload = Buffer.alloc(chunkSize + 8, 3);
    const created = JSON.parse((await openUpload(server, cookie, space, payload, 'race.bin', 'application/octet-stream')).bytes.toString());
    const parts = chunkParts(payload, chunkSize);
    const writes = await Promise.all(parts.map((part, index) => putChunk(server, cookie, space, created.uploadId, index, part)));
    assert.deepEqual(writes.map(response => response.status).sort(), [204, 204], kind);
    const raced = await Promise.all([0, 1].map(() => finishUpload(server, cookie, space, created.uploadId)));
    const statuses = raced.map(response => response.status).sort();
    assert.deepEqual(statuses, [201, 409], kind + ' ' + raced.map(response => response.status + (codeOf(response) || '')).join(','));
    assert.equal(codeOf(raced.find(response => response.status === 409)), 'UPLOAD_IN_PROGRESS');
    const winner = itemOf(raced.find(response => response.status === 201));
    const download = await request(server, '/api/spaces/' + space + '/items/' + winner.id + '/download', { cookie });
    assert.equal(download.bytes.equals(payload), true);
    const snapshot = JSON.parse((await request(server, '/api/spaces/' + space + '/items', { cookie })).bytes.toString());
    assert.equal(snapshot.items.filter(item => item.filename === 'race.bin').length, 1);
    note(kind + '-C6', { statuses });
  }
  console.log('PASS C6 overlapping complete');

  for (const [server, cookie, kind] of pair) {
    const created = JSON.parse((await openUpload(server, cookie, space, images.bin, 'cancel.bin', 'application/octet-stream')).bytes.toString());
    const held = new Promise((resolveHold, reject) => {
      const url = new URL(server.url);
      const socket = connect(url.port, url.hostname, () => {
        socket.write(
          'PUT /api/spaces/' + space + '/uploads/' + created.uploadId + '/chunks/0 HTTP/1.1\r\n' +
          'Host: ' + url.host + '\r\nOrigin: ' + server.origin + '\r\nCookie: ' + cookie + '\r\n' +
          'Content-Length: ' + (images.bin.length + 100000) + '\r\n\r\n' + images.bin.toString('latin1'),
        );
        resolveHold(socket);
      });
      socket.on('error', () => {});
      socket.setTimeout(4000, () => reject(new Error(kind + ' cancel socket hung')));
    });
    const socket = await held;
    await delay(80);
    const cancelled = await request(server, '/api/spaces/' + space + '/uploads/' + created.uploadId, { method: 'DELETE', cookie });
    assert.equal(cancelled.status, 204, kind + ' ' + cancelled.bytes.toString() + '\n' + server.output);
    socket.destroy();
    await delay(200);
    const gone = await request(server, '/api/spaces/' + space + '/uploads/' + created.uploadId, { cookie });
    assert.equal(gone.status, 404);
    const late = await putChunk(server, cookie, space, created.uploadId, 0, images.bin);
    assert.equal(late.status, 404);
    const files = await fileNames(server.data);
    const db = new Database(resolve(server.data, 'dropit.sqlite'), { readonly: true });
    const chunks = db.prepare('SELECT count(*) AS n FROM upload_chunks WHERE uploadId=?').get(created.uploadId).n;
    const garbage = db.prepare('SELECT count(*) AS n FROM garbage').get().n;
    db.close();
    assert.equal(chunks, 0);
    assert.equal(garbage, 0, kind + ' cancel left garbage');
    note(kind + '-C7', { cancel: cancelled.status, files: files.length, chunks, garbage });
  }
  console.log('PASS C7 cancel in flight');

  for (const kind of ['ts', 'rust']) {
    const data = resolve(temporary, 'quota-' + kind);
    await cp(resolve(temporary, 'seed'), data, { recursive: true });
    const quotaDb = new Database(resolve(data, 'dropit.sqlite'));
    quotaDb.prepare('UPDATE users SET quotaBytes=? WHERE email=?').run(1024 * 1024, 'alice@example.test');
    quotaDb.close();
    const server = await start(kind, data);
    const cookie = await login(server, 'alice@example.test');
    const before = JSON.parse((await request(server, '/api/me', { cookie })).bytes.toString());
    const quotaBytes = Buffer.alloc(400 * 1024, 5);
    const reserved = JSON.parse((await openUpload(server, cookie, space, quotaBytes, 'reserved.bin', 'application/octet-stream')).bytes.toString());
    const during = JSON.parse((await request(server, '/api/me', { cookie })).bytes.toString());
    assert.equal(during.reservedBytes, before.reservedBytes + quotaBytes.length, kind + ' reserved ' + during.reservedBytes);
    const over = await openUpload(server, cookie, space, Buffer.alloc(700 * 1024, 6), 'over.bin', 'application/octet-stream');
    assert.equal(over.status, 413, kind + ' ' + over.bytes.toString());
    assert.equal(codeOf(over), 'QUOTA_EXCEEDED');
    for (const [index, part] of chunkParts(quotaBytes, chunkSize).entries()) {
      assert.equal((await putChunk(server, cookie, space, reserved.uploadId, index, part)).status, 204);
    }
    const done = await finishUpload(server, cookie, space, reserved.uploadId);
    assert.equal(done.status, 201, kind + ' ' + done.bytes.toString());
    const after = JSON.parse((await request(server, '/api/me', { cookie })).bytes.toString());
    assert.equal(after.reservedBytes, before.reservedBytes);
    assert.ok(after.usedBytes >= before.usedBytes + quotaBytes.length);
    const raced = await Promise.all([0, 1].map(() => openUpload(server, cookie, space, Buffer.alloc(500 * 1024, 8), 'race-quota.bin', 'application/octet-stream')));
    assert.deepEqual(raced.map(response => response.status).sort(), [201, 413], kind + ' quota race');
    assert.equal(codeOf(raced.find(response => response.status === 413)), 'QUOTA_EXCEEDED');
    await stop(server);
    note(kind + '-C8', { reserved: during.reservedBytes, used: after.usedBytes, over: over.status, race: raced.map(response => response.status).sort() });
  }
  console.log('PASS C8 quota reservation');

  for (const kind of ['ts', 'rust']) {
    const data = resolve(temporary, 'sessions-' + kind);
    await cp(resolve(temporary, 'seed'), data, { recursive: true });
    const server = await start(kind, data, { UPLOAD_SESSIONS_PER_USER: '1', UPLOAD_SESSIONS_GLOBAL: '2' });
    const cookie = await login(server, 'alice@example.test');
    const first = await openUpload(server, cookie, space, images.bin, 'one.bin', 'application/octet-stream');
    assert.equal(first.status, 201, kind);
    const second = await openUpload(server, cookie, space, images.bin, 'two.bin', 'application/octet-stream');
    assert.equal(second.status, 429, kind + ' ' + second.bytes.toString());
    assert.equal(codeOf(second), 'UPLOAD_SESSION_LIMIT');
    assert.equal(second.headers.get('retry-after'), '1');
    await stop(server);
    note(kind + '-C9', { first: first.status, second: second.status });
  }
  console.log('PASS C9 session limit');

  for (const kind of ['ts', 'rust']) {
    const data = resolve(temporary, 'busy-' + kind);
    await cp(resolve(temporary, 'seed'), data, { recursive: true });
    const server = await start(kind, data, { UPLOAD_CHUNKS_PER_SESSION: '1' });
    const cookie = await login(server, 'alice@example.test');
    const payload = Buffer.alloc(chunkSize + 4, 7);
    const created = JSON.parse((await openUpload(server, cookie, space, payload, 'busy.bin', 'application/octet-stream')).bytes.toString());
    const held = await new Promise((resolveHold, reject) => {
      const url = new URL(server.url);
      const socket = connect(url.port, url.hostname, () => {
        socket.write(
          'PUT /api/spaces/' + space + '/uploads/' + created.uploadId + '/chunks/0 HTTP/1.1\r\n' +
          'Host: ' + url.host + '\r\nOrigin: ' + server.origin + '\r\nCookie: ' + cookie + '\r\n' +
          'Content-Length: ' + (chunkSize + 1000) + '\r\n\r\n',
        );
        resolveHold(socket);
      });
      socket.on('error', () => {});
      socket.setTimeout(4000, () => reject(new Error(kind + ' busy socket hung')));
    });
    await delay(80);
    const busy = await putChunk(server, cookie, space, created.uploadId, 1, payload.subarray(chunkSize));
    assert.equal(busy.status, 429, kind + ' ' + busy.bytes.toString() + '\n' + server.output);
    assert.equal(codeOf(busy), 'CHUNK_BUSY');
    assert.equal(busy.headers.get('retry-after'), '1');
    held.destroy();
    await delay(200);
    await stop(server);
    note(kind + '-C10', { busy: busy.status });
  }
  console.log('PASS C10 chunk busy');

  for (const kind of ['ts', 'rust']) {
    const data = resolve(temporary, 'expire-' + kind);
    await cp(resolve(temporary, 'seed'), data, { recursive: true });
    const extra = kind === 'rust' ? { DROPIT_SWEEP_ON_SPACES: '1', DROPIT_SWEEP_OLDER_THAN: '1' } : {};
    const server = await start(kind, data, extra);
    const cookie = await login(server, 'alice@example.test');
    const created = JSON.parse((await openUpload(server, cookie, space, images.bin, 'stale.bin', 'application/octet-stream')).bytes.toString());
    await putChunk(server, cookie, space, created.uploadId, 0, images.bin);
    const before = await fileNames(data);
    const db = new Database(resolve(data, 'dropit.sqlite'));
    db.prepare('UPDATE uploads SET expiresAt=? WHERE id=?').run(1, created.uploadId);
    db.close();
    if (kind === 'ts') {
      await stop(server);
      const restarted = await start(kind, data);
      const cookie2 = await login(restarted, 'alice@example.test');
      const gone = await request(restarted, '/api/spaces/' + space + '/uploads/' + created.uploadId, { cookie: cookie2 });
      assert.equal(gone.status, 404);
      await delay(100);
      await stop(restarted);
    } else {
      const listed = await request(server, '/api/spaces', { cookie });
      assert.equal(listed.status, 200);
      const gone = await request(server, '/api/spaces/' + space + '/uploads/' + created.uploadId, { cookie });
      assert.equal(gone.status, 404);
      await stop(server);
    }
    const afterDb = new Database(resolve(data, 'dropit.sqlite'), { readonly: true });
    const uploads = afterDb.prepare('SELECT count(*) AS n FROM uploads WHERE id=?').get(created.uploadId).n;
    const garbage = afterDb.prepare('SELECT count(*) AS n FROM garbage').get().n;
    afterDb.close();
    const after = await fileNames(data);
    assert.equal(uploads, 0, kind + ' expired session remained');
    assert.equal(garbage, 0, kind + ' garbage remained ' + garbage);
    assert.equal(after.length < before.length, true, kind + ' chunk file remained');
    note(kind + '-C11', { before: before.length, after: after.length, uploads, garbage });
  }
  console.log('PASS C11 expiry garbage');

  const restarted = await start('rust', results.rust.server.data);
  const restartedCookie = await login(restarted, 'alice@example.test');
  const resumePayload = Buffer.alloc(chunkSize + 16, 4);
  const resume = JSON.parse((await openUpload(restarted, restartedCookie, space, resumePayload, 'resume.bin', 'application/octet-stream')).bytes.toString());
  const resumeParts = chunkParts(resumePayload, chunkSize);
  assert.equal((await putChunk(restarted, restartedCookie, space, resume.uploadId, 0, resumeParts[0])).status, 204);
  await stop(restarted);
  const resumed = await start('rust', results.rust.server.data);
  const resumedCookie = await login(resumed, 'alice@example.test');
  const status = JSON.parse((await request(resumed, '/api/spaces/' + space + '/uploads/' + resume.uploadId, { cookie: resumedCookie })).bytes.toString());
  assert.deepEqual(status.received, [0]);
  assert.equal((await putChunk(resumed, resumedCookie, space, resume.uploadId, 1, resumeParts[1])).status, 204);
  const resumedItem = itemOf(await finishUpload(resumed, resumedCookie, space, resume.uploadId));
  const resumedDownload = await request(resumed, '/api/spaces/' + space + '/items/' + resumedItem.id + '/download', { cookie: resumedCookie });
  assert.equal(resumedDownload.bytes.equals(resumePayload), true);
  await stop(resumed);
  results.rust.server = await start('rust', results.rust.server.data);
  results.rust.alice = await login(results.rust.server, 'alice@example.test');
  note('rust-C12', { received: status.received, bytes: resumedDownload.bytes.length });
  console.log('PASS C12 restart resume');
}

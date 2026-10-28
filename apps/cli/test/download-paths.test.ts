// Path-boundary checks for AC-M5 (download destination, resume, symlinks). The server suite covers token and device-code abuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { CliError } from '../src/errors.js';
import { destination, existingSize, saveStream } from '../src/paths.js';

const payloads = [
  '../etc/passwd',
  '..\\..\\windows\\system.ini',
  '/etc/passwd',
  'C:\\Windows\\system.ini',
  '\u0000../etc/passwd',
  '\uFF0E\uFF0E\uFF0F\uFF0E\uFF0E\uFF0Fetc\uFF0Fpasswd',
  'foo\uFF0F..\uFF0F..\uFF0F..\uFF0Ftmp\uFF0Fevil',
  '\uFF0E\uFF0E',
  '....//....//etc/passwd',
  'foo/../../../../../../tmp/evil',
  '%2e%2e/%2e%2e/etc/passwd',
  'foo\n/../../etc/passwd',
  '  ..  ',
  'foo/..',
  '.',
  '..',
  'notes.txt',
  '.hidden',
];

function contained(dir: string, name: string): string | undefined {
  let target: string;
  try { target = destination(dir, name); }
  catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, 'UNSAFE_PATH');
    return undefined;
  }
  const root = resolve(dir);
  const rel = relative(root, target);
  assert.notEqual(rel, '..');
  assert.equal(rel.startsWith(`..${sep}`), false);
  assert.equal(isAbsolute(rel), false);
  assert.equal(target.startsWith(root + sep), true);
  return target;
}

test('AC-M5: download names cannot leave the output directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dropit-p2-path-'));
  const box = join(root, 'box');
  const outside = join(root, 'outside.txt');
  await mkdir(box);
  await writeFile(outside, 'safe');
  try {
    assert.equal(contained(box, '\uFF0E\uFF0E\uFF0F\uFF0E\uFF0E\uFF0Fetc\uFF0Fpasswd'), undefined);
    assert.equal(contained(box, '\uFF0E\uFF0E'), undefined);
    assert.equal(contained(box, '..'), undefined);
    for (const name of payloads) {
      const target = contained(box, name);
      if (!target) continue;
      await saveStream(target, Readable.from(Buffer.from('data')), false);
      assert.equal(await readFile(outside, 'utf8'), 'safe');
      assert.equal(await readFile(target, 'utf8'), 'data');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AC-M5: an existing file is kept unless --force, and a failed write leaves nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-p2-force-'));
  try {
    const dest = join(dir, 'clip.txt');
    await writeFile(dest, 'keep');
    await assert.rejects(() => existingSize(dest, false, false), (error: CliError) => error.code === 'EXISTS');
    assert.equal(await readFile(dest, 'utf8'), 'keep');
    assert.equal(await existingSize(dest, true, false), 4);
    assert.equal(await existingSize(dest, false, true), 0);
    const stream = Readable.from((async function* () {
      yield Buffer.from('abc');
      throw new Error('boom');
    })());
    await assert.rejects(() => saveStream(join(dir, 'partial.txt'), stream, false));
    assert.equal((await readFile(dest, 'utf8')), 'keep');
    assert.deepEqual(await readdir(dir), ['clip.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC-M5: resume refuses a symlink and does not write through it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dropit-p2-symlink-'));
  const box = join(root, 'box');
  const outside = join(root, 'outside.txt');
  const link = join(box, 'clip.txt');
  await mkdir(box);
  await writeFile(outside, 'safe');
  await symlink(outside, link);
  try {
    for (const force of [false, true]) {
      await assert.rejects(() => existingSize(link, true, force), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'UNSAFE_PATH');
        assert.equal(error.message, '拒绝符号链接');
        assert.notEqual(error.exitCode, 0);
        return true;
      });
    }
    assert.equal(await readFile(outside, 'utf8'), 'safe');
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    if (typeof constants.O_NOFOLLOW === 'number') {
      await assert.rejects(
        () => saveStream(link, Readable.from(Buffer.from('xx')), true),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, 'UNSAFE_PATH');
          return true;
        },
      );
      assert.equal(await readFile(outside, 'utf8'), 'safe');
      assert.equal((await lstat(link)).isSymbolicLink(), true);
    }
    const regular = join(box, 'part.bin');
    await writeFile(regular, 'abc');
    await saveStream(regular, Readable.from(Buffer.from('def')), true);
    assert.equal(await readFile(regular, 'utf8'), 'abcdef');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

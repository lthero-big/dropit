import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asciiFilename } from '../src/backend.js';

// RHEA-190 dl: the plain filename= fallback keeps the real extension (and the ASCII part of the name),
// so clients that ignore filename* (Android URLUtil.guessFileName) no longer save download.bin.
test('ascii fallback filename keeps name and extension', () => {
  assert.equal(asciiFilename('report-2026.pdf', 'download'), 'report-2026.pdf');
  assert.equal(asciiFilename('报告.pdf', 'download'), 'download.pdf');
  assert.equal(asciiFilename('照片 IMG_01.JPG', 'download'), 'IMG_01.JPG');
  assert.equal(asciiFilename('测试报告 2026.pdf', 'download'), '2026.pdf');
  assert.equal(asciiFilename('我的notes笔记v2.md', 'download'), 'notes_v2.md');
  assert.equal(asciiFilename('a"b%c;d.txt', 'download'), 'a_b_c_d.txt');
  assert.equal(asciiFilename('dir\\name.txt', 'download'), 'name.txt');
  assert.equal(asciiFilename('../../etc/passwd', 'download'), 'passwd');
  assert.equal(asciiFilename('archive.tar.gz', 'download'), 'archive.tar.gz');
  assert.equal(asciiFilename('README', 'download'), 'README');
  assert.equal(asciiFilename('视频', 'media'), 'media');
  assert.equal(asciiFilename('.env', 'download'), '.env');
  assert.equal(asciiFilename('x.中文', 'download'), 'x');
  assert.ok(!/[\r\n"]/.test(asciiFilename('a\r\nb".png', 'download')));
});

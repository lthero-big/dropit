import { constants, createWriteStream, openSync, type WriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CliError } from './errors.js';

const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export function withoutControls(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) cleaned += char;
  }
  return cleaned;
}

export function safeDownloadName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = withoutControls(base.normalize('NFKC')).trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new CliError('UNSAFE_PATH', '拒绝不安全的文件名');
  }
  return cleaned;
}

export function destination(dir: string, filename: string): string {
  const name = safeDownloadName(filename);
  const root = resolve(dir);
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep + '..')) {
    throw new CliError('UNSAFE_PATH', '拒绝路径穿越');
  }
  return target;
}

export async function prepareDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const info = await stat(dir);
  if (!info.isDirectory()) throw new CliError('USAGE', '-o 必须是目录', 2);
}

export async function existingSize(dest: string, resume: boolean, force: boolean): Promise<number> {
  try {
    const link = await lstat(dest);
    if (resume && link.isSymbolicLink()) throw new CliError('UNSAFE_PATH', '拒绝符号链接');
    const info = link.isSymbolicLink() ? await stat(dest) : link;
    if (!info.isFile()) throw new CliError('EXISTS', '目标已存在且不是文件');
    if (!resume && !force) throw new CliError('EXISTS', '文件已存在，加 --force 覆盖');
    return resume ? info.size : 0;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export function downloadPlan(status: number, existing: number, contentRange: string | undefined): 'append' | 'replace' | 'done' {
  if (status === 416) {
    const total = /^bytes \*\/(\d+)$/.exec(contentRange ?? '')?.[1];
    if (total !== undefined && Number(total) === existing) return 'done';
    throw new CliError('RANGE', existing > 0 && total !== undefined && existing > Number(total)
      ? '本地文件比服务器上的更大，无法续传'
      : '续传范围无效');
  }
  if (status === 206 && existing > 0) return 'append';
  if (status === 200 || status === 206) return 'replace';
  throw new CliError('HTTP_' + String(status), '下载失败');
}

function openDownload(path: string, append: boolean): WriteStream {
  const flags = append
    ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
  try {
    const fd = openSync(path, noFollow === 0 ? flags : flags | noFollow);
    return createWriteStream(path, { fd, autoClose: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new CliError('UNSAFE_PATH', '拒绝符号链接');
    throw error;
  }
}

export async function saveStream(dest: string, stream: Readable, append: boolean): Promise<void> {
  const partial = append ? dest : `${dest}.${process.pid}.dropit-partial`;
  const output = openDownload(partial, append);
  try {
    await pipeline(stream, output);
    if (!append) await rename(partial, dest);
  } catch (error) {
    output.destroy();
    if (!append) await rm(partial, { force: true });
    throw error;
  }
}

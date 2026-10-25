import { constants } from 'node:fs';
import { chmod, lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { CliError } from './errors.js';
import { mapLimit } from './chunk.js';
import { assertPartialSize } from './paths.js';

const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export interface PartialMeta {
  total: number;
  jobs: number;
  done: number[];
}

export function partBounds(total: number, jobs: number, index: number): { start: number; end: number } {
  if (jobs < 1 || index < 0 || index >= jobs) throw new CliError('RANGE', '下载分片无效');
  const width = Math.ceil(total / jobs);
  const start = index * width;
  return { start, end: Math.min(total, start + width) };
}

export function assertPartialProgress(size: number, total: number, jobs: number, done: readonly number[]): void {
  assertPartialSize(size, total);
  let maxEnd = 0;
  for (const index of done) {
    if (!Number.isInteger(index) || index < 0 || index >= jobs) throw new CliError('RANGE', '已有 partial 的进度记录无效');
    maxEnd = Math.max(maxEnd, partBounds(total, jobs, index).end);
  }
  if (size < maxEnd) throw new CliError('RANGE', '已有 partial 的大小与进度记录不一致');
}

async function writeAt(path: string, bytes: Buffer, offset: number): Promise<void> {
  const flags = constants.O_RDWR | constants.O_CREAT | noFollow;
  let handle;
  try {
    handle = await open(path, flags, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new CliError('UNSAFE_PATH', '拒绝符号链接');
    throw error;
  }
  try {
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length, offset);
    if (bytesWritten !== bytes.length) throw new CliError('INTERNAL', '写入不完整');
  } finally {
    await handle.close();
  }
}

async function readMeta(path: string): Promise<PartialMeta | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new CliError('UNSAFE_PATH', '拒绝符号链接');
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PartialMeta;
    if (!parsed || !Number.isSafeInteger(parsed.total) || !Number.isSafeInteger(parsed.jobs) || !Array.isArray(parsed.done)) return undefined;
    return parsed;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError('RANGE', '已有 partial 的进度记录无法解析');
  }
}

async function writeMeta(path: string, meta: PartialMeta): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: 'w' });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export async function downloadParallel(options: {
  dest: string;
  partial: string;
  jobs: number;
  resume: boolean;
  total: number;
  fetchRange: (start: number, endInclusive: number) => Promise<Buffer>;
}): Promise<{ path: string; bytes: number }> {
  const metaPath = `${options.partial}.json`;
  let done: number[] = [];
  let existing = 0;
  if (!options.resume) {
    await rm(options.partial, { force: true });
    await rm(metaPath, { force: true });
  } else {
    try {
      const info = await lstat(options.partial);
      if (info.isSymbolicLink()) throw new CliError('UNSAFE_PATH', '拒绝符号链接');
      if (!info.isFile()) throw new CliError('RANGE', '已有 partial 不是文件');
      existing = info.size;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing > 0) {
      const meta = await readMeta(metaPath);
      if (!meta || meta.total !== options.total || meta.jobs !== options.jobs) {
        throw new CliError('RANGE', '已有 partial 的大小或分片记录与服务器不一致');
      }
      assertPartialProgress(existing, options.total, options.jobs, meta.done);
      done = [...meta.done];
    }
  }
  assertPartialSize(existing, options.total);
  const pending = Array.from({ length: options.jobs }, (_value, index) => index).filter(index => !done.includes(index));
  if (pending.length === 0 && existing === options.total) {
    await rename(options.partial, options.dest);
    await rm(metaPath, { force: true });
    return { path: options.dest, bytes: options.total };
  }
  await writeMeta(metaPath, { total: options.total, jobs: options.jobs, done });
  const signal = new AbortController().signal;
  let metaChain = Promise.resolve();
  await mapLimit(pending, options.jobs, async (index) => {
    const { start, end } = partBounds(options.total, options.jobs, index);
    if (end > start) {
      const bytes = await options.fetchRange(start, end - 1);
      if (bytes.length !== end - start) throw new CliError('RANGE', '下载分片长度与请求不一致');
      await writeAt(options.partial, bytes, start);
    }
    metaChain = metaChain.then(async () => {
      done = [...done, index].sort((a, b) => a - b);
      await writeMeta(metaPath, { total: options.total, jobs: options.jobs, done });
    });
    await metaChain;
  }, signal);
  const finalInfo = await lstat(options.partial);
  if (finalInfo.isSymbolicLink()) throw new CliError('UNSAFE_PATH', '拒绝符号链接');
  assertPartialSize(finalInfo.size, options.total);
  if (finalInfo.size !== options.total || done.length !== options.jobs) throw new CliError('RANGE', 'partial 大小与服务器不一致');
  await rename(options.partial, options.dest);
  await rm(metaPath, { force: true });
  return { path: options.dest, bytes: options.total };
}

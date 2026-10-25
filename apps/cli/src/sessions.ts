import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CliError } from './errors.js';

type Target = { kind: 'space'; id: string } | { kind: 'room'; token: string };

export interface UploadRecord {
  url: string;
  targetKey: string;
  path: string;
  size: number;
  mtimeMs: number;
  uploadId: string;
  chunkSize: number;
  expiresAt: number;
  filename: string;
  startedAt: number;
}

export function uploadSessionPath(configFile: string): string {
  return resolve(dirname(configFile), 'uploads.json');
}

export function targetKey(target: Target): string {
  return target.kind === 'space' ? `space:${target.id}` : `room:${target.token}`;
}

export function targetFromKey(key: string): Target {
  if (key.startsWith('space:')) return { kind: 'space', id: key.slice('space:'.length) };
  if (key.startsWith('room:')) return { kind: 'room', token: key.slice('room:'.length) };
  throw new CliError('CONFIG_INVALID', '上传记录无效');
}

function isRecord(value: unknown): value is UploadRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.url === 'string' && typeof row.targetKey === 'string' && typeof row.path === 'string'
    && typeof row.size === 'number' && typeof row.mtimeMs === 'number' && typeof row.uploadId === 'string'
    && typeof row.chunkSize === 'number' && typeof row.expiresAt === 'number' && typeof row.filename === 'string'
    && typeof row.startedAt === 'number' && row.chunkSize > 0 && row.size > 0 && !('token' in row);
}

export async function loadSessions(path: string): Promise<UploadRecord[]> {
  let text: string;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new CliError('UNSAFE_PATH', '拒绝符号链接');
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const rows = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { uploads?: unknown }).uploads
      : undefined;
    if (!Array.isArray(rows)) return [];
    return rows.filter(isRecord);
  } catch {
    throw new CliError('CONFIG_INVALID', '上传记录无法解析');
  }
}

export async function saveSessions(path: string, records: UploadRecord[]): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  let existing;
  try { existing = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing?.isSymbolicLink()) throw new CliError('UNSAFE_PATH', '拒绝符号链接');
  const tmp = `${path}.${process.pid}.tmp`;
  const payload = `${JSON.stringify({ uploads: records }, null, 2)}\n`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(payload);
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export async function upsertSession(path: string, record: UploadRecord): Promise<void> {
  const records = (await loadSessions(path)).filter(row => row.uploadId !== record.uploadId && row.path !== record.path);
  records.push(record);
  await saveSessions(path, records);
}

export async function removeSession(path: string, uploadId: string): Promise<void> {
  const records = await loadSessions(path);
  const next = records.filter(row => row.uploadId !== uploadId);
  if (next.length === records.length) return;
  await saveSessions(path, next);
}

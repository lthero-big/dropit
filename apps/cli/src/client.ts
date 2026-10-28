import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { LARGE_FILE_BYTES, uploadChunked } from './chunk.js';
import { downloadParallel } from './download.js';
import { CliError } from './errors.js';
import type { Item, SpaceInfo } from './items.js';
import { interpretPoll, type AuthorizeResponse, type Poll } from './login.js';
import { contentRangeStart, contentRangeTotal, destination, downloadPlan, existingSize, prepareDirectory, rejectSymlink, saveStream } from './paths.js';
import { loadSessions, removeSession, targetFromKey, targetKey } from './sessions.js';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', txt: 'text/plain', md: 'text/plain', pdf: 'application/pdf', json: 'application/json',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', flac: 'audio/flac',
};

const httpAgent = new HttpAgent({ keepAlive: false });
const httpsAgent = new HttpsAgent({ keepAlive: false });

const FAILURES: Record<string, string> = {
  UNAUTHENTICATED: '未登录或令牌无效',
  FORBIDDEN: '没有权限',
  INSUFFICIENT_SCOPE: '令牌缺少所需范围',
  BROWSER_SESSION_REQUIRED: '这个操作只能在浏览器里完成',
  NOT_FOUND: '找不到对象',
  QUOTA_EXCEEDED: '配额已满',
  FILE_TOO_LARGE: '文件超过大小限制',
  TEXT_TOO_LARGE: '文本超过大小限制',
  EMPTY_TEXT: '文本是空的',
  EMPTY_FILE: '文件是空的',
  RATE_LIMITED: '请求过于频繁',
  PIN_REQUIRED: '这个房间需要 PIN（用 dropit room enter <房间码> --pin <PIN>）',
  PIN_INVALID: 'PIN 不正确',
  CODE_TAKEN: '这个房间码已被占用',
  INVALID_CODE: '房间码无效（3–32 位字母、数字、_ 或 -）',
  UPLOAD_BUSY: '服务器正在处理其他上传',
  UPLOAD_INCOMPLETE: '上传未完成，需要重新开始',
  UPLOAD_IN_PROGRESS: '上传仍在进行',
  UPLOAD_TIMEOUT: '分片上传超时',
  CHUNK_BUSY: '分片并发已满',
  CHUNK_CONFLICT: '分片内容冲突',
  CHUNK_SIZE_MISMATCH: '分片长度不一致',
  CHECKSUM_MISMATCH: '分片校验不一致',
  INVALID_CHECKSUM: '分片校验格式无效',
  INVALID_CHUNK_INDEX: '分片序号无效',
  INVALID_IMAGE: '图片无法解码',
  INVALID_FILENAME: '文件名无效',
  INVALID_INPUT: '请求参数无效',
  ORIGIN_REJECTED: '服务器拒绝了匿名来源。请先登录，或让 DROPIT_URL 与服务器的 APP_ORIGIN 一致',
};

export function mimeFor(filename: string): string {
  return MIME[extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export type Target = { kind: 'space'; id: string } | { kind: 'room'; token: string };

export function targetPath(target: Target): string {
  return target.kind === 'space'
    ? `/api/spaces/${encodeURIComponent(target.id)}`
    : `/api/rooms/${encodeURIComponent(target.token)}`;
}

export interface UserProfile {
  user: { id: string; email: string; name: string; role: string };
  usedBytes: number;
  quotaBytes: number;
  maxFileBytes: number;
  maxTextBytes: number;
  retentionMs: number;
}

interface RawResponse {
  status: number;
  headers: IncomingMessage['headers'];
  stream: IncomingMessage;
}

function headerValue(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function errorCode(status: number, body: unknown): { code: string; retryAfter?: number } {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = record.error;
  if (nested && typeof nested === 'object' && typeof (nested as { code?: unknown }).code === 'string') {
    return { code: (nested as { code: string }).code };
  }
  if (typeof nested === 'string') return { code: nested };
  return { code: `HTTP_${status}` };
}

function failureFrom(status: number, body: unknown, headers: IncomingMessage['headers'], fallback = '请求失败'): CliError {
  const parsed = errorCode(status, body);
  const failure = new CliError(parsed.code, FAILURES[parsed.code] ?? fallback, 1, status === 401 || status === 403 || status === 404);
  const retry = headerValue(headers, 'retry-after');
  if (retry && /^\d+$/.test(retry)) failure.retryAfter = Number(retry);
  return failure;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function socketText(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

// RHEA-190 step 5: the CLI introduces itself like a browser tab does, so the
// board can label what it sent ("⌘ build-box") and show it in presence.
const CREATES_ITEM = /\/items\/(text|file)$|\/uploads\/[^/]+\/complete$/;
export function cliDevice(host = hostname()): Record<string, string> {
  const name = [...(host.trim() || 'cli')].slice(0, 40).join('');
  const id = `cli-${createHash('sha256').update(name).digest('base64url').slice(0, 16)}`;
  return { 'x-dropit-device': id, 'x-dropit-device-name': encodeURIComponent(name), 'x-dropit-device-kind': 'cli' };
}

export class Client {
  constructor(readonly base: string, private token?: string) {}

  private origin(): string {
    return new URL(this.base).origin;
  }

  private headers(method: string, extra: Record<string, string> = {}, machine = false): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    if (machine) return headers;
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    else if (method !== 'GET' && method !== 'HEAD') headers.origin = this.origin();
    return headers;
  }

  private open(method: string, path: string, init: { json?: unknown; body?: Buffer | Readable; headers?: Record<string, string>; machine?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RawResponse> {
    const url = new URL(this.base + path);
    const headers = this.headers(method, init.headers, init.machine);
    if (method === 'POST' && CREATES_ITEM.test(path.split('?')[0])) Object.assign(headers, cliDevice());
    let body = init.body;
    if (init.json !== undefined) {
      body = Buffer.from(JSON.stringify(init.json));
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    } else if (Buffer.isBuffer(body)) {
      headers['content-length'] = String(body.length);
    }
    const secure = url.protocol === 'https:';
    const lib = secure ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) {
        reject(new CliError('INTERRUPTED', '已取消上传', 130));
        return;
      }
      let settled = false;
      let req: ReturnType<typeof httpRequest> | undefined;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (body && !Buffer.isBuffer(body)) body.destroy();
        req?.destroy();
        reject(new CliError('INTERRUPTED', '已取消上传', 130));
      };
      const timeoutMs = init.timeoutMs === undefined ? 120_000 : init.timeoutMs;
      const request = req = lib({
        protocol: url.protocol, hostname: url.hostname, port: url.port,
        path: `${url.pathname}${url.search}`, method, headers,
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
        agent: secure ? httpsAgent : httpAgent,
      }, (stream) => {
        if (settled) {
          stream.resume();
          return;
        }
        settled = true;
        init.signal?.removeEventListener('abort', onAbort);
        resolve({ status: stream.statusCode ?? 0, headers: stream.headers, stream });
      });
      init.signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        init.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      if (!body) request.end();
      else if (Buffer.isBuffer(body)) request.end(body);
      else {
        body.on('error', (error) => request.destroy(error));
        body.pipe(request);
      }
    });
  }

  private async send(method: string, path: string, init: { json?: unknown; headers?: Record<string, string>; accept?: number[]; machine?: boolean; timeoutMs?: number } = {}) {
    const response = await this.open(method, path, init);
    const buffer = await readBuffer(response.stream);
    const text = buffer.toString('utf8');
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text) as unknown; }
      catch { body = null; }
    }
    const ok = response.status >= 200 && response.status < 300;
    if (!ok && !init.accept?.includes(response.status)) throw failureFrom(response.status, body, response.headers);
    return { status: response.status, headers: response.headers, body, buffer, retryAfter: headerValue(response.headers, 'retry-after') };
  }

  async me(): Promise<UserProfile> {
    return (await this.send('GET', '/api/me')).body as UserProfile;
  }

  async spaces(): Promise<SpaceInfo[]> {
    const body = await this.send('GET', '/api/spaces');
    return (body.body as { spaces: SpaceInfo[] }).spaces;
  }

  async logout(): Promise<void> {
    await this.send('POST', '/api/auth/logout');
  }

  async list(target: Target): Promise<Item[]> {
    const body = await this.send('GET', `${targetPath(target)}/items`);
    return (body.body as { items: Item[] }).items;
  }

  async sendText(target: Target, text: string): Promise<Item> {
    const body = await this.send('POST', `${targetPath(target)}/items/text`, { json: { text } });
    return (body.body as { item: Item }).item;
  }

  async upload(target: Target, file: string, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<Item> {
    if (signal?.aborted) throw new CliError('INTERRUPTED', '已取消上传', 130);
    let info;
    try { info = statSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('NOT_FOUND', `找不到文件 ${file}`);
      throw error;
    }
    if (!info.isFile()) throw new CliError('USAGE', `${file} 不是文件`, 2);
    if (info.size <= 0) throw new CliError('EMPTY_FILE', `${basename(file)} 是空文件`);
    const stream = createReadStream(file);
    let sent = 0;
    stream.on('data', (chunk: Buffer | string) => {
      sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      onProgress?.(sent, info.size);
    });
    let response: RawResponse;
    try {
      response = await this.open('POST', `${targetPath(target)}/items/file`, {
        body: stream,
        signal,
        headers: {
          'content-type': mimeFor(file),
          'content-length': String(info.size),
          'x-file-name': encodeURIComponent(basename(file)),
        },
      });
    } catch (error) {
      stream.destroy();
      throw error;
    }
    const buffer = await readBuffer(response.stream);
    let body: unknown = null;
    try { body = JSON.parse(buffer.toString('utf8')) as unknown; } catch { body = null; }
    if (response.status !== 201) {
      const code = errorCode(response.status, body).code;
      const failure = new CliError(code, `${basename(file)}：${FAILURES[code] ?? '上传失败'}`);
      const retry = headerValue(response.headers, 'retry-after');
      if (retry && /^\d+$/.test(retry)) failure.retryAfter = Number(retry);
      throw failure;
    }
    return (body as { item: Item }).item;
  }

  async uploadFile(options: {
    target: Target;
    file: string;
    url: string;
    sessionFile: string;
    signal?: AbortSignal;
    onProgress?: (sent: number, total: number, extra?: { speed?: number; eta?: number | null; report?: boolean }) => void;
  }): Promise<Item> {
    if (options.signal?.aborted) throw new CliError('INTERRUPTED', '已取消上传', 130);
    let info;
    try { info = statSync(options.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('NOT_FOUND', `找不到文件 ${options.file}`);
      throw error;
    }
    if (!info.isFile()) throw new CliError('USAGE', `${options.file} 不是文件`, 2);
    if (info.size < LARGE_FILE_BYTES) {
      return this.upload(options.target, options.file, options.onProgress, options.signal);
    }
    const key = targetKey(options.target);
    const signal = options.signal ?? new AbortController().signal;
    return uploadChunked({
      client: this,
      target: options.target,
      file: options.file,
      mime: mimeFor(options.file),
      url: options.url,
      targetKey: key,
      sessionFile: options.sessionFile,
      signal,
      findSession: async () => {
        const path = await realpath(options.file);
        const rows = await loadSessions(options.sessionFile);
        return rows.find(row => row.url === options.url && row.targetKey === key && row.path === path);
      },
      onProgress: (sent, total, extra) => options.onProgress?.(sent, total, extra),
    });
  }

  async createUpload(target: Target, filename: string, size: number, mime: string) {
    const response = await this.send('POST', `${targetPath(target)}/uploads`, { json: { filename, size, mime } });
    const body = response.body as { uploadId?: string; chunkSize?: number; expiresAt?: number; received?: number[] } | null;
    if (!body?.uploadId || !body.chunkSize || !body.expiresAt) throw new CliError('INTERNAL', '创建上传会话的响应无效');
    return { uploadId: body.uploadId, chunkSize: body.chunkSize, expiresAt: body.expiresAt, received: body.received ?? [] };
  }

  async getUpload(target: Target, uploadId: string) {
    const response = await this.send('GET', `${targetPath(target)}/uploads/${encodeURIComponent(uploadId)}`);
    const body = response.body as { size?: number; chunkSize?: number; expiresAt?: number; received?: number[] } | null;
    if (!body || body.size == null || !body.chunkSize || !body.expiresAt) throw new CliError('INTERNAL', '上传会话响应无效');
    return { uploadId, size: body.size, chunkSize: body.chunkSize, expiresAt: body.expiresAt, received: body.received ?? [] };
  }

  async putChunk(target: Target, uploadId: string, index: number, bytes: Buffer, sha256: string, signal: AbortSignal, onBytes: (sent: number) => void): Promise<void> {
    if (signal.aborted) throw new CliError('INTERRUPTED', '已取消上传', 130);
    const response = await this.open('PUT', `${targetPath(target)}/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
      body: bytes,
      signal,
      timeoutMs: 0,
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256 },
    });
    onBytes(bytes.length);
    const buffer = await readBuffer(response.stream);
    if (response.status === 204) return;
    let body: unknown = null;
    try { body = JSON.parse(buffer.toString('utf8')) as unknown; } catch { body = null; }
    throw failureFrom(response.status, body, response.headers, '分片上传失败');
  }

  async completeUpload(target: Target, uploadId: string): Promise<Item> {
    const response = await this.send('POST', `${targetPath(target)}/uploads/${encodeURIComponent(uploadId)}/complete`, { timeoutMs: 0 });
    const item = (response.body as { item?: Item } | null)?.item;
    if (!item) throw new CliError('INTERNAL', '完成响应无效');
    return item;
  }

  async deleteUpload(target: Target, uploadId: string): Promise<void> {
    await this.send('DELETE', `${targetPath(target)}/uploads/${encodeURIComponent(uploadId)}`, { accept: [404] });
  }

  async discardUploadSessions(sessionFile: string, url: string, key: string, files: string[]): Promise<void> {
    let target: Target;
    try { target = targetFromKey(key); }
    catch { return; }
    const wanted = new Set<string>();
    for (const file of files) {
      try { wanted.add(await realpath(file)); }
      catch { /* missing file: nothing to match */ }
    }
    const records = await loadSessions(sessionFile).catch(() => []);
    for (const record of records) {
      if (record.url !== url || record.targetKey !== key || !wanted.has(record.path)) continue;
      try {
        await this.deleteUpload(target, record.uploadId);
        await removeSession(sessionFile, record.uploadId);
      } catch {
        // A network failure leaves the local record so a later run can resume or cancel.
      }
    }
  }

  async remove(target: Target, id: string): Promise<void> {
    await this.send('DELETE', `${targetPath(target)}/items/${encodeURIComponent(id)}`);
  }

  async share(target: Target, id: string, expiresIn: string, maxViews: number | null): Promise<{ id: string; url: string; expiresAt: number | null; maxViews: number | null; views: number }> {
    const body = await this.send('POST', `${targetPath(target)}/items/${encodeURIComponent(id)}/shares`, {
      json: { expiresIn, maxViews },
    });
    const share = body.body as { id: string; url: string; expiresAt: number | null; maxViews: number | null; views: number; token?: string };
    return { id: share.id, url: share.url, expiresAt: share.expiresAt, maxViews: share.maxViews, views: share.views };
  }

  async createRoom(options: { code?: string; pin?: string } = {}): Promise<{ token: string; url: string; expiresAt: number; code?: string | null; hasPin?: boolean }> {
    const body = await this.send('POST', '/api/rooms', options.code || options.pin ? { json: options } : undefined);
    return body.body as { token: string; url: string; expiresAt: number; code?: string | null; hasPin?: boolean };
  }

  async enterRoom(code: string, pin?: string): Promise<{ token: string; expiresAt: number; code?: string; url?: string; hasPin?: boolean }> {
    const body = await this.send('POST', '/api/rooms/enter', { json: { code, ...(pin ? { pin } : {}) } });
    return body.body as { token: string; expiresAt: number; code?: string; url?: string; hasPin?: boolean };
  }

  async roomInfo(roomToken: string): Promise<{ id: string; name: string; expiresAt: number | null; code?: string | null; url?: string }> {
    return (await this.send('GET', `/api/rooms/${encodeURIComponent(roomToken)}`)).body as { id: string; name: string; expiresAt: number | null; code?: string | null; url?: string };
  }

  async authorize(input: { name: string; scopes?: Array<'read' | 'write'>; expiresInDays?: number | null }): Promise<AuthorizeResponse> {
    const payload: Record<string, unknown> = { name: input.name };
    if (input.scopes) payload.scopes = input.scopes;
    if (input.expiresInDays !== undefined) payload.expiresInDays = input.expiresInDays;
    const response = await this.send('POST', '/api/auth/device/authorize', { json: payload, machine: true });
    return response.body as AuthorizeResponse;
  }

  async pollDevice(deviceCode: string): Promise<Poll> {
    const response = await this.send('POST', '/api/auth/device/token', {
      json: { device_code: deviceCode },
      accept: [400, 429],
      machine: true,
    });
    return interpretPoll(response.status, response.body, response.retryAfter);
  }

  async downloadBuffer(target: Target, id: string): Promise<Buffer> {
    const response = await this.open('GET', `${targetPath(target)}/items/${encodeURIComponent(id)}/download`);
    const buffer = await readBuffer(response.stream);
    if (response.status !== 200) {
      let body: unknown = null;
      try { body = JSON.parse(buffer.toString('utf8')) as unknown; } catch { body = null; }
      throw new CliError(errorCode(response.status, body).code, '下载失败');
    }
    return buffer;
  }

  private downloadPath(target: Target, id: string): string {
    return `${targetPath(target)}/items/${encodeURIComponent(id)}/download`;
  }

  private async throwDownload(response: RawResponse): Promise<never> {
    const buffer = await readBuffer(response.stream);
    let body: unknown = null;
    try { body = JSON.parse(buffer.toString('utf8')) as unknown; } catch { body = null; }
    const code = errorCode(response.status, body).code;
    throw new CliError(code, FAILURES[code] ?? '下载失败');
  }

  private async probeSize(target: Target, id: string): Promise<number> {
    const response = await this.open('GET', this.downloadPath(target, id), { headers: { range: 'bytes=0-0' } });
    const total = contentRangeTotal(headerValue(response.headers, 'content-range'));
    await readBuffer(response.stream);
    if (response.status !== 206 || total == null || total < 1) throw new CliError('RANGE', '无法确认文件大小');
    return total;
  }

  private async readRange(target: Target, id: string, start: number, endInclusive: number): Promise<Buffer> {
    const response = await this.open('GET', this.downloadPath(target, id), {
      headers: { range: `bytes=${start}-${endInclusive}` },
    });
    if (response.status !== 206) return this.throwDownload(response);
    const header = headerValue(response.headers, 'content-range');
    if (contentRangeStart(header) !== start) {
      response.stream.resume();
      throw new CliError('RANGE', '下载范围与请求不一致');
    }
    const buffer = await readBuffer(response.stream);
    if (buffer.length !== endInclusive - start + 1) throw new CliError('RANGE', '下载分片长度与请求不一致');
    return buffer;
  }

  private async downloadSequential(target: Target, id: string, dest: string, options: { resume: boolean; force: boolean }): Promise<{ path: string; bytes: number }> {
    const existing = await existingSize(dest, options.resume, options.force);
    const headers: Record<string, string> = {};
    if (existing > 0) headers.range = `bytes=${existing}-`;
    const response = await this.open('GET', this.downloadPath(target, id), { headers });
    if (response.status !== 200 && response.status !== 206 && response.status !== 416) return this.throwDownload(response);
    const plan = downloadPlan(response.status, existing, headerValue(response.headers, 'content-range'));
    if (plan === 'done') {
      response.stream.resume();
      return { path: dest, bytes: existing };
    }
    await saveStream(dest, response.stream, plan === 'append');
    return { path: dest, bytes: statSync(dest).size };
  }

  async downloadTo(target: Target, id: string, dir: string, filename: string, options: { resume: boolean; force: boolean; jobs?: number }): Promise<{ path: string; bytes: number }> {
    const jobs = options.jobs ?? 1;
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new CliError('USAGE', '--jobs 必须在 1 到 8 之间', 2);
    await prepareDirectory(dir);
    const dest = destination(dir, filename);
    const partial = `${dest}.dropit-partial`;
    await rejectSymlink(dest);
    await rejectSymlink(partial);
    await rejectSymlink(`${partial}.json`);
    if (!options.resume) {
      await rm(partial, { force: true });
      await rm(`${partial}.json`, { force: true });
    }
    let destInfo;
    try { destInfo = await lstat(dest); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (destInfo && !destInfo.isFile()) throw new CliError('EXISTS', '目标已存在且不是文件');
    const partialReady = options.resume && !destInfo && await isFile(partial);
    if (jobs > 1 && destInfo && !options.force) {
      if (options.resume && !await isFile(partial)) return this.downloadSequential(target, id, dest, options);
      throw new CliError('EXISTS', options.resume ? '并行下载需要目标不存在，或加 --force' : '文件已存在，加 --force 覆盖');
    }
    if (jobs === 1 && !partialReady) return this.downloadSequential(target, id, dest, options);
    const total = await this.probeSize(target, id);
    return downloadParallel({
      dest,
      partial,
      jobs,
      resume: options.resume,
      total,
      fetchRange: (start, end) => this.readRange(target, id, start, end),
    });
  }

  watchUrl(target: Target): string {
    const url = new URL(this.base + `${targetPath(target)}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
    return url.href;
  }

  connectWatch(target: Target, signal: AbortSignal): Promise<{ messages: AsyncIterable<string>; close: () => void }> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    else headers.origin = this.origin();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.watchUrl(target), { headers, handshakeTimeout: 15_000 });
      const fail = (error: Error) => {
        ws.terminate();
        reject(error);
      };
      ws.once('unexpected-response', (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        const fatal = status === 401 || status === 403 || status === 404;
        const code = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'WS_FAILED';
        fail(new CliError(code, '实时连接被拒绝', 1, fatal));
      });
      ws.once('error', (error) => {
        if (ws.readyState !== WebSocket.OPEN) fail(error instanceof Error ? error : new Error('socket error'));
      });
      ws.once('open', () => {
        const queue: string[] = [];
        let waiter: ((result: IteratorResult<string>) => void) | undefined;
        let finished = false;
        let failure: Error | undefined;
        const push = (result: IteratorResult<string>) => {
          if (waiter) {
            const resolveWaiter = waiter;
            waiter = undefined;
            resolveWaiter(result);
          }
        };
        ws.on('message', (data: WebSocket.RawData) => {
          const text = socketText(data);
          if (waiter) push({ value: text, done: false });
          else queue.push(text);
        });
        ws.on('close', (code: number) => {
          finished = true;
          if (code === 1008) failure = new CliError('UNAUTHENTICATED', '实时连接已关闭', 1, true);
          push({ value: undefined, done: true });
        });
        ws.on('error', (error: Error) => {
          finished = true;
          failure = error;
          push({ value: undefined, done: true });
        });
        const messages: AsyncIterable<string> = {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              if (signal.aborted) return;
              if (failure && queue.length === 0) throw failure;
              if (queue.length) {
                yield queue.shift()!;
                continue;
              }
              if (finished) {
                if (failure) throw failure;
                return;
              }
              const next = await new Promise<IteratorResult<string>>((done) => { waiter = done; });
              if (next.done) {
                if (failure) throw failure;
                return;
              }
              yield next.value;
            }
          },
        };
        const close = () => { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(); };
        signal.addEventListener('abort', close, { once: true });
        resolve({ messages, close });
      });
    });
  }
}

import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createReadStream, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { CliError } from './errors.js';
import type { Item, SpaceInfo } from './items.js';
import { interpretPoll, type AuthorizeResponse, type Poll } from './login.js';
import { destination, downloadPlan, existingSize, prepareDirectory, saveStream } from './paths.js';

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
  UPLOAD_BUSY: '服务器正在处理其他上传',
  UPLOAD_INCOMPLETE: '上传已中断',
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

function socketText(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
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

  private open(method: string, path: string, init: { json?: unknown; body?: Buffer | Readable; headers?: Record<string, string>; machine?: boolean; signal?: AbortSignal } = {}): Promise<RawResponse> {
    const url = new URL(this.base + path);
    const headers = this.headers(method, init.headers, init.machine);
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
      const request = req = lib({
        protocol: url.protocol, hostname: url.hostname, port: url.port,
        path: `${url.pathname}${url.search}`, method, headers, timeout: 120_000,
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
      request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
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

  private async send(method: string, path: string, init: { json?: unknown; headers?: Record<string, string>; accept?: number[]; machine?: boolean } = {}) {
    const response = await this.open(method, path, init);
    const buffer = await readBuffer(response.stream);
    const text = buffer.toString('utf8');
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text) as unknown; }
      catch { body = null; }
    }
    const ok = response.status >= 200 && response.status < 300;
    if (!ok && !init.accept?.includes(response.status)) {
      const parsed = errorCode(response.status, body);
      throw new CliError(parsed.code, FAILURES[parsed.code] ?? '请求失败', 1, response.status === 401 || response.status === 403 || response.status === 404);
    }
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

  async createRoom(): Promise<{ token: string; url: string; expiresAt: number }> {
    const body = await this.send('POST', '/api/rooms');
    return body.body as { token: string; url: string; expiresAt: number };
  }

  async roomInfo(roomToken: string): Promise<{ id: string; name: string; expiresAt: number | null }> {
    return (await this.send('GET', `/api/rooms/${encodeURIComponent(roomToken)}`)).body as { id: string; name: string; expiresAt: number | null };
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

  async downloadTo(target: Target, id: string, dir: string, filename: string, options: { resume: boolean; force: boolean }): Promise<{ path: string; bytes: number }> {
    await prepareDirectory(dir);
    const dest = destination(dir, filename);
    const existing = await existingSize(dest, options.resume, options.force);
    const headers: Record<string, string> = {};
    if (existing > 0) headers.range = `bytes=${existing}-`;
    const response = await this.open('GET', `${targetPath(target)}/items/${encodeURIComponent(id)}/download`, { headers });
    if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
      const buffer = await readBuffer(response.stream);
      let body: unknown = null;
      try { body = JSON.parse(buffer.toString('utf8')) as unknown; } catch { body = null; }
      const code = errorCode(response.status, body).code;
      throw new CliError(code, FAILURES[code] ?? '下载失败');
    }
    const plan = downloadPlan(response.status, existing, headerValue(response.headers, 'content-range'));
    if (plan === 'done') {
      response.stream.resume();
      return { path: dest, bytes: existing };
    }
    await saveStream(dest, response.stream, plan === 'append');
    return { path: dest, bytes: statSync(dest).size };
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

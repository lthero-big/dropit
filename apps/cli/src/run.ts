import { hostname } from 'node:os';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { parseArgs, usageText, type Globals, type Parsed } from './args.js';
import { Client, type Target } from './client.js';
import { configPath, loadConfig, normalizeBase, resolveSettings, saveConfig, type FileConfig, type Settings } from './config.js';
import { asCliError, CliError, scrub } from './errors.js';
import { runItemCommand } from './exec.js';
import { latestItem, pickSpace, type Item } from './items.js';
import { deviceLogin } from './login.js';
import { destination, existingSize, prepareDirectory, saveStream, withoutControls } from './paths.js';
import { watchLoop } from './watch.js';

export interface Io {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
}

export function defaultIo(): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}

function writeText(io: Io, text: string) {
  io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function emit(io: Io, json: boolean, data: unknown, human: string) {
  if (json) io.stdout.write(`${JSON.stringify(data)}\n`);
  else if (human) writeText(io, human);
}

function report(io: Io, json: boolean, error: unknown, secrets: readonly string[]): number {
  const cli = asCliError(error);
  const message = scrub(cli.message, secrets);
  if (json) io.stderr.write(`${JSON.stringify({ error: { code: cli.code, message } })}\n`);
  else io.stderr.write(`dropit: ${message}\n`);
  return cli.exitCode;
}

export function formatProgress(label: string, sent: number, total: number): string {
  const pct = total > 0 ? Math.min(100, Math.floor((sent * 100) / total)) : 0;
  return `${label} ${String(pct).padStart(3, ' ')}%  ${sent}/${total}`;
}

export function parseRoomToken(input: string): string {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{20,128}$/.test(trimmed)) return trimmed;
  let url: URL;
  try { url = new URL(trimmed); }
  catch { throw new CliError('USAGE', '无法识别房间链接', 2); }
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.lastIndexOf('rooms');
  const token = decodeURIComponent(index >= 0 ? parts[index + 1] ?? '' : parts.at(-1) ?? '');
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw new CliError('USAGE', '无法识别房间链接', 2);
  return token;
}

function preview(item: Item): string {
  if (item.kind === 'text') return (item.text ?? '').replace(/\s+/g, ' ').slice(0, 80);
  return item.filename ?? 'file';
}

function deviceLabel(explicit?: string): string {
  const raw = withoutControls(explicit || hostname() || 'dropit').trim().slice(0, 80);
  return raw || 'dropit';
}

async function readStdin(io: Io): Promise<string> {
  if (io.stdinIsTTY) throw new CliError('USAGE', '缺少文本。用法：dropit send "文本"，或从管道传入。', 2);
  const chunks: Buffer[] = [];
  for await (const chunk of io.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

async function requireBase(settings: Settings): Promise<string> {
  if (!settings.url) throw new CliError('USAGE', '缺少服务地址。设置 DROPIT_URL，或执行 dropit login --url <url>。', 2);
  return normalizeBase(settings.url);
}

async function resolveItem(client: Client, target: Target, id: string): Promise<Item> {
  const items = await client.list(target);
  const item = id === 'latest' ? latestItem(items) : items.find(entry => entry.id === id);
  if (!item) throw new CliError('NOT_FOUND', id === 'latest' ? '没有条目' : '找不到条目');
  return item;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = defaultIo()): Promise<number> {
  let parsed: Parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { return report(io, argv.includes('--json'), error, []); }
  if (parsed.command.kind === 'help') {
    io.stdout.write(usageText);
    return 0;
  }
  const secrets: string[] = [];
  try {
    await dispatch(parsed, env, io, secrets);
    return 0;
  } catch (error) {
    if (error instanceof CliError && error.code === 'INTERRUPTED') return error.exitCode;
    return report(io, parsed.globals.json, error, secrets);
  }
}

async function dispatch(parsed: Parsed, env: NodeJS.ProcessEnv, io: Io, secrets: string[]): Promise<void> {
  const path = configPath(env);
  const file = await loadConfig(path);
  if (file.token) secrets.push(file.token);
  if (file.roomToken) secrets.push(file.roomToken);
  const settings = resolveSettings(file, env, parsed.globals.url);
  if (settings.token) secrets.push(settings.token);
  const json = parsed.globals.json;
  const persist = () => saveConfig(path, file);
  const command = parsed.command;

  if (command.kind === 'login') {
    const base = await requireBase({ ...settings, url: parsed.globals.url ?? env.DROPIT_URL ?? file.url });
    const client = new Client(base);
    const issued = await deviceLogin({
      authorize: () => client.authorize({
        name: deviceLabel(command.name),
        scopes: command.scopes,
        expiresInDays: command.expiresInDays,
      }),
      poll: async (deviceCode) => {
        secrets.push(deviceCode);
        return client.pollDevice(deviceCode);
      },
      sleep: (seconds) => new Promise((resolve) => { setTimeout(resolve, seconds * 1000); }),
      now: Date.now,
      onUserCode: (info) => emit(io, json, {
        user_code: info.userCode,
        verification_uri: info.verificationUri,
        verification_uri_complete: info.verificationUriComplete,
        expires_in: info.expiresIn,
      }, `在浏览器打开并批准这个设备：\n${info.verificationUriComplete}\n\n验证码：${info.userCode}\n\n等待批准…`),
    });
    secrets.push(issued.accessToken);
    file.url = base;
    file.token = issued.accessToken;
    await persist();
    if (env.DROPIT_TOKEN) io.stderr.write('dropit: 环境变量 DROPIT_TOKEN 会覆盖刚保存的令牌。\n');
    emit(io, json, { ok: true, name: issued.name, expiresAt: issued.expiresAt }, '已登录。令牌已写入配置文件，权限为 0600。');
    return;
  }

  const base = command.kind === 'logout' && !settings.url ? undefined : await requireBase(settings).catch((error) => {
    if (command.kind === 'logout') return undefined;
    throw error;
  });
  const client = new Client(base ?? 'http://127.0.0.1', settings.token);

  if (command.kind === 'logout') {
    if (settings.token && base) {
      try { await client.logout(); }
      catch (error) {
        if (error instanceof CliError && error.code === 'INSUFFICIENT_SCOPE') {
          io.stderr.write('dropit: 令牌没有 write 范围，只清除本地配置。请在网页上撤销它。\n');
        } else if (!(error instanceof CliError && error.code === 'UNAUTHENTICATED')) {
          io.stderr.write('dropit: 服务器没有撤销令牌，本地配置仍会清除。\n');
        }
      }
    }
    if (file.token) {
      delete file.token;
      await persist();
    }
    if (env.DROPIT_TOKEN) io.stderr.write('dropit: DROPIT_TOKEN 仍在环境中，请在当前环境之外取消设置。\n');
    emit(io, json, { ok: true }, '已退出。');
    return;
  }

  if (command.kind === 'whoami') {
    if (!settings.token) throw new CliError('UNAUTHENTICATED', '未登录。设置 DROPIT_TOKEN，或执行 dropit login。');
    const me = await client.me();
    emit(io, json, {
      user: me.user, usedBytes: me.usedBytes, quotaBytes: me.quotaBytes, url: base,
      target: file.roomToken ? 'room' : 'space', spaceId: file.spaceId ?? null,
    }, `${me.user.name} <${me.user.email}>\n角色 ${me.user.role}\n配额 ${me.usedBytes}/${me.quotaBytes}\n服务 ${base}\n目标 ${file.roomToken ? '临时房间' : file.spaceId ?? '私人空间'}`);
    return;
  }

  if (command.kind === 'room-new') {
    const room = await client.createRoom();
    secrets.push(room.token);
    file.roomToken = room.token;
    if (base) file.url = base;
    await persist();
    emit(io, json, { url: room.url, expiresAt: room.expiresAt }, `房间已创建。后续命令默认发往这个房间。\n${room.url}`);
    return;
  }

  if (command.kind === 'room-join') {
    const token = parseRoomToken(command.target);
    secrets.push(token);
    const info = await client.roomInfo(token);
    file.roomToken = token;
    if (base) file.url = base;
    await persist();
    emit(io, json, { ok: true, expiresAt: info.expiresAt }, '已切换到临时房间。后续命令默认发往该房间，用 --space 可以改回空间。');
    return;
  }

  const target = await resolveTarget(client, file, settings, parsed.globals, persist, secrets);
  if (command.kind === 'send') {
    const text = command.text ?? await readStdin(io);
    if (!text.trim()) throw new CliError('EMPTY_TEXT', '文本是空的');
    const item = await client.sendText(target, text);
    emit(io, json, { item }, item.id);
    return;
  }
  if (command.kind === 'push') {
    const items: Item[] = [];
    for (const filePath of command.files) {
      let open = false;
      const onProgress = io.stderrIsTTY ? (sent: number, total: number) => {
        io.stderr.write(`\r${formatProgress(basename(filePath), sent, total)}`);
        open = sent < total;
        if (!open) io.stderr.write('\n');
      } : undefined;
      try {
        items.push(await client.upload(target, filePath, onProgress));
      } catch (error) {
        if (open) io.stderr.write('\n');
        throw error;
      }
    }
    emit(io, json, { items }, items.map(item => `${item.id}\t${item.filename ?? ''}`).join('\n'));
    return;
  }
  if (command.kind === 'ls') {
    const items = await client.list(target);
    emit(io, json, { items }, items.length ? items.map(item => `${item.id}\t${item.kind}\t${item.size}\t${new Date(item.createdAt).toISOString()}\t${preview(item)}`).join('\n') : '（空）');
    return;
  }
  if (command.kind === 'get') {
    if (command.resume && !command.output) throw new CliError('USAGE', '续传需要 -o 目录', 2);
    const item = await resolveItem(client, target, command.id);
    if (!command.output) {
      const body = item.kind === 'text' ? Buffer.from(item.text ?? '', 'utf8') : await client.downloadBuffer(target, item.id);
      io.stdout.write(body);
      return;
    }
    if (item.kind === 'text') {
      if (command.resume) throw new CliError('USAGE', '续传只适用于文件', 2);
      await prepareDirectory(command.output);
      const dest = destination(command.output, `${item.id}.txt`);
      await existingSize(dest, false, command.force);
      await saveStream(dest, Readable.from(Buffer.from(item.text ?? '', 'utf8')), false);
      emit(io, json, { path: dest, bytes: Buffer.byteLength(item.text ?? '') }, dest);
      return;
    }
    const saved = await client.downloadTo(target, item.id, command.output, item.filename || 'download', {
      resume: command.resume, force: command.force,
    });
    emit(io, json, saved, saved.path);
    return;
  }
  if (command.kind === 'rm') {
    const item = await resolveItem(client, target, command.id);
    await client.remove(target, item.id);
    emit(io, json, { deleted: item.id }, item.id);
    return;
  }
  if (command.kind === 'share') {
    const item = await resolveItem(client, target, command.id);
    const share = await client.share(target, item.id, command.expires, command.maxViews);
    const views = share.maxViews === null ? '不限次数' : `${share.maxViews} 次`;
    emit(io, json, share, `${share.url}\n${views}`);
    return;
  }
  if (command.kind === 'watch') {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on('SIGINT', onSigint);
    let announced = false;
    try {
      await watchLoop({
        signal: controller.signal,
        sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
        isFatal: (error) => error instanceof CliError && error.fatal,
        connect: async () => {
          const connection = await client.connectWatch(target, controller.signal);
          if (!announced) {
            io.stderr.write('正在监听\n');
            announced = true;
          }
          return connection;
        },
        onItems: async (items) => {
          for (const item of items) {
            emit(io, json, { type: 'item.created', item }, `+ ${item.kind}\t${item.id}\t${preview(item)}`);
            if (!command.exec) continue;
            const body = item.kind === 'text'
              ? Buffer.from(item.text ?? '', 'utf8')
              : await client.downloadBuffer(target, item.id);
            try { await runItemCommand(command.exec, item, body); }
            catch (error) {
              if (error instanceof CliError) throw new CliError(error.code, error.message, error.exitCode, true);
              throw error;
            }
          }
        },
      });
    } finally {
      process.off('SIGINT', onSigint);
    }
    if (controller.signal.aborted) throw new CliError('INTERRUPTED', '已停止监听', 130);
  }
}

async function resolveTarget(client: Client, file: FileConfig, settings: Settings, globals: Globals, persist: () => Promise<void>, secrets: string[]): Promise<Target> {
  if (globals.space && globals.room) throw new CliError('USAGE', '--space 和 --room 不能同时使用', 2);
  if (globals.room) {
    const token = parseRoomToken(globals.room);
    secrets.push(token);
    await client.roomInfo(token);
    file.roomToken = token;
    await persist();
    return { kind: 'room', token };
  }
  if (globals.space) {
    if (!settings.token) throw new CliError('UNAUTHENTICATED', '选择空间需要先登录');
    const me = await client.me();
    const space = pickSpace(await client.spaces(), me.user.id, globals.space);
    file.spaceId = space.id;
    delete file.roomToken;
    await persist();
    return { kind: 'space', id: space.id };
  }
  if (file.roomToken) return { kind: 'room', token: file.roomToken };
  if (!settings.token) throw new CliError('UNAUTHENTICATED', '未登录。设置 DROPIT_TOKEN，或执行 dropit login。');
  const me = await client.me();
  const space = pickSpace(await client.spaces(), me.user.id, undefined, file.spaceId);
  if (file.spaceId !== space.id) {
    file.spaceId = space.id;
    await persist();
  }
  return { kind: 'space', id: space.id };
}


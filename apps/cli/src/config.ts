import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';

export interface FileConfig {
  url?: string;
  token?: string;
  spaceId?: string;
  roomToken?: string;
}

export interface Settings {
  url?: string;
  token?: string;
  spaceId?: string;
  roomToken?: string;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonempty(env.DROPIT_CONFIG);
  if (override) return override;
  const base = nonempty(env.XDG_CONFIG_HOME) ?? (env.HOME ? join(env.HOME, '.config') : join(homedir(), '.config'));
  return join(base, 'dropit', 'config.json');
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const ROOM_ACCESS_TOKEN = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;

export function parseConfig(raw: unknown): FileConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CliError('CONFIG_INVALID', '配置文件不是 JSON 对象');
  const body = raw as Record<string, unknown>;
  const config: FileConfig = {};
  const url = pickString(body.url);
  const token = pickString(body.token);
  const spaceId = pickString(body.spaceId);
  const roomToken = pickString(body.roomToken);
  if (url) config.url = url;
  if (token) config.token = token;
  if (spaceId) config.spaceId = spaceId;
  // a room access token is <room id>.<proof>; anything else (an old long room token) is dropped
  if (roomToken && ROOM_ACCESS_TOKEN.test(roomToken)) config.roomToken = roomToken;
  return config;
}

export async function loadConfig(path: string): Promise<FileConfig> {
  let text: string;
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    return parseConfig(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('CONFIG_INVALID', '配置文件无法解析');
  }
}

export async function saveConfig(path: string, config: FileConfig): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  const payload = `${JSON.stringify({
    ...(config.url ? { url: config.url } : {}),
    ...(config.token ? { token: config.token } : {}),
    ...(config.spaceId ? { spaceId: config.spaceId } : {}),
    ...(config.roomToken ? { roomToken: config.roomToken } : {}),
  }, null, 2)}\n`;
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

export function resolveSettings(file: FileConfig, env: NodeJS.ProcessEnv, urlFlag?: string): Settings {
  return {
    url: nonempty(urlFlag) ?? nonempty(env.DROPIT_URL) ?? file.url,
    token: nonempty(env.DROPIT_TOKEN) ?? file.token,
    spaceId: file.spaceId,
    roomToken: file.roomToken,
  };
}

export function normalizeBase(input: string): string {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new CliError('USAGE', '服务地址不是合法的 URL', 2); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('USAGE', '服务地址必须是 http 或 https', 2);
  }
  if (url.username || url.password) throw new CliError('USAGE', '不要把凭据写进服务地址', 2);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return url.toString().replace(/\/+$/, '');
}

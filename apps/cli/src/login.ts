import { CliError } from './errors.js';

export interface AuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  verification_id: string;
  expires_in: number;
  interval: number;
}

export interface UserPrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
}

export type Poll =
  | { kind: 'ok'; accessToken: string; scope: string; expiresAt: number | null; name: string }
  | { kind: 'pending' }
  | { kind: 'slow_down'; interval: number }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'retry'; seconds: number }
  | { kind: 'error'; code: string };

export function interpretPoll(status: number, body: unknown, retryAfter?: string): Poll {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (status === 429) {
    const seconds = Number(retryAfter);
    return { kind: 'retry', seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 5 };
  }
  if (status === 200 && typeof record.access_token === 'string') {
    const token = record.token && typeof record.token === 'object' ? record.token as Record<string, unknown> : {};
    const expiresAt = typeof token.expiresAt === 'number' ? token.expiresAt : null;
    const name = typeof token.name === 'string' ? token.name : '';
    const scope = typeof record.scope === 'string' ? record.scope : '';
    return { kind: 'ok', accessToken: record.access_token, scope, expiresAt, name };
  }
  const code = typeof record.error === 'string' ? record.error : '';
  if (code === 'authorization_pending') return { kind: 'pending' };
  if (code === 'slow_down') {
    const interval = typeof record.interval === 'number' ? record.interval : 5;
    return { kind: 'slow_down', interval };
  }
  if (code === 'access_denied') return { kind: 'denied' };
  if (code === 'expired_token') return { kind: 'expired' };
  if (record.error && typeof record.error === 'object' && typeof (record.error as { code?: unknown }).code === 'string') {
    return { kind: 'error', code: (record.error as { code: string }).code };
  }
  return { kind: 'error', code: code || `HTTP_${status}` };
}

function waitSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 5;
  return value;
}

export async function deviceLogin(options: {
  authorize: () => Promise<AuthorizeResponse>;
  poll: (deviceCode: string) => Promise<Poll>;
  sleep: (seconds: number) => Promise<void>;
  now: () => number;
  onUserCode: (info: UserPrompt) => void;
}): Promise<{ accessToken: string; name: string; expiresAt: number | null }> {
  const started = options.now();
  const flow = await options.authorize();
  if (!flow.device_code || !flow.user_code || !flow.verification_uri_complete) {
    throw new CliError('INVALID_INPUT', '设备码响应不完整');
  }
  options.onUserCode({
    userCode: flow.user_code,
    verificationUri: flow.verification_uri,
    verificationUriComplete: flow.verification_uri_complete,
    expiresIn: flow.expires_in,
  });
  let interval = waitSeconds(flow.interval);
  const deadline = started + (Number.isFinite(flow.expires_in) ? flow.expires_in : 600) * 1000;
  await options.sleep(interval);
  while (options.now() < deadline) {
    const result = await options.poll(flow.device_code);
    if (result.kind === 'ok') return { accessToken: result.accessToken, name: result.name, expiresAt: result.expiresAt };
    if (result.kind === 'denied') throw new CliError('ACCESS_DENIED', '设备登录被拒绝');
    if (result.kind === 'expired') throw new CliError('EXPIRED', '设备码已过期');
    if (result.kind === 'error') throw new CliError(result.code, '设备登录失败');
    if (result.kind === 'slow_down') interval = waitSeconds(result.interval);
    if (result.kind === 'retry') interval = Math.max(interval, waitSeconds(result.seconds));
    if (options.now() + interval * 1000 >= deadline) break;
    await options.sleep(interval);
  }
  throw new CliError('EXPIRED', '设备码已过期');
}

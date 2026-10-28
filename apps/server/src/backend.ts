import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from './config.js';
import { ApiError, hash, parseDevice, token, type AccessToken, type BrowserSession, type Item, type ItemDevice, type ItemMeta, type Session, type TokenScope } from './domain.js';
import { parseByteRange, sniffMedia } from './media.js';
import { SqliteRepository, type Repository } from './repository.js';
import { DiskFileStorage, jsonFileStore, readJsonFile, type FileStorage } from './files.js';
import { MemoryBroadcaster, type Broadcaster } from './events.js';
import { checkOAuthCredentials, createOAuthProvider, envOAuthApps, isSupportedProvider, providerInfo, supportedProviders, type OAuthProvider } from './oauth.js';
import { ClipboardService } from './service.js';
import { clientIpResolver, RateLimiter } from './rate-limit.js';
import { limitRanges, RuntimeLimits } from './limits.js';
import { describeAgent } from './agent.js';
import { loadUpdateSettings, UpdateChecker } from './update-check.js';
import { buildInfoPath, loadBuildInfo } from './version.js';

type Env = { Variables: { session: Session | undefined; ip: string } };
type Ctx = Context<Env>;
export interface BackendOptions {
  config?: Config; repo?: Repository; files?: FileStorage; events?: Broadcaster;
  providers?: Record<string, OAuthProvider>; now?: () => number; remoteAddress?: (c: Context) => string;
  /** Environment holding *_CLIENT_ID / *_CLIENT_SECRET (default process.env). */
  oauthEnv?: NodeJS.ProcessEnv;
  /** fetch used by OAuth adapters and the credential check (tests inject a mock). */
  oauthFetch?: typeof fetch;
  update?: UpdateChecker;
}

async function json(c: Ctx, limit: number): Promise<Record<string, unknown>> {
  if (!c.req.header('content-type')?.startsWith('application/json')) throw new ApiError(400, 'JSON_REQUIRED');
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_JSON');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiError(413, 'BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof result !== 'object' || !result || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw new ApiError(400, 'INVALID_JSON'); }
}
function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new ApiError(400, 'INVALID_INPUT');
  return value;
}
const oauthBrowserErrors = new Set([
  'OAUTH_STATE_INVALID', 'OAUTH_DENIED', 'OAUTH_PROVIDER_ERROR', 'INVITE_INVALID',
  'INVITATION_REQUIRED', 'USER_DISABLED', 'VERIFIED_EMAIL_REQUIRED', 'RATE_LIMITED', 'INTERNAL_ERROR',
  'ACCOUNT_EXISTS', 'IDENTITY_IN_USE', 'PROVIDER_ALREADY_LINKED', 'UNAUTHENTICATED',
]);
/** Shows that a secret is stored without revealing it (last 4 chars only for long secrets). */
function maskSecret(secret: string) {
  return secret.length >= 16 ? `••••••••${secret.slice(-4)}` : '••••••••';
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, 'INVALID_INPUT');
  return value;
}
function emailAddress(value: unknown): string {
  const email = string(value, 200).trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) throw new ApiError(400, 'INVALID_INPUT');
  return email;
}
function personName(value: unknown): string {
  const raw = string(value, 80);
  let name = '';
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) continue;
    name += char;
  }
  name = name.trim();
  if (!name) throw new ApiError(400, 'INVALID_INPUT');
  return name;
}
function tokenOptions(body: Record<string, unknown>) {
  const name = personName(body.name);
  const scopes = body.scopes === undefined ? ['read', 'write'] : body.scopes;
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 2 ||
      scopes.some(scope => scope !== 'read' && scope !== 'write') || new Set(scopes).size !== scopes.length) throw new ApiError(400, 'INVALID_INPUT');
  const days = body.expiresInDays === null ? null : integer(body.expiresInDays ?? 90, 1, 3650);
  return { name, scopes: scopes as TokenScope[], lifetimeMs: days === null ? null : days * 86400000 };
}
const userCodeAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const userCodeHash = (value: unknown) => hash(string(value, 32).toUpperCase().replace(/[-\s]/g, ''));
function ipSummary(ip: string) {
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(ip) === 6) return `IPv6 ${ip.split(':').filter(Boolean).slice(0, 2).join(':')}:…`;
  return 'unknown';
}
const maxQuotaBytes = limitRanges.userQuotaBytes.max;
function contentDisposition(kind: 'attachment' | 'inline', filename: string) {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16));
  const fallback = kind === 'inline' ? 'media' : 'download';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
function attachmentDisposition(filename: string) {
  return contentDisposition('attachment', filename);
}

export function createBackend(options: BackendOptions = {}) {
  const config = { ...(options.config ?? loadConfig()) };
  const now = options.now ?? Date.now;
  const repo = options.repo ?? new SqliteRepository(join(config.dataDir, 'dropit.sqlite'));
  const limits = new RuntimeLimits(config, repo);
  const files = options.files ?? new DiskFileStorage(join(config.dataDir, 'files'));
  const events = options.events ?? new MemoryBroadcaster();
  const oauthEnv = options.oauthEnv ?? process.env;
  const oauthFetch = options.oauthFetch ?? fetch;
  // RHEA-190 m11: credentials saved in 设置 override the environment; a saved but
  // disabled app turns that provider off. Resolved per request so saving needs no restart.
  const oauthApps = () => {
    const env = envOAuthApps(oauthEnv);
    const stored = new Map(repo.oauthApps().map(app => [app.provider, app]));
    return supportedProviders.map(provider => {
      const db = stored.get(provider);
      const source = db ? 'database' as const : env[provider] ? 'env' as const : 'none' as const;
      const credentials = db ? { clientId: db.clientId, clientSecret: db.clientSecret } : env[provider];
      return { provider, source, db, credentials, enabled: db ? Boolean(db.enabled) : Boolean(env[provider]) };
    });
  };
  const activeProviders = (): Record<string, OAuthProvider> => {
    if (options.providers) return options.providers;
    const result: Record<string, OAuthProvider> = {};
    for (const app of oauthApps()) if (app.enabled && app.credentials)
      result[app.provider] = createOAuthProvider(app.provider, app.credentials.clientId, app.credentials.clientSecret, oauthFetch);
    return result;
  };
  const callbackUrl = (provider: string) => `${config.origin}/api/auth/${provider}/callback`;
  const service = new ClipboardService(config, repo, files, events, now);
  const update = options.update ?? new UpdateChecker(loadBuildInfo(process.env, readJsonFile(buildInfoPath)), loadUpdateSettings(),
    { cache: jsonFileStore(join(config.dataDir, 'update-check.json')) });
  const app = new Hono<Env>();
  const limiter = new RateLimiter(config.rateWindowMs);
  const resolveIp = clientIpResolver(config);
  const sessionCookie = config.production ? '__Host-dropit_session' : 'dropit_session';
  const flowCookie = config.production ? '__Secure-dropit_oauth' : 'dropit_oauth';
  const cookie = { httpOnly: true, secure: config.production, sameSite: 'Lax' as const, path: '/' };
  const consume = (c: Ctx, key: string, count: number) => {
    const retry = limiter.consume(key, count, now());
    if (retry) { c.header('Retry-After', String(retry)); throw new ApiError(429, 'RATE_LIMITED'); }
  };
  const limit = (c: Ctx, group: string, count: number, account = true) => {
    const keys = [`${group}:ip:${c.get('ip')}`];
    if (account && c.get('session')) keys.push(`${group}:user:${c.get('session')!.user.id}`);
    for (const key of keys) consume(c, key, count);
  };
  app.use('*', async (c, next) => {
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.production) c.header('Strict-Transport-Security', 'max-age=31536000');
    await next();
  });
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    let remote: string;
    try { remote = options.remoteAddress?.(c) ?? getConnInfo(c).remote.address ?? 'unknown'; }
    catch { remote = 'unknown'; }
    let ip: string;
    try { ip = resolveIp(remote, c.req.header('x-forwarded-for')); }
    catch { ip = remote; }
    c.set('ip', ip);
    const chunkRequest = c.req.method === 'PUT' && /^\/api\/(?:spaces|rooms)\/[^/]+\/uploads\/[^/]+\/chunks\/[^/]+$/.test(c.req.path);
    limit(c, chunkRequest ? 'chunk' : 'general', chunkRequest ? config.rateChunk : config.rateGeneral, false);
    const rawSession = getCookie(c, sessionCookie);
    const authorization = c.req.header('authorization');
    if (authorization !== undefined) {
      // Any Authorization header selects machine authentication. Never fall back to cookies.
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
      const auth = match ? repo.tokenSession(hash(match[1]), now()) : undefined;
      if (!auth) { c.header('WWW-Authenticate', 'Bearer'); throw new ApiError(401, 'UNAUTHENTICATED'); }
      c.set('session', auth);
      consume(c, `${chunkRequest ? 'chunk-token' : 'token'}:${auth.bearer!.id}`, chunkRequest ? config.rateChunk : config.rateToken);
    } else {
      const browser = rawSession ? repo.session(hash(rawSession), now()) : undefined;
      if (browser) repo.touchSession(browser.sessionHash, now(), ipSummary(ip));
      c.set('session', browser);
    }
    const auth = c.get('session');
    if (auth) consume(c, `${chunkRequest ? 'chunk' : 'general'}:user:${auth.user.id}`, chunkRequest ? config.rateChunk : config.rateGeneral);
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const bearer = c.get('session')?.bearer;
    if (bearer && !bearer.scopes.includes(safe ? 'read' : 'write')) throw new ApiError(403, 'INSUFFICIENT_SCOPE');
    const publicDevice = c.req.method === 'POST' && ['/api/auth/device/authorize', '/api/auth/device/token'].includes(c.req.path) &&
      !rawSession && (!c.req.header('origin') || c.req.header('origin') === config.origin);
    if (!safe && !bearer && !publicDevice && c.req.header('origin') !== config.origin) throw new ApiError(403, 'ORIGIN_REJECTED');
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (error.status === 429 && !c.res.headers.has('Retry-After')) c.header('Retry-After', '1');
      return c.json({ error: { code: error.code } }, error.status);
    }
    // Do not log request URLs, cookies, OAuth codes, tokens, filenames or text.
    console.error('Backend operation failed', error instanceof Error ? error.name : 'UnknownError');
    return c.json({ error: { code: 'INTERNAL_ERROR' } }, 500);
  });
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND' } }, 404));
  app.get('/healthz', c => c.json({ status: 'ok' }));
  app.get('/api/version', c => c.json(update.build));
  app.get('/api/admin/update', c => {
    service.admin(c.get('session'));
    return c.json(update.report());
  });
  app.post('/api/admin/update/check', async c => {
    service.admin(c.get('session'));
    await update.checkNow();
    return c.json(update.report());
  });
  app.get('/api/auth/providers', c => c.json({ providers: Object.keys(activeProviders()) }));
  const browserSession = (c: Ctx) => {
    const auth = service.requireSession(c.get('session'));
    if (auth.bearer) throw new ApiError(403, 'BROWSER_SESSION_REQUIRED');
    return auth;
  };
  app.post('/api/tokens', async c => {
    const auth = browserSession(c);
    limit(c, 'token-create', config.rateAuth);
    const input = tokenOptions(await json(c, 2048));
    const raw = token();
    const record: AccessToken = { id: randomUUID(), userId: auth.user.id, name: input.name, scopes: input.scopes,
      createdAt: now(), lastUsedAt: null, expiresAt: input.lifetimeMs === null ? null : now() + input.lifetimeMs, revoked: 0 };
    repo.createAccessToken(record, hash(raw));
    return c.json({ ...record, token: raw }, 201);
  });
  app.get('/api/tokens', c => c.json({ tokens: repo.accessTokens(service.requireSession(c.get('session')).user.id) }));
  app.patch('/api/tokens/:id', async c => {
    const auth = browserSession(c);
    const body = await json(c, 2048);
    repo.renameAccessToken(c.req.param('id'), auth.user.id, personName(body.name));
    return c.body(null, 204);
  });
  app.delete('/api/tokens/:id', c => {
    repo.revokeAccessToken(c.req.param('id'), service.requireSession(c.get('session')).user.id);
    events.revalidate();
    return c.body(null, 204);
  });
  app.get('/api/admin/tokens', c => {
    service.admin(c.get('session'));
    return c.json({ tokens: repo.accessTokens(c.req.query('userId')) });
  });
  app.delete('/api/admin/tokens/:id', c => {
    service.admin(c.get('session'));
    repo.revokeAccessToken(c.req.param('id'));
    events.revalidate();
    return c.body(null, 204);
  });
  app.post('/api/auth/device/authorize', async c => {
    limit(c, 'device-authorize', config.rateAuth, false);
    const input = tokenOptions(await json(c, 2048));
    const deviceCode = token();
    const chars = Array.from({ length: 8 }, () => userCodeAlphabet[randomInt(userCodeAlphabet.length)]).join('');
    const userCode = `${chars.slice(0, 4)}-${chars.slice(4)}`;
    const id = randomUUID();
    repo.createDevice({ id, deviceCodeHash: hash(deviceCode), userCodeHash: userCodeHash(userCode),
      name: input.name, ipSummary: ipSummary(c.get('ip')), scopes: input.scopes, tokenLifetimeMs: input.lifetimeMs,
      expiresAt: now() + 600000, interval: 5, nextPollAt: now() + 5000, attempts: 0, status: 'pending', userId: null });
    const verificationUri = `${config.origin}/device`;
    return c.json({ device_code: deviceCode, user_code: userCode, verification_uri: verificationUri,
      verification_id: id, verification_uri_complete: `${verificationUri}?${new URLSearchParams({ user_code: userCode, verification_id: id })}`,
      expires_in: 600, interval: 5 });
  });
  app.post('/api/auth/device/token', async c => {
    limit(c, 'device-poll', config.rateGeneral, false);
    const body = await json(c, 2048);
    const deviceCode = string(body.device_code, 128);
    const raw = token();
    const result = repo.pollDevice(hash(deviceCode), now(), randomUUID(), hash(raw));
    if ('error' in result) return c.json(result, 400);
    return c.json({ access_token: raw, token_type: 'Bearer', scope: result.token.scopes.join(' '),
      expires_in: result.token.expiresAt === null ? null : Math.floor((result.token.expiresAt - now()) / 1000), token: result.token });
  });
  const requestedDevice = (c: Ctx, body: Record<string, unknown>) => {
    browserSession(c);
    limit(c, 'device-confirm', 5);
    const verificationId = body.verification_id === undefined ? undefined : string(body.verification_id, 64);
    const device = repo.deviceForUserCode(userCodeHash(body.user_code), verificationId, now());
    if (!device) throw new ApiError(404, 'NOT_FOUND');
    return device;
  };
  app.get('/api/auth/device', c => {
    const device = requestedDevice(c, c.req.query());
    return c.json({ name: device.name, ipSummary: device.ipSummary, scopes: device.scopes,
      expiresAt: device.expiresAt, tokenExpiresInDays: device.tokenLifetimeMs === null ? null : device.tokenLifetimeMs / 86400000 });
  });
  for (const decision of ['approve', 'deny']) app.post(`/api/auth/device/${decision}`, async c => {
    const device = requestedDevice(c, await json(c, 2048));
    repo.decideDevice(device.id, c.get('session')!.user.id, decision === 'approve', now());
    return c.body(null, 204);
  });
  const oauthFailure = (c: Ctx, error: unknown) => {
    const code = error instanceof ApiError && oauthBrowserErrors.has(error.code) ? error.code : 'INTERNAL_ERROR';
    return c.redirect(`${config.origin}/login?error=${code}`);
  };
  app.get('/api/auth/:provider', c => {
    limit(c, 'auth', config.rateAuth, false);
    const providerName = c.req.param('provider');
    const providers = activeProviders();
    const provider = Object.hasOwn(providers, providerName) ? providers[providerName] : undefined;
    if (!provider) throw new ApiError(404, 'PROVIDER_UNAVAILABLE');
    // ?link=1 binds this provider to the signed-in account instead of signing in.
    // It needs a browser session; the callback re-checks that the same user is still signed in.
    let linkUserId: string | null = null;
    if (c.req.query('link') !== undefined) {
      const auth = c.get('session');
      if (!auth || auth.bearer) return c.redirect(`${config.origin}/login?error=UNAUTHENTICATED`);
      linkUserId = auth.user.id;
    }
    const invite = linkUserId ? undefined : c.req.query('invite');
    const inviteHash = invite ? hash(invite) : null;
    const liveInvite = inviteHash ? repo.invite(inviteHash, now()) : undefined;
    // Invite-first applies after the installation has an account. An unknown
    // token must not stop the first sign-up while the users table is empty.
    if (inviteHash && !liveInvite && repo.users().length > 0) return c.redirect(`${config.origin}/login?error=INVITE_INVALID`);
    const state = token();
    const browser = token();
    const verifier = token();
    repo.saveFlow({ stateHash: hash(state), browserHash: hash(browser), provider: providerName, verifier,
      inviteHash: liveInvite ? inviteHash : null, expiresAt: now() + 600000, linkUserId });
    setCookie(c, flowCookie, browser, { ...cookie, path: '/api/auth', maxAge: 600 });
    return c.redirect(provider.authorizationUrl(state, hash(verifier), callbackUrl(providerName)));
  });
  app.get('/api/auth/:provider/callback', async c => {
    let linking = false;
    try {
      limit(c, 'auth', config.rateAuth, false);
      const providerName = c.req.param('provider');
      const providers = activeProviders();
      const provider = Object.hasOwn(providers, providerName) ? providers[providerName] : undefined;
      const state = c.req.query('state');
      const browser = getCookie(c, flowCookie);
      if (!provider || !state || !browser) throw new ApiError(400, 'OAUTH_STATE_INVALID');
      const flow = repo.consumeFlow(hash(state), hash(browser), providerName, now());
      if (!flow) throw new ApiError(400, 'OAUTH_STATE_INVALID');
      deleteCookie(c, flowCookie, { ...cookie, path: '/api/auth' });
      linking = Boolean(flow.linkUserId);
      const code = c.req.query('code');
      // Provider error text stays off the redirect. Only a fixed code is shown.
      if (!code || code.length > 4096 || c.req.query('error')) throw new ApiError(400, 'OAUTH_DENIED');
      const identity = await provider.exchange(code, flow.verifier, callbackUrl(providerName));
      if (identity.provider !== providerName) throw new ApiError(400, 'OAUTH_PROVIDER_ERROR');
      const retry = limiter.consume(`auth:identity:${hash(`${providerName}:${identity.subject}`)}`, config.rateAuth, now());
      if (retry) { c.header('Retry-After', String(retry)); throw new ApiError(429, 'RATE_LIMITED'); }
      // A completed exchange proves id, secret and the registered callback URL.
      if (!options.providers && repo.oauthApps().some(app => app.provider === providerName)) repo.recordOAuthCheck(providerName, true, 'LOGIN_OK', now());
      if (flow.linkUserId) {
        const auth = c.get('session');
        // The browser that started the bind must still be signed in as the same user.
        if (!auth || auth.bearer || auth.user.id !== flow.linkUserId) throw new ApiError(401, 'UNAUTHENTICATED');
        const added = repo.linkIdentity(auth.user.id, identity, now());
        return c.redirect(`${config.origin}/settings?${new URLSearchParams({ linked: providerName, ...(added ? {} : { already: '1' }) })}#login-methods`);
      }
      const session = token();
      repo.login(identity, flow.inviteHash, config.adminEmails, hash(session), now() + config.sessionMs, now(),
        { userAgent: c.req.header('user-agent') ?? null, ipSummary: ipSummary(c.get('ip')) });
      setCookie(c, sessionCookie, session, { ...cookie, maxAge: Math.floor(config.sessionMs / 1000) });
      return c.redirect(`${config.origin}/`);
    } catch (error) {
      if (linking) {
        const code = error instanceof ApiError && oauthBrowserErrors.has(error.code) ? error.code : 'INTERNAL_ERROR';
        return c.redirect(`${config.origin}/settings?link_error=${code}#login-methods`);
      }
      return oauthFailure(c, error);
    }
  });
  // RHEA-190 m11: 登录方式 — several providers on one account.
  app.get('/api/me/identities', c => {
    const auth = browserSession(c);
    return c.json({ identities: repo.identities(auth.user.id), available: Object.keys(activeProviders()) });
  });
  app.delete('/api/me/identities/:provider', c => {
    const auth = browserSession(c);
    limit(c, 'identity', config.rateAuth);
    repo.unlinkIdentity(auth.user.id, c.req.param('provider'));
    return c.body(null, 204);
  });
  // RHEA-190 m11: OAuth app configuration (admins). Secrets are write-only.
  const oauthView = () => ({ origin: config.origin, providers: oauthApps().map(app => ({
    provider: app.provider, label: providerInfo[app.provider].label,
    consoleUrl: providerInfo[app.provider].consoleUrl, docsUrl: providerInfo[app.provider].docsUrl,
    callbackUrl: callbackUrl(app.provider), homepageUrl: config.origin,
    source: app.source, enabled: app.enabled, active: Object.hasOwn(activeProviders(), app.provider),
    clientId: app.credentials?.clientId ?? '', secretSet: Boolean(app.credentials?.clientSecret),
    secretHint: app.credentials?.clientSecret ? maskSecret(app.credentials.clientSecret) : null,
    envConfigured: Boolean(envOAuthApps(oauthEnv)[app.provider]),
    updatedAt: app.db?.updatedAt ?? null,
    check: app.db?.checkedAt ? { at: app.db.checkedAt, ok: Boolean(app.db.checkOk), code: app.db.checkCode } : null,
  })) });
  const oauthProviderParam = (c: Ctx) => {
    const provider = c.req.param('provider') ?? '';
    if (!isSupportedProvider(provider)) throw new ApiError(404, 'PROVIDER_UNSUPPORTED');
    return provider;
  };
  const adminBrowser = (c: Ctx) => {
    const auth = service.admin(c.get('session'));
    if (auth.bearer) throw new ApiError(403, 'BROWSER_SESSION_REQUIRED');
    return auth;
  };
  app.get('/api/admin/oauth', c => { adminBrowser(c); return c.json(oauthView()); });
  app.put('/api/admin/oauth/:provider', async c => {
    const auth = adminBrowser(c);
    limit(c, 'oauth-config', config.rateAuth);
    const provider = oauthProviderParam(c);
    const body = await json(c, 4096);
    const clientId = string(typeof body.clientId === 'string' ? body.clientId.trim() : body.clientId, 256);
    if (!/^[A-Za-z0-9._\-]+$/.test(clientId)) throw new ApiError(400, 'INVALID_CLIENT_ID');
    let clientSecret: string | null = null;
    if (body.clientSecret !== undefined && body.clientSecret !== null && body.clientSecret !== '') {
      clientSecret = string(typeof body.clientSecret === 'string' ? body.clientSecret.trim() : body.clientSecret, 512);
      if (/\s/.test(clientSecret)) throw new ApiError(400, 'INVALID_INPUT');
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT');
    // Keeping the secret falls back to the environment one when the app is first copied from env.
    if (clientSecret === null && !repo.oauthApps().some(app => app.provider === provider)) {
      clientSecret = envOAuthApps(oauthEnv)[provider]?.clientSecret ?? null;
    }
    repo.saveOAuthApp({ provider, clientId, clientSecret, enabled: body.enabled !== false, now: now(), actor: auth.user.email });
    return c.json(oauthView());
  });
  app.delete('/api/admin/oauth/:provider', c => {
    adminBrowser(c);
    limit(c, 'oauth-config', config.rateAuth);
    repo.deleteOAuthApp(oauthProviderParam(c));
    return c.json(oauthView());
  });
  app.post('/api/admin/oauth/:provider/verify', async c => {
    adminBrowser(c);
    limit(c, 'oauth-verify', 10);
    const provider = oauthProviderParam(c);
    const app = oauthApps().find(entry => entry.provider === provider)!;
    if (!app.credentials) throw new ApiError(400, 'PROVIDER_UNAVAILABLE');
    const result = await checkOAuthCredentials(provider, app.credentials.clientId, app.credentials.clientSecret, callbackUrl(provider), oauthFetch);
    if (app.db) repo.recordOAuthCheck(provider, result.ok, result.code, now());
    return c.json({ ...result, checkedAt: now(), source: app.source, ...oauthView() });
  });
  app.get('/api/me', c => {
    const auth = service.requireSession(c.get('session'));
    return c.json({ user: auth.user, usedBytes: repo.usage(auth.user.id), reservedBytes: repo.reservedBytes(auth.user.id, now()),
      quotaBytes: repo.quotaOverride(auth.user.id) ?? config.userQuotaBytes,
      maxFileBytes: config.maxFileBytes, maxTextBytes: config.maxTextBytes, retentionMs: config.retentionMs });
  });
  app.post('/api/auth/logout', c => {
    const auth = service.requireSession(c.get('session'));
    if (auth.bearer) repo.revokeAccessToken(auth.bearer.id, auth.user.id);
    else repo.logout(auth.sessionHash);
    events.revalidate();
    if (!auth.bearer) deleteCookie(c, sessionCookie, cookie);
    return c.body(null, 204);
  });
  // RHEA-190 r4: 登录设备. Each browser login is listed with a readable name and
  // can be signed out on its own. Only cookie sessions may manage sessions; a
  // bearer token cannot sign browsers out (tokens are managed under 令牌).
  const socketsBySession = new Map<string, number>();
  const sessionView = (row: BrowserSession, currentId: string | undefined, online: boolean) => {
    const agent = describeAgent(row.userAgent);
    return { id: row.id, current: row.id === currentId, online, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt, ipSummary: row.ipSummary, browser: agent.browser, os: agent.os, device: row.device };
  };
  const listSessions = (userId: string, auth: Session) => {
    const onlineIds = new Set<string>();
    for (const [sessionHash, count] of socketsBySession) if (count > 0) {
      const live = repo.session(sessionHash, now());
      if (live?.sessionId && live.user.id === userId) onlineIds.add(live.sessionId);
    }
    return repo.browserSessions(userId, now()).map(row => sessionView(row, auth.sessionId, onlineIds.has(row.id)));
  };
  app.get('/api/sessions', c => {
    const auth = browserSession(c);
    return c.json({ sessions: listSessions(auth.user.id, auth) });
  });
  app.delete('/api/sessions/:id', c => {
    const auth = browserSession(c);
    limit(c, 'session-revoke', config.rateAuth);
    const removed = repo.revokeSession(c.req.param('id'), auth.user.id);
    events.revalidate();
    if (removed === auth.sessionHash) deleteCookie(c, sessionCookie, cookie);
    return c.body(null, 204);
  });
  app.post('/api/sessions/revoke-others', c => {
    const auth = browserSession(c);
    limit(c, 'session-revoke', config.rateAuth);
    const revoked = repo.revokeOtherSessions(auth.user.id, auth.sessionHash);
    events.revalidate();
    return c.json({ revoked });
  });
  app.get('/api/admin/users/:id/sessions', c => {
    const auth = service.admin(c.get('session'));
    if (!repo.users().some(user => user.id === c.req.param('id'))) throw new ApiError(404, 'NOT_FOUND');
    return c.json({ sessions: listSessions(c.req.param('id'), auth) });
  });
  app.delete('/api/admin/sessions/:id', c => {
    const auth = service.admin(c.get('session'));
    const removed = repo.revokeSession(c.req.param('id'));
    events.revalidate();
    if (removed === auth.sessionHash) deleteCookie(c, sessionCookie, cookie);
    return c.body(null, 204);
  });
  app.get('/api/invites/:token', c => {
    limit(c, 'invite', config.rateInvite);
    const invite = repo.invite(hash(c.req.param('token')), now());
    if (!invite) throw new ApiError(404, 'NOT_FOUND');
    const space = repo.space(invite.spaceId)!;
    return c.json({ spaceName: space.name, expiresAt: invite.expiresAt, remainingUses: invite.maxUses - invite.uses });
  });
  const effectiveQuota = (userId: string) => repo.quotaOverride(userId) ?? config.userQuotaBytes;
  app.get('/api/admin/users', c => {
    service.admin(c.get('session'));
    return c.json({ users: repo.users().map(user => ({
      id: user.id, email: user.email, name: user.name, role: user.role, disabled: user.disabled,
      pending: user.pending, createdAt: user.createdAt, usedBytes: user.usedBytes,
      quotaBytes: user.quotaBytes ?? config.userQuotaBytes, quotaOverride: user.quotaBytes,
    })) });
  });
  app.post('/api/admin/users', async c => {
    service.admin(c.get('session'));
    const body = await json(c, 2048);
    const email = emailAddress(body.email);
    const name = body.name === undefined ? email.slice(0, email.indexOf('@')).slice(0, 80) : personName(body.name);
    let role: 'admin' | 'user' = 'user';
    if (body.role !== undefined) {
      if (body.role !== 'admin' && body.role !== 'user') throw new ApiError(400, 'INVALID_INPUT');
      role = body.role;
    }
    // Configured bootstrap addresses are admins at creation, including pre-provision.
    if (config.adminEmails.includes(email)) role = 'admin';
    const quotaBytes = body.quotaBytes === undefined ? null : integer(body.quotaBytes, 1, maxQuotaBytes);
    const user = repo.provisionUser({ email, name, role, quotaBytes, now: now() });
    return c.json({ ...user, usedBytes: 0, quotaBytes: quotaBytes ?? config.userQuotaBytes, quotaOverride: quotaBytes }, 201);
  });
  app.post('/api/admin/users/:id/logout', c => {
    service.admin(c.get('session'));
    repo.revokeSessions(c.req.param('id'));
    events.revalidate();
    return c.body(null, 204);
  });
  app.patch('/api/admin/users/:id', async c => {
    service.admin(c.get('session'));
    const body = await json(c, 2048);
    const patch: { disabled?: boolean; role?: 'admin' | 'user'; name?: string; quotaBytes?: number | null } = {};
    if ('disabled' in body) {
      if (typeof body.disabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT');
      patch.disabled = body.disabled;
    }
    if ('role' in body) {
      if (body.role !== 'admin' && body.role !== 'user') throw new ApiError(400, 'INVALID_INPUT');
      patch.role = body.role;
    }
    if ('name' in body) patch.name = personName(body.name);
    if ('quotaBytes' in body) patch.quotaBytes = body.quotaBytes === null ? null : integer(body.quotaBytes, 1, maxQuotaBytes);
    if (!('disabled' in body || 'role' in body || 'name' in body || 'quotaBytes' in body)) throw new ApiError(400, 'INVALID_INPUT');
    repo.updateUser(c.req.param('id'), patch);
    if (patch.disabled) await service.uploads.cancelUser(c.req.param('id'));
    events.revalidate();
    return c.body(null, 204);
  });
  app.get('/api/admin/limits', c => {
    service.admin(c.get('session'));
    return c.json(limits.describe());
  });
  app.patch('/api/admin/limits', async c => {
    const auth = service.admin(c.get('session'));
    const result = limits.update(await json(c, 4096), auth.user, now());
    limiter.setWindow(config.rateWindowMs);
    return c.json(result);
  });
  app.get('/api/admin/limits/audit', c => {
    service.admin(c.get('session'));
    const pageInteger = (value: string | undefined, max: number) => {
      if (value === undefined) return undefined;
      if (!/^[1-9]\d*$/.test(value)) throw new ApiError(400, 'INVALID_INPUT');
      return integer(Number(value), 1, max);
    };
    const size = pageInteger(c.req.query('limit'), 100) ?? 50;
    const cursor = pageInteger(c.req.query('cursor'), Number.MAX_SAFE_INTEGER);
    const entries = repo.limitAudit(size + 1, cursor);
    const more = entries.length > size;
    return c.json({ entries: entries.slice(0, size), nextCursor: more ? entries[size - 1].id : null });
  });
  app.get('/api/admin/invites', c => { service.admin(c.get('session')); return c.json({ invites: repo.invites() }); });
  app.post('/api/admin/invites', async c => {
    service.admin(c.get('session')); limit(c, 'invite', config.rateInvite);
    const body = await json(c, 2048);
    return c.json(service.createInvite(c.get('session'), string(body.spaceId), integer(body.maxUses ?? 1, 1, 100), integer(body.expiresInHours ?? 24, 1, 720)), 201);
  });
  app.delete('/api/admin/invites/:id', c => {
    service.admin(c.get('session')); limit(c, 'invite', config.rateInvite);
    repo.revokeInvite(c.req.param('id'));
    return c.body(null, 204);
  });
  app.get('/api/spaces', c => {
    const auth = service.requireSession(c.get('session'));
    return c.json({ spaces: repo.spaces(auth.user.id).map(({ roomHash: _room, deviceHash: _device, ...space }) => space) });
  });
  // RHEA-190 step 7: browsers send their secret room key so 临时房间 re-enters the
  // one live room they already have instead of minting a new room per click.
  app.post('/api/rooms', async c => {
    let deviceKey: string | undefined;
    if (c.req.header('content-type')?.startsWith('application/json')) {
      const body = await json(c, 2048);
      if (body.deviceKey !== undefined) {
        if (typeof body.deviceKey !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(body.deviceKey)) throw new ApiError(400, 'INVALID_INPUT');
        deviceKey = body.deviceKey;
      }
    }
    const existing = deviceKey ? service.deviceRoom(deviceKey) : null;
    if (existing) return c.json(existing, 200);
    limit(c, 'room-create', config.rateRoom);
    return c.json(service.createRoom(deviceKey), 201);
  });
  const shareLimit = (c: Ctx, raw: string) => {
    limit(c, 'share', config.rateAuth, false);
    limit(c, `share:${hash(raw).slice(0, 32)}`, config.rateUpload, false);
  };
  const sendPreview = async (c: Ctx, item: Item, shared = false) => {
    const preview = await service.preview(item);
    const maxAge = Math.max(0, Math.min(60, Math.floor((item.expiresAt - now()) / 1000)));
    c.header('Content-Type', 'image/webp');
    c.header('Content-Disposition', 'inline');
    c.header('Cache-Control', shared ? 'no-store' : `private, max-age=${maxAge}`);
    return c.body(new Uint8Array(preview));
  };
  const sendMedia = async (c: Ctx, item: Item) => {
    if (!item.fileKey || item.size < 1) throw new ApiError(404, 'NOT_FOUND');
    const sniffed = sniffMedia(await files.prefix(item.fileKey, 4096));
    if (!sniffed) throw new ApiError(404, 'NOT_FOUND');
    const range = parseByteRange(c.req.header('range'), item.size);
    c.header('Accept-Ranges', 'bytes');
    c.header('Content-Type', sniffed.contentType);
    c.header('Content-Disposition', contentDisposition('inline', item.filename ?? 'media'));
    c.header('Cache-Control', 'private, no-store');
    if (range === 'unsatisfiable') {
      c.header('Content-Range', `bytes */${item.size}`);
      return c.body(null, 416);
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? item.size - 1;
    c.header('Content-Length', String(end - start + 1));
    if (range) c.header('Content-Range', `bytes ${start}-${end}/${item.size}`);
    return c.body(files.stream(item.fileKey, start, end), range ? 206 : 200);
  };
  const sendDownload = (c: Ctx, item: Item) => {
    if (!item.fileKey || !item.filename) throw new ApiError(404, 'NOT_FOUND');
    const range = parseByteRange(c.req.header('range'), item.size);
    c.header('Accept-Ranges', 'bytes');
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', attachmentDisposition(item.filename));
    if (range === 'unsatisfiable') {
      c.header('Content-Range', `bytes */${item.size}`);
      return c.body(null, 416);
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? item.size - 1;
    c.header('Content-Length', String(end - start + 1));
    if (range) c.header('Content-Range', `bytes ${start}-${end}/${item.size}`);
    return c.body(files.stream(item.fileKey, start, end), range ? 206 : 200);
  };
  app.get('/api/s/:token', c => {
    const raw = c.req.param('token');
    shareLimit(c, raw);
    return c.json(service.openPublicShare(raw));
  });
  app.get('/api/s/:token/file', c => {
    const raw = c.req.param('token');
    shareLimit(c, raw);
    let access = c.req.query('access');
    if (!access) {
      // A direct download spends one view and returns a ticket for subsequent ranges.
      access = service.openPublicShare(raw).access;
      c.header('X-Share-Access', access);
      c.header('Content-Location', `/api/s/${raw}/file?${new URLSearchParams({ access })}`);
    }
    return sendDownload(c, service.readPublicShare(raw, access));
  });
  app.get('/api/s/:token/thumbnail', c => {
    const raw = c.req.param('token');
    shareLimit(c, raw);
    const item = service.readPublicShare(raw, c.req.query('access'));
    if (!item.thumbnailKey) throw new ApiError(404, 'NOT_FOUND');
    c.header('Content-Type', 'image/webp');
    return c.body(files.stream(item.thumbnailKey));
  });
  app.get('/api/s/:token/preview', async c => {
    const raw = c.req.param('token');
    shareLimit(c, raw);
    return sendPreview(c, service.readPublicShare(raw, c.req.query('access')), true);
  });
  app.get('/api/s/:token/media', async c => {
    const raw = c.req.param('token');
    shareLimit(c, raw);
    return sendMedia(c, service.readPublicShare(raw, c.req.query('access')));
  });

  const scope = (c: Ctx, chunk = false) => {
    if (c.req.param('room')) {
      if (!chunk) limit(c, 'room-access', config.rateUpload);
      return service.room(c.req.param('room')!);
    }
    return service.space(c.req.param('space')!, c.get('session'));
  };
  // Optional item metadata a client may attach: which device sent it and which
  // demo-style group it belongs to. Headers so binary uploads can carry them too.
  const meta = (c: Ctx, group?: unknown): ItemMeta => {
    const device = parseDevice(c.req.header('x-dropit-device'), c.req.header('x-dropit-device-name'), c.req.header('x-dropit-device-kind'));
    let headerGroup: string | undefined;
    const rawGroup = c.req.header('x-dropit-group');
    if (rawGroup) {
      try { headerGroup = decodeURIComponent(rawGroup); } catch { throw new ApiError(400, 'INVALID_GROUP'); }
    }
    return { device, group: group ?? headerGroup };
  };
  for (const base of ['/api/spaces/:space', '/api/rooms/:room']) {
    app.get(`${base}/groups`, c => c.json({ groups: service.groups(scope(c)) }));
    app.post(`${base}/groups`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      const body = await json(c, 2048);
      return c.json({ groups: service.createGroup(space, body.name) }, 201);
    });
    app.patch(`${base}/groups/:name`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      const body = await json(c, 2048);
      return c.json({ groups: service.renameGroup(space, c.req.param('name')!, body.name) });
    });
    app.delete(`${base}/groups/:name`, c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      return c.json({ groups: service.deleteGroup(space, c.req.param('name')!) });
    });
    app.post(`${base}/uploads`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'upload', space.roomHash ? config.rateRoom : config.rateUpload);
      const body = await json(c, 8192);
      const mime = string(body.mime, 200).split(';')[0].trim().toLowerCase();
      if (!mime) throw new ApiError(400, 'INVALID_INPUT');
      return c.json(service.uploads.create(space, c.get('session'), string(body.filename, 4096),
        integer(body.size, 1, Number.MAX_SAFE_INTEGER), mime), 201);
    });
    app.get(`${base}/uploads/:id`, c => c.json(service.uploads.get(scope(c), c.get('session'), c.req.param('id')!)));
    app.put(`${base}/uploads/:id/chunks/:index`, async c => {
      await service.uploads.put(scope(c, true), c.get('session'), c.req.param('id')!, c.req.param('index')!, c.req.raw.body,
        c.req.header('x-chunk-sha256'));
      return c.body(null, 204);
    });
    app.post(`${base}/uploads/:id/complete`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'upload', space.roomHash ? config.rateRoom : config.rateUpload);
      return c.json({ item: await service.uploads.complete(space, c.get('session'), c.req.param('id')!, meta(c)) }, 201);
    });
    app.delete(`${base}/uploads/:id`, async c => {
      await service.uploads.cancel(scope(c), c.get('session'), c.req.param('id')!);
      return c.body(null, 204);
    });
    app.get(base, c => {
      const space = scope(c);
      const session = c.get('session');
      return c.json({ id: space.id, name: space.name, expiresAt: space.expiresAt,
        maxFileBytes: space.roomHash ? config.roomMaxFileBytes : config.maxFileBytes,
        quotaBytes: space.roomHash ? config.roomQuotaBytes : effectiveQuota(session!.user.id) });
    });
    app.get(`${base}/items`, c => c.json(service.snapshot(scope(c))));
    app.post(`${base}/items/text`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      const body = await json(c, config.maxTextBytes * 6 + 1024);
      return c.json({ item: service.text(space, c.get('session'), string(body.text, Infinity), meta(c, body.group)) }, 201);
    });
    app.post(`${base}/items/file`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'upload', space.roomHash ? config.rateRoom : config.rateUpload);
      const max = space.roomHash ? config.roomMaxFileBytes : config.maxFileBytes;
      const rawLength = c.req.header('content-length');
      const length = rawLength == null || rawLength === '' ? NaN : Number(rawLength);
      if (Number.isFinite(length) && length > max) throw new ApiError(413, 'FILE_TOO_LARGE');
      const expected = Number.isInteger(length) && length >= 0 ? length : undefined;
      let filename: string;
      try { filename = decodeURIComponent(c.req.header('x-file-name') ?? 'download'); }
      catch { throw new ApiError(400, 'INVALID_FILENAME'); }
      if (filename.length > 4096) throw new ApiError(400, 'INVALID_FILENAME');
      const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
      if (mime.length > 200) throw new ApiError(400, 'INVALID_INPUT');
      if (!c.req.raw.body) throw new ApiError(400, 'EMPTY_FILE');
      return c.json({ item: await service.upload(space, c.get('session'), c.req.raw.body, filename, mime, expected, undefined, undefined, meta(c)) }, 201);
    });
    app.patch(`${base}/items/:id/labels`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      const body = await json(c, 4096);
      const patch: { pinned?: boolean; tags?: unknown; group?: unknown } = {};
      if ('pinned' in body) {
        if (typeof body.pinned !== 'boolean') throw new ApiError(400, 'INVALID_INPUT');
        patch.pinned = body.pinned;
      }
      if ('tags' in body) patch.tags = body.tags;
      if ('group' in body) {
        if (body.group !== null && typeof body.group !== 'string') throw new ApiError(400, 'INVALID_GROUP');
        patch.group = body.group;
      }
      return c.json({ item: service.label(space, c.get('session'), c.req.param('id')!, patch) });
    });
    app.patch(`${base}/items/:id`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      const body = await json(c, config.maxTextBytes * 6 + 1024);
      return c.json({ item: service.editText(space, c.get('session'), c.req.param('id')!, string(body.text, Infinity)) });
    });
    app.post(`${base}/items/:id/shares`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      const body = await json(c, 2048);
      const maxViews = body.maxViews === undefined || body.maxViews === null ? null : integer(body.maxViews, 1, 100);
      return c.json(service.createShare(space, c.get('session'), c.req.param('id')!, string(body.expiresIn, 8), maxViews), 201);
    });
    app.get(`${base}/items/:id/shares`, c => {
      const space = scope(c);
      return c.json({ shares: service.listShares(space, c.get('session'), c.req.param('id')!) });
    });
    app.delete(`${base}/shares/:shareId`, c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      service.revokeShare(space, c.get('session'), c.req.param('shareId')!);
      return c.body(null, 204);
    });
    app.delete(`${base}/items/:id`, async c => {
      const space = scope(c);
      limit(c, space.roomHash ? 'room-write' : 'write', space.roomHash ? config.rateRoom : config.rateUpload);
      await service.retract(space, c.req.param('id')!, c.get('session'));
      return c.body(null, 204);
    });
    app.get(`${base}/items/:id/download`, c => {
      const item = service.item(scope(c), c.req.param('id')!);
      return sendDownload(c, item);
    });
    app.get(`${base}/items/:id/thumbnail`, c => {
      const item = service.item(scope(c), c.req.param('id')!);
      if (!item.thumbnailKey) throw new ApiError(404, 'NOT_FOUND');
      c.header('Content-Type', 'image/webp');
      return c.body(files.stream(item.thumbnailKey));
    });
    app.get(`${base}/items/:id/preview`, async c => sendPreview(c, service.item(scope(c), c.req.param('id')!)));
    app.get(`${base}/items/:id/media`, async c => sendMedia(c, service.item(scope(c), c.req.param('id')!)));
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const socketsByIp = new Map<string, number>();
  const socketsByUser = new Map<string, number>();
  // Who is connected per channel, for the demo-style named presence dots. Only
  // sockets that identified a device are listed; `devices` keeps the raw count.
  const peersBySpace = new Map<string, Map<object, ItemDevice>>();
  const presence = (spaceId: string) => {
    const seen = new Map<string, ItemDevice>();
    for (const peer of peersBySpace.get(spaceId)?.values() ?? []) if (!seen.has(peer.id)) seen.set(peer.id, peer);
    const devices = events.count(spaceId);
    if (!seen.size) return { type: 'presence', devices };
    // `devices` counts sockets (two tabs of one browser = 2). Sockets that never named a
    // device (CLI, API, old clients) are reported as `others`, so the UI can count unique
    // devices instead of connections (RHEA-190 m12).
    const others = Math.max(0, devices - (peersBySpace.get(spaceId)?.size ?? 0));
    const peers = [...seen.values()];
    return others ? { type: 'presence', devices, peers, others } : { type: 'presence', devices, peers };
  };
  for (const base of ['/api/spaces/:space', '/api/rooms/:room']) {
    app.get(`${base}/ws`, c => {
      if (!c.get('session')?.bearer && c.req.header('origin') !== config.origin) throw new ApiError(403, 'ORIGIN_REJECTED');
      const space = scope(c);
      const auth = c.get('session');
      const ip = c.get('ip');
      const userKey = auth?.user.id ?? `room:${ip}`;
      const bearerHash = auth?.bearer ? hash(c.req.header('authorization')!.slice(7)) : undefined;
      if ((socketsByIp.get(ip) ?? 0) >= 8 || (socketsByUser.get(userKey) ?? 0) >= 8 || wss.clients.size >= 256) throw new ApiError(429, 'SOCKET_LIMIT');
      const authorized = () => {
        if (bearerHash && !repo.tokenSession(bearerHash, now(), false)) return false;
        if (space.roomHash) return Boolean(repo.room(space.roomHash, now()));
        return Boolean(auth && (bearerHash || repo.session(auth.sessionHash, now())) && repo.isMember(space.id, auth.user.id));
      };
      const peer = parseDevice(c.req.query('device'), c.req.query('name'), c.req.query('kind'), false);
      const peerKey = {};
      const sessionKey = auth && !auth.bearer ? auth.sessionHash : undefined;
      let unsubscribe: (() => void) | undefined;
      let opened = false;
      const release = () => {
        unsubscribe?.();
        unsubscribe = undefined;
        const peers = peersBySpace.get(space.id);
        if (peers?.delete(peerKey) && !peers.size) peersBySpace.delete(space.id);
        if (!opened) return;
        opened = false;
        const counters: [Map<string, number>, string][] = [[socketsByIp, ip], [socketsByUser, userKey]];
        if (sessionKey) counters.push([socketsBySession, sessionKey]);
        for (const [map, key] of counters) {
          const count = (map.get(key) ?? 1) - 1;
          if (count) map.set(key, count); else map.delete(key);
        }
        events.publish(space.id, presence(space.id));
      };
      return upgradeWebSocket(c, {
        onOpen(_event, ws) {
          if (!authorized()) { ws.close(1008); return; }
          if ((socketsByIp.get(ip) ?? 0) >= 8 || (socketsByUser.get(userKey) ?? 0) >= 8 || wss.clients.size > 256) {
            ws.close(1013, 'Socket limit'); return;
          }
          opened = true;
          socketsByIp.set(ip, (socketsByIp.get(ip) ?? 0) + 1);
          socketsByUser.set(userKey, (socketsByUser.get(userKey) ?? 0) + 1);
          if (sessionKey) {
            socketsBySession.set(sessionKey, (socketsBySession.get(sessionKey) ?? 0) + 1);
            if (peer) repo.tagSession(sessionKey, peer);
          }
          unsubscribe = events.subscribe(space.id, {
            send(data) { if (((ws.raw as WebSocket | undefined)?.bufferedAmount ?? 0) > 1024 ** 2) { ws.close(1013, 'Slow consumer'); release(); } else ws.send(data); },
            close(code, reason) { ws.close(code, reason); release(); },
          }, authorized);
          // Authoritative replacement snapshot on EVERY connect, including reconnect.
          ws.send(JSON.stringify(service.snapshot(space)));
          if (peer) {
            const peers = peersBySpace.get(space.id) ?? new Map<object, ItemDevice>();
            peers.set(peerKey, peer);
            peersBySpace.set(space.id, peers);
          }
          events.publish(space.id, presence(space.id));
        },
        onMessage(_event, ws) { ws.close(1008, 'Read-only channel'); },
        onClose: release, onError: release,
      });
    });
  }
  let timer: NodeJS.Timeout | undefined;
  let validation: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const alive = new WeakSet<object>();
  wss.on('connection', ws => { alive.add(ws); ws.on('pong', () => alive.add(ws)); });
  return {
    app, repo, files, events, service, config, update, websocket: { server: wss },
    async startMaintenance() {
      await service.cleanup();
      timer = setInterval(() => { void service.cleanup().catch(() => console.error('Cleanup failed; will retry')); }, config.cleanupMs).unref();
      validation = setInterval(() => events.revalidate(), 1000).unref();
      heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
          if (!alive.has(ws)) ws.terminate();
          else { alive.delete(ws); ws.ping(); }
        }
      }, 30000).unref();
      update.start();
    },
    async close() {
      clearInterval(timer); clearInterval(validation); clearInterval(heartbeat);
      update.stop();
      events.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await service.cleanup();
      repo.close();
    },
  };
}

import { ApiError, type Identity } from './domain.js';

export interface OAuthProvider {
  authorizationUrl(state: string, challenge: string, redirectUri: string): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<Identity>;
}

/** Providers the adapters below implement. Settings can only configure these. */
export const supportedProviders = ['github', 'google'] as const;
export type SupportedProvider = typeof supportedProviders[number];
export const isSupportedProvider = (name: string): name is SupportedProvider => (supportedProviders as readonly string[]).includes(name);
export const providerInfo: Record<SupportedProvider, { label: string; consoleUrl: string; docsUrl: string }> = {
  github: { label: 'GitHub', consoleUrl: 'https://github.com/settings/developers',
    docsUrl: 'https://docs.github.com/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app' },
  google: { label: 'Google', consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    docsUrl: 'https://developers.google.com/identity/protocols/oauth2/web-server' },
};

/** Client credentials from the environment (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET, ...). */
export function envOAuthApps(env: NodeJS.ProcessEnv = process.env) {
  const result: Partial<Record<SupportedProvider, { clientId: string; clientSecret: string }>> = {};
  for (const provider of supportedProviders) {
    const clientId = env[`${provider.toUpperCase()}_CLIENT_ID`];
    const clientSecret = env[`${provider.toUpperCase()}_CLIENT_SECRET`];
    if (clientId && clientSecret) result[provider] = { clientId, clientSecret };
  }
  return result;
}

const endpoints = (github: boolean) => ({
  authorize: github ? 'https://github.com/login/oauth/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth',
  token: github ? 'https://github.com/login/oauth/access_token' : 'https://oauth2.googleapis.com/token',
});

export function createOAuthProvider(provider: SupportedProvider, id: string, secret: string, request: typeof fetch = fetch): OAuthProvider {
  const github = provider === 'github';
  const urls = endpoints(github);
  const json = async (url: string, init: RequestInit) => {
    const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new ApiError(400, 'OAUTH_PROVIDER_ERROR');
    return await response.json() as Record<string, unknown>;
  };
  return {
    authorizationUrl(state, challenge, redirectUri) {
      const url = new URL(urls.authorize);
      url.search = new URLSearchParams({ client_id: id, redirect_uri: redirectUri, response_type: 'code', state,
        scope: github ? 'read:user user:email' : 'openid email profile',
        code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      return url.href;
    },
    async exchange(code, verifier, redirectUri) {
      try {
        const tokens = await json(urls.token, {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: id, client_secret: secret,
            code, code_verifier: verifier, redirect_uri: redirectUri }),
        });
        if (typeof tokens.access_token !== 'string') throw new ApiError(400, 'OAUTH_PROVIDER_ERROR');
        const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'User-Agent': 'dropit' };
        const profile = await json(github ? 'https://api.github.com/user' : 'https://openidconnect.googleapis.com/v1/userinfo', { headers });
        let email = '';
        if (github) {
          const response = await request('https://api.github.com/user/emails', { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new ApiError(400, 'OAUTH_PROVIDER_ERROR');
          const emails = await response.json() as { email: string; primary: boolean; verified: boolean }[];
          email = emails.find(e => e.primary && e.verified)?.email ?? '';
        } else if (profile.email_verified === true && typeof profile.email === 'string') email = profile.email;
        const subject = github ? profile.id : profile.sub;
        if (!email || (typeof subject !== 'string' && typeof subject !== 'number')) throw new ApiError(403, 'VERIFIED_EMAIL_REQUIRED');
        return { provider, subject: String(subject), email: email.toLowerCase(), name: String(profile.name ?? profile.login ?? 'User').slice(0, 200) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, 'OAUTH_PROVIDER_ERROR');
      }
    },
  };
}

export type OAuthCheckCode = 'CREDENTIALS_OK' | 'INVALID_CLIENT' | 'REDIRECT_MISMATCH' | 'REDIRECT_NOT_ALLOWED' | 'PROVIDER_UNREACHABLE' | 'UNEXPECTED_RESPONSE';

/**
 * Checks client id + secret without a user: the token endpoint is called with a
 * deliberately invalid authorization code. A provider that accepts the client
 * answers "bad code" (GitHub bad_verification_code, Google invalid_grant); a
 * wrong id/secret answers incorrect_client_credentials / invalid_client. The
 * registered callback URL is only fully proven by a real sign-in or bind, which
 * the callback records as LOGIN_OK. Only fixed provider URLs are contacted.
 */
export async function checkOAuthCredentials(provider: SupportedProvider, id: string, secret: string, redirectUri: string,
  request: typeof fetch = fetch): Promise<{ ok: boolean; code: OAuthCheckCode }> {
  const github = provider === 'github';
  let response: Response;
  try {
    response = await request(endpoints(github).token, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'dropit' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: id, client_secret: secret,
        code: 'dropit-credential-check', code_verifier: 'dropit-credential-check-verifier-0000000000000', redirect_uri: redirectUri }),
    });
  } catch { return { ok: false, code: 'PROVIDER_UNREACHABLE' }; }
  // GitHub answers an unknown client_id with a bare 404 instead of an OAuth error.
  if (github && response.status === 404) return { ok: false, code: 'INVALID_CLIENT' };
  let error = '';
  try {
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.error === 'string') error = body.error;
  } catch { return { ok: false, code: 'UNEXPECTED_RESPONSE' }; }
  if (error === 'redirect_uri_mismatch') return { ok: false, code: 'REDIRECT_MISMATCH' };
  if (['incorrect_client_credentials', 'invalid_client', 'unauthorized_client'].includes(error)) return { ok: false, code: 'INVALID_CLIENT' };
  // Google refuses plain-http / bare-IP redirect URIs before looking at the client.
  if (!github && error === 'invalid_request') return { ok: false, code: 'REDIRECT_NOT_ALLOWED' };
  if (github ? error === 'bad_verification_code' : error === 'invalid_grant') return { ok: true, code: 'CREDENTIALS_OK' };
  return { ok: false, code: 'UNEXPECTED_RESPONSE' };
}

// Injectable only through createBackend(), never selected by an HTTP parameter or an env mock switch.
export function oauthProviders(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): Record<string, OAuthProvider> {
  const result: Record<string, OAuthProvider> = {};
  for (const [provider, app] of Object.entries(envOAuthApps(env)) as [SupportedProvider, { clientId: string; clientSecret: string }][]) {
    result[provider] = createOAuthProvider(provider, app.clientId, app.clientSecret, request);
  }
  return result;
}

import { ApiError, type Identity } from './domain.js';

export interface OAuthProvider {
  authorizationUrl(state: string, challenge: string, redirectUri: string): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<Identity>;
}

// Injectable only through createBackend(), never selected by an HTTP parameter or an env mock switch.
export function oauthProviders(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): Record<string, OAuthProvider> {
  const result: Record<string, OAuthProvider> = {};
  for (const provider of ['github', 'google'] as const) {
    const id = env[`${provider.toUpperCase()}_CLIENT_ID`];
    const secret = env[`${provider.toUpperCase()}_CLIENT_SECRET`];
    if (!id || !secret) continue;
    const github = provider === 'github';
    const json = async (url: string, init: RequestInit) => {
      const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new ApiError(400, 'OAUTH_PROVIDER_ERROR');
      return await response.json() as Record<string, unknown>;
    };
    result[provider] = {
      authorizationUrl(state, challenge, redirectUri) {
        const url = new URL(github ? 'https://github.com/login/oauth/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: id, redirect_uri: redirectUri, response_type: 'code', state,
          scope: github ? 'read:user user:email' : 'openid email profile',
          code_challenge: challenge, code_challenge_method: 'S256' }).toString();
        return url.href;
      },
      async exchange(code, verifier, redirectUri) {
        try {
          const tokens = await json(github ? 'https://github.com/login/oauth/access_token' : 'https://oauth2.googleapis.com/token', {
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
  return result;
}

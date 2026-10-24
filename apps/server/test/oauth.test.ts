import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oauthProviders } from '../src/oauth.js';
import { loadConfig } from '../src/config.js';
import { cleanFilename } from '../src/domain.js';

test('GitHub and Google adapters send PKCE on both legs and accept only provider-verified email', async () => {
  for (const provider of ['github', 'google']) {
    const calls: { url: string; init: RequestInit }[] = [];
    let verified = true;
    const mockFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      let data: unknown;
      if (url.endsWith('/token') || url.endsWith('/access_token')) data = { access_token: 'mock-token' };
      else if (url.endsWith('/user/emails')) data = [{ email: 'verified@example.com', primary: true, verified }];
      else if (url.endsWith('/user')) data = { id: 42, login: 'member', email: 'untrusted-profile@example.com' };
      else data = { sub: '42', email: 'verified@example.com', email_verified: verified, name: 'Member' };
      return Response.json(data);
    };
    const upper = provider.toUpperCase();
    const adapter = oauthProviders({ [`${upper}_CLIENT_ID`]: 'mock-id', [`${upper}_CLIENT_SECRET`]: 'mock-secret' }, mockFetch as typeof fetch)[provider];
    const authUrl = new URL(adapter.authorizationUrl('state', 'challenge', 'https://dropit.example/callback'));
    assert.equal(authUrl.searchParams.get('state'), 'state');
    assert.equal(authUrl.searchParams.get('code_challenge'), 'challenge');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authUrl.searchParams.has('client_secret'), false);
    const identity = await adapter.exchange('code', 'verifier', 'https://dropit.example/callback');
    assert.equal(identity.email, 'verified@example.com'); assert.equal(identity.subject, '42');
    const body = calls[0].init.body as URLSearchParams;
    assert.equal(body.get('code_verifier'), 'verifier');
    assert.equal(body.get('client_secret'), 'mock-secret');
    assert.equal(body.get('redirect_uri'), 'https://dropit.example/callback');
    assert.equal((calls[1].init.headers as Record<string, string>).Authorization, 'Bearer mock-token');
    assert.equal(calls[0].init.redirect, 'error');
    verified = false;
    await assert.rejects(adapter.exchange('code', 'verifier', 'https://dropit.example/callback'), /VERIFIED_EMAIL_REQUIRED/);
  }
});

test('OAuth configuration contains no enabled mock provider and provider failures expose no secret', async () => {
  assert.deepEqual(oauthProviders({}), {});
  const providers = oauthProviders({ GITHUB_CLIENT_ID: 'mock-id', GITHUB_CLIENT_SECRET: 'mock-secret' }, async () => Response.json({ error: 'mock-secret' }, { status: 401 }));
  await assert.rejects(providers.github.exchange('code', 'verifier', 'https://dropit.example/callback'), error => {
    assert(error instanceof Error); assert.equal(error.message, 'OAUTH_PROVIDER_ERROR'); return true;
  });
});

test('Configuration rejects unsafe origin, invalid limits and weak room policy', () => {
  for (const env of [
    { APP_ORIGIN: 'http://example.com', NODE_ENV: 'production' },
    { APP_ORIGIN: 'https://example.com/path' }, { MAX_FILE_BYTES: '-1' },
    { ROOM_RETENTION_HOURS: '25' }, { ROOM_MAX_FILE_BYTES: String(25 * 1024 ** 2) },
    { RATE_AUTH: '240' },
  ]) assert.throws(() => loadConfig(env));
  assert.deepEqual(loadConfig({}).adminEmails, []);
  assert.deepEqual(loadConfig({ ADMIN_EMAILS: '' }).adminEmails, []);
  assert.deepEqual(loadConfig({ ADMIN_EMAILS: 'ltherowlh@gmail.com' }).adminEmails, ['ltherowlh@gmail.com']);
  assert.deepEqual(loadConfig({ ADMIN_EMAILS: 'other@example.com' }).adminEmails, ['other@example.com']);
  assert.equal(loadConfig({ ADMIN_EMAILS: ' Owner@Example.COM, ' }).adminEmails[0], 'owner@example.com');
});

test('Filenames remove traversal, control and bidi characters, including long names', () => {
  const name = cleanFilename('../..\\unsafe\r\n\u202E' + 'a'.repeat(300));
  assert(name.length <= 180); assert.doesNotMatch(name, /[/\\\r\n\u202E]/);
  assert.notEqual(cleanFilename('...'), '');
});

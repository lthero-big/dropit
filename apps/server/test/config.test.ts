import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const root = '/tmp/dropit-config'

describe('loadConfig', () => {
  it('reads OAuth credentials only from the environment', () => {
    const config = loadConfig(
      {
        NODE_ENV: 'test',
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: 'gh-secret',
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
        ADMIN_EMAILS: 'A@Example.com, b@example.com',
        TRUST_PROXY: '1',
      },
      { repoRoot: root },
    )

    expect(config.githubClientId).toBe('gh-id')
    expect(config.githubClientSecret).toBe('gh-secret')
    expect(config.googleClientId).toBe('g-id')
    expect(config.googleClientSecret).toBe('g-secret')
    expect(config.adminEmails).toEqual(['a@example.com', 'b@example.com'])
    expect(config.trustProxy).toBe(true)
    expect(config.sessionSecret).toBe('dev-only-change-me')
  })

  it('ignores TRUST_PROXY unless it is 1 or true', () => {
    const config = loadConfig({ TRUST_PROXY: '0', NODE_ENV: 'test' }, { repoRoot: root })
    expect(config.trustProxy).toBe(false)
  })

  it('refuses a placeholder session secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' }, { repoRoot: root })).toThrow(
      'SESSION_SECRET',
    )
    expect(() =>
      loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'change-me' }, { repoRoot: root }),
    ).toThrow('SESSION_SECRET')
  })

  it('accepts a unique production session secret', () => {
    const config = loadConfig(
      { NODE_ENV: 'production', SESSION_SECRET: 'unique-secret-value' },
      { repoRoot: root },
    )
    expect(config.sessionSecret).toBe('unique-secret-value')
    expect(config.databasePath.endsWith(`${'data'}/dropit.sqlite`)).toBe(true)
  })
})

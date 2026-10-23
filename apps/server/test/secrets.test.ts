import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()

const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter((file) => file.length > 0)

const secretKeys = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
]

const placeholders = new Set(['', 'change-me', 'changeme', 'replace-me'])

describe('repository secrets', () => {
  it('tracks no env file other than .env.example', () => {
    const envFiles = tracked.filter((file) => {
      const base = path.basename(file)
      return base === '.env' || base.startsWith('.env.')
    })
    assert.deepEqual(envFiles, ['.env.example'])
  })

  it('keeps example secrets empty or obvious placeholders', () => {
    const example = readFileSync(path.join(repoRoot, '.env.example'), 'utf8')
    for (const key of secretKeys) {
      const match = example.match(new RegExp(`^${key}=(.*)$`, 'm'))
      assert(match, key)
      assert(placeholders.has(match?.[1] ?? 'missing'), key)
    }
  })

  it('does not contain private keys or live token prefixes', () => {
    const privateKey = `BEGIN ${'PRIVATE'} KEY`
    const tokenPrefix = `gh${'p_'}`
    const failures: string[] = []
    for (const file of tracked) {
      if (file === 'pnpm-lock.yaml') continue
      if (!existsSync(path.join(repoRoot, file))) continue // unstaged deletion during local review
      const text = readFileSync(path.join(repoRoot, file), 'utf8')
      if (text.includes(privateKey) || text.includes(tokenPrefix)) {
        failures.push(file)
      }
    }
    assert.deepEqual(failures, [])
  })
})

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtureDir = mkdtempSync(join(tmpdir(), 'dropit-web-smoke-'))
process.on('exit', () => rmSync(fixtureDir, { recursive: true, force: true }))
const staticDir = join(fixtureDir, 'static')
mkdirSync(staticDir)

// Production mode suppresses the server entry point's loading of the repository .env.
process.env = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '18787',
  APP_ORIGIN: 'http://127.0.0.1:15173',
  DATA_DIR: join(fixtureDir, 'data'),
  STATIC_DIR: staticDir,
  ADMIN_EMAIL: process.env.DROPIT_SMOKE_EMAIL,
  ADMIN_PASSWORD: process.env.DROPIT_SMOKE_PASSWORD,
}

await import('../../server/dist/index.js')

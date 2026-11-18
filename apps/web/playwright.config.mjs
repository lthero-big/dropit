import { randomUUID } from 'node:crypto'
import { defineConfig } from '@playwright/test'

const webOrigin = 'http://127.0.0.1:15173'
const externalOrigin = process.env.DROPIT_DEV_BACKEND_ORIGIN?.trim()
const backendOrigin = externalOrigin || 'http://127.0.0.1:18787'

if (externalOrigin) {
  if (!process.env.DROPIT_SMOKE_EMAIL || !process.env.DROPIT_SMOKE_PASSWORD) {
    throw new Error('Set DROPIT_SMOKE_EMAIL and DROPIT_SMOKE_PASSWORD for the isolated account on the selected backend.')
  }
} else {
  process.env.DROPIT_SMOKE_EMAIL = 'web-smoke@example.test'
  // Playwright loads the config again in the worker, which inherits this password.
  process.env.DROPIT_SMOKE_PASSWORD ||= randomUUID()
}

const shutdown = { signal: 'SIGTERM', timeout: 5000 }

export default defineConfig({
  testDir: './smoke',
  outputDir: './node_modules/.cache/dropit-smoke',
  workers: 1,
  timeout: 45_000,
  use: { baseURL: webOrigin, viewport: { width: 1440, height: 900 } },
  webServer: [
    ...(externalOrigin ? [] : [{
      command: 'node smoke/start-ts.mjs',
      url: backendOrigin + '/healthz',
      reuseExistingServer: false,
      gracefulShutdown: shutdown,
    }]),
    {
      command: 'pnpm dev --host 127.0.0.1 --port 15173 --strictPort',
      url: webOrigin,
      env: { DROPIT_DEV_BACKEND_ORIGIN: backendOrigin },
      reuseExistingServer: false,
      gracefulShutdown: shutdown,
    },
  ],
})

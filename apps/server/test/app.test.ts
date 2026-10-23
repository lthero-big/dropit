import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { SCAFFOLD_TOPIC, createApp } from '../src/app.js'
import { MemoryBroadcaster } from '../src/broadcast/memory.js'
import { SqliteDatabase } from '../src/db/sqlite.js'
import { startHttpServer } from '../src/http.js'
import { MemoryObjectStorage } from '../src/storage/memory.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function testApp(staticDir: string | null = null) {
  const db = new SqliteDatabase(':memory:')
  const broadcaster = new MemoryBroadcaster()
  const app = createApp({
    db,
    storage: new MemoryObjectStorage(),
    broadcaster,
    staticDir,
  })
  return { app, db, broadcaster }
}

describe('createApp', () => {
  it('answers /healthz', async () => {
    const { app, db } = testApp()
    const response = await app.request('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    db.close()
  })

  it('serves the frontend build and falls back to index.html', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dropit-static-'))
    dirs.push(dir)
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>dropit</title>')
    await mkdir(path.join(dir, 'assets'))
    await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log(1)')

    const { app, db } = testApp(dir)
    const page = await app.request('/')
    expect(await page.text()).toContain('<title>dropit</title>')
    const asset = await app.request('/assets/app.js')
    expect(await asset.text()).toBe('console.log(1)')
    const route = await app.request('/invite/example')
    expect(await route.text()).toContain('<title>dropit</title>')
    const health = await app.request('/healthz')
    expect(health.headers.get('content-type')).toContain('application/json')
    db.close()
  })

  it('pushes scaffold broadcasts to a connected socket', async () => {
    const { app, db, broadcaster } = testApp()
    const server = startHttpServer(app, { port: 0, hostname: '127.0.0.1' })
    try {
      await waitForListening(server)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing port')

      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`)
      const ready = await nextMessage(socket)
      expect(JSON.parse(ready)).toEqual({ type: 'ready' })

      const incoming = nextMessage(socket)
      broadcaster.publish(SCAFFOLD_TOPIC, { hello: 'dropit' })
      expect(JSON.parse(await incoming)).toEqual({ hello: 'dropit' })
      socket.close()
    } finally {
      await closeServer(server)
      db.close()
    }
  })
})

function waitForListening(server: { listening: boolean; once: (event: 'listening', cb: () => void) => void }): Promise<void> {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    server.once('listening', () => resolve())
  })
}

function closeServer(server: { close: (cb: () => void) => void }): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()))
    socket.once('error', reject)
  })
}

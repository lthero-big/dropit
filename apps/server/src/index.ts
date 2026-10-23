import { existsSync } from 'node:fs'
import path from 'node:path'
import { MemoryBroadcaster } from './broadcast/memory.js'
import { loadConfig, repoRootFrom } from './config.js'
import { SqliteDatabase } from './db/sqlite.js'
import { createApp } from './app.js'
import { startHttpServer } from './http.js'
import { DiskObjectStorage } from './storage/disk.js'

const repoRoot = repoRootFrom(import.meta.url)
loadLocalEnv(path.join(repoRoot, '.env'))

const config = loadConfig(process.env, { repoRoot })
if (config.staticDir && !existsSync(config.staticDir)) {
  throw new Error(`STATIC_DIR does not exist: ${config.staticDir}`)
}

const db = new SqliteDatabase(config.databasePath)
const storage = new DiskObjectStorage(path.join(config.dataDir, 'objects'))
const broadcaster = new MemoryBroadcaster()
const app = createApp({
  db,
  storage,
  broadcaster,
  staticDir: config.staticDir,
})

const server = startHttpServer(app, { port: config.port, hostname: config.host })
console.log(`dropit listening on http://${config.host}:${config.port}`)

function shutdown(): void {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

function loadLocalEnv(file: string): void {
  if (process.env.NODE_ENV === 'production') return
  if (!existsSync(file)) return
  process.loadEnvFile(file)
}

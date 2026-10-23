import { upgradeWebSocket } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import type { Broadcaster } from './broadcast/types.js'
import type { Database } from './db/types.js'
import type { ObjectStorage } from './storage/types.js'

/** Scaffold-only fanout. Backend auth replaces this route. */
export const SCAFFOLD_TOPIC = 'scaffold'

export interface AppDeps {
  db: Database
  storage: ObjectStorage
  broadcaster: Broadcaster
  staticDir: string | null
}

type AppVariables = {
  db: Database
  storage: ObjectStorage
  broadcaster: Broadcaster
}

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()

  app.use('*', async (c, next) => {
    c.set('db', deps.db)
    c.set('storage', deps.storage)
    c.set('broadcaster', deps.broadcaster)
    await next()
  })

  app.get('/healthz', (c) => {
    c.get('db').ping()
    return c.json({ ok: true })
  })

  app.get(
    '/ws',
    upgradeWebSocket(() => {
      let unsubscribe = () => {}
      return {
        onOpen(_event, ws) {
          unsubscribe = deps.broadcaster.subscribe(SCAFFOLD_TOPIC, (payload) => {
            ws.send(JSON.stringify(payload))
          })
          ws.send(JSON.stringify({ type: 'ready' }))
        },
        onClose() {
          unsubscribe()
        },
      }
    }),
  )

  if (deps.staticDir) {
    const root = deps.staticDir
    app.use('*', serveStatic({ root }))
    app.get('*', serveStatic({ path: `${root}/index.html` }))
  }

  return app
}

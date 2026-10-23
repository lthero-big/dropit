import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import type { Env, Hono } from 'hono'
import { WebSocketServer } from 'ws'

export function startHttpServer<E extends Env>(
  app: Hono<E>,
  options: { port: number; hostname: string },
): ServerType {
  const wss = new WebSocketServer({ noServer: true })
  const server = serve({
    fetch: app.fetch,
    port: options.port,
    hostname: options.hostname,
    websocket: { server: wss },
  })
  server.on('close', () => {
    wss.close()
  })
  return server
}

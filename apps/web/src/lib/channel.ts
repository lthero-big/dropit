import { useEffect, useState } from 'react'
import type { ConnectionStatus, Item, ServerMessage } from './types.ts'

export const channelClock = {
  delay(attempt: number) {
    const base = Math.min(30_000, 500 * 2 ** attempt)
    return base + Math.floor(Math.random() * Math.min(250, base))
  },
}

function upsert(items: Item[], item: Item): Item[] {
  const next = items.filter((entry) => entry.id !== item.id)
  next.push(item)
  next.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  return next
}

export function useChannel(base: string | null) {
  const [items, setItems] = useState<Item[]>([])
  const [status, setStatus] = useState<ConnectionStatus>(base ? 'connecting' : 'idle')
  const [offset, setOffset] = useState(0)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [authLost, setAuthLost] = useState(0)

  useEffect(() => {
    if (!base) {
      setItems([])
      setStatus('idle')
      setExpiresAt(null)
      return
    }

    let stopped = false
    let attempt = 0
    let socket: WebSocket | null = null
    let timer = 0
    setItems([])
    setStatus('connecting')

    const connect = () => {
      if (stopped) return
      const url = new URL(`${base}/ws`, window.location.href)
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url)
      socket = ws
      ws.onmessage = (event) => {
        let message: ServerMessage
        try {
          message = JSON.parse(String(event.data)) as ServerMessage
        } catch {
          return
        }
        if (message.type === 'snapshot') {
          setItems(message.items)
          setOffset(message.serverTime - Date.now())
          setExpiresAt(message.expiresAt)
          setStatus('live')
          attempt = 0
          return
        }
        if (message.type === 'item.created') {
          setItems((current) => upsert(current, message.item))
          return
        }
        if (message.type === 'item.deleted') {
          setItems((current) => current.filter((item) => item.id !== message.id))
        }
      }
      ws.onclose = (event) => {
        if (stopped || socket !== ws) return
        if (event.code === 1008) {
          setStatus('stopped')
          setAuthLost((count) => count + 1)
          return
        }
        setStatus('reconnecting')
        timer = window.setTimeout(connect, channelClock.delay(attempt))
        attempt += 1
      }
    }

    connect()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      socket?.close()
    }
  }, [base])

  return {
    items,
    status,
    offset,
    expiresAt,
    authLost,
    upsert(item: Item) {
      setItems((current) => upsert(current, item))
    },
    remove(id: string) {
      setItems((current) => current.filter((item) => item.id !== id))
    },
  }
}

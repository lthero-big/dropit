import { useEffect, useState } from 'react'
import { deviceQuery } from './device.ts'
import type { ConnectionStatus, Item, ItemDevice, ServerMessage } from './types.ts'

export const channelClock = {
  delay(attempt: number) {
    const base = Math.min(30_000, 500 * 2 ** attempt)
    return base + Math.floor(Math.random() * Math.min(250, base))
  },
}

export function compareItems(a: Item, b: Item): number {
  return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

function upsert(items: Item[], item: Item): Item[] {
  const next = items.filter((entry) => entry.id !== item.id)
  next.push(item)
  next.sort(compareItems)
  return next
}

export function useChannel(base: string | null) {
  const [items, setItems] = useState<Item[]>([])
  const [status, setStatus] = useState<ConnectionStatus>(base ? 'connecting' : 'idle')
  const [offset, setOffset] = useState(0)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [authLost, setAuthLost] = useState(0)
  const [devices, setDevices] = useState(0)
  const [peers, setPeers] = useState<ItemDevice[] | null>(null)
  const [others, setOthers] = useState(0)
  const [groups, setGroups] = useState<string[]>([])

  useEffect(() => {
    if (!base) {
      setItems([])
      setDevices(0)
      setPeers(null)
      setOthers(0)
      setGroups([])
      setStatus('idle')
      setExpiresAt(null)
      return
    }

    let stopped = false
    let attempt = 0
    let socket: WebSocket | null = null
    let timer = 0
      setItems([])
      setDevices(0)
      setPeers(null)
      setOthers(0)
      setGroups([])
      setStatus('connecting')

    const connect = () => {
      if (stopped) return
      const url = new URL(`${base}/ws?${deviceQuery()}`, window.location.href)
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
          setItems([...message.items].sort(compareItems))
          if (Array.isArray(message.groups)) setGroups(message.groups.filter((name) => typeof name === 'string'))
          setOffset(message.serverTime - Date.now())
          setExpiresAt(message.expiresAt)
          setStatus('live')
          attempt = 0
          return
        }
        if (message.type === 'item.created' || message.type === 'item.updated') {
          setItems((current) => upsert(current, message.item))
          return
        }
        if (message.type === 'item.deleted') {
          setItems((current) => current.filter((item) => item.id !== message.id))
          return
        }
        if (message.type === 'groups' && Array.isArray(message.groups)) {
          setGroups(message.groups.filter((name) => typeof name === 'string'))
          return
        }
        if (message.type === 'presence' && Number.isInteger(message.devices) && message.devices >= 0) {
          setDevices(message.devices)
          setPeers(Array.isArray(message.peers) ? message.peers : null)
          setOthers(Number.isInteger(message.others) && (message.others ?? 0) > 0 ? (message.others as number) : 0)
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
    devices,
    /** Named peers when the server reports them; null on older servers. */
    peers,
    /** Live connections that named no device (CLI / API / old clients). */
    others,
    groups,
    setGroups,
    upsert(item: Item) {
      setItems((current) => upsert(current, item))
    },
    remove(id: string) {
      setItems((current) => current.filter((item) => item.id !== id))
    },
  }
}

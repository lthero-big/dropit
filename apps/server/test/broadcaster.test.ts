import { describe, expect, it } from 'vitest'
import { MemoryBroadcaster } from '../src/broadcast/memory.js'

describe('MemoryBroadcaster', () => {
  it('delivers to current subscribers only', () => {
    const bus = new MemoryBroadcaster()
    const seen: unknown[] = []
    const unsubscribe = bus.subscribe('room', (payload) => {
      seen.push(payload)
    })

    bus.publish('room', { n: 1 })
    unsubscribe()
    bus.publish('room', { n: 2 })
    bus.publish('other', { n: 3 })

    expect(seen).toEqual([{ n: 1 }])
  })

  it('keeps publishing when one listener throws', () => {
    const bus = new MemoryBroadcaster()
    const seen: string[] = []
    bus.subscribe('room', () => {
      throw new Error('boom')
    })
    bus.subscribe('room', () => {
      seen.push('ok')
    })

    bus.publish('room', null)
    expect(seen).toEqual(['ok'])
  })
})

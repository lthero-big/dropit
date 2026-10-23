import type { BroadcastListener, Broadcaster } from './types.js'

export class MemoryBroadcaster implements Broadcaster {
  readonly #listeners = new Map<string, Set<BroadcastListener>>()

  publish(topic: string, payload: unknown): void {
    const listeners = this.#listeners.get(topic)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch {
        // One subscriber must not block the rest.
      }
    }
  }

  subscribe(topic: string, listener: BroadcastListener): () => void {
    let listeners = this.#listeners.get(topic)
    if (!listeners) {
      listeners = new Set()
      this.#listeners.set(topic, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(topic)
    }
  }
}

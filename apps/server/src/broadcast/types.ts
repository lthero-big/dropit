export type BroadcastListener = (payload: unknown) => void

/**
 * Pub/sub port. Route code depends on this interface.
 * The in-memory adapter is the single-process implementation.
 */
export interface Broadcaster {
  publish(topic: string, payload: unknown): void
  subscribe(topic: string, listener: BroadcastListener): () => void
}

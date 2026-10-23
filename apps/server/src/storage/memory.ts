import { assertObjectId } from './id.js'
import type { ObjectStorage, StoredObject } from './types.js'

export class MemoryObjectStorage implements ObjectStorage {
  readonly #objects = new Map<string, StoredObject>()

  async put(id: string, data: Uint8Array, contentType: string): Promise<void> {
    assertObjectId(id)
    this.#objects.set(id, { data: data.slice(), contentType })
  }

  async get(id: string): Promise<StoredObject | null> {
    assertObjectId(id)
    const stored = this.#objects.get(id)
    if (!stored) return null
    return { data: stored.data.slice(), contentType: stored.contentType }
  }

  async delete(id: string): Promise<void> {
    assertObjectId(id)
    this.#objects.delete(id)
  }
}

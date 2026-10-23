import { mkdirSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertObjectId } from './id.js'
import type { ObjectStorage, StoredObject } from './types.js'

/**
 * Stores each object as `<root>/<id>` plus a sibling `<id>.type` sidecar.
 * The id is not a user filename, and it cannot contain path separators.
 */
export class DiskObjectStorage implements ObjectStorage {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
    mkdirSync(root, { recursive: true })
  }

  async put(id: string, data: Uint8Array, contentType: string): Promise<void> {
    const file = this.#file(id)
    await writeFile(file, data)
    await writeFile(`${file}.type`, contentType)
  }

  async get(id: string): Promise<StoredObject | null> {
    const file = this.#file(id)
    try {
      const [data, contentType] = await Promise.all([
        readFile(file),
        readFile(`${file}.type`, 'utf8'),
      ])
      return { data, contentType }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async delete(id: string): Promise<void> {
    const file = this.#file(id)
    await rm(file, { force: true })
    await rm(`${file}.type`, { force: true })
  }

  #file(id: string): string {
    assertObjectId(id)
    const root = path.resolve(this.#root)
    const file = path.resolve(root, id)
    if (file !== path.join(root, id)) {
      throw new Error('Invalid object id')
    }
    return file
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

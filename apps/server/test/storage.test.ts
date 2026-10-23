import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiskObjectStorage } from '../src/storage/disk.js'
import { MemoryObjectStorage } from '../src/storage/memory.js'
import type { ObjectStorage } from '../src/storage/types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe.each([
  ['memory', async () => new MemoryObjectStorage()],
  [
    'disk',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'dropit-objects-'))
      roots.push(dir)
      return new DiskObjectStorage(dir)
    },
  ],
] as const)('%s object storage', (_name, create) => {
  it('stores, reads, and deletes bytes without using the caller filename', async () => {
    const storage: ObjectStorage = await create()
    const payload = new TextEncoder().encode('hello')
    await storage.put('obj_1', payload, 'text/plain')
    payload[0] = 0

    const stored = await storage.get('obj_1')
    expect(stored?.contentType).toBe('text/plain')
    expect(new TextDecoder().decode(stored?.data)).toBe('hello')

    await storage.delete('obj_1')
    expect(await storage.get('obj_1')).toBeNull()
  })

  it('rejects path traversal ids and does not create files', async () => {
    const storage = await create()
    await expect(storage.put('../outside', new Uint8Array([1]), 'text/plain')).rejects.toThrow(
      'Invalid object id',
    )
    await expect(storage.get('a/b')).rejects.toThrow('Invalid object id')
  })
})

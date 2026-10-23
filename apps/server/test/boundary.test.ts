import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new URL('../src/', import.meta.url))

const fsAllowed = new Set(['index.ts', 'storage/disk.ts', 'db/sqlite.ts'])
const driverAllowed = new Set(['db/sqlite.ts'])
const compositionOnly = new Set(['index.ts'])
const concreteImports = [
  './storage/disk.js',
  './storage/memory.js',
  './broadcast/memory.js',
  './db/sqlite.js',
]

describe('adapter boundary', () => {
  it('keeps filesystem and sqlite driver imports inside adapters', () => {
    const files = listTs(srcDir)
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const relative = path.relative(srcDir, file).split(path.sep).join('/')
      const source = readFileSync(file, 'utf8')
      if (!fsAllowed.has(relative)) {
        expect(source, relative).not.toMatch(/from ['"]node:fs(?:\/promises)?['"]/)
        expect(source, relative).not.toMatch(/from ['"]fs(?:\/promises)?['"]/)
      }
      if (!driverAllowed.has(relative)) {
        expect(source, relative).not.toMatch(/from ['"]better-sqlite3['"]/)
      }
      if (!compositionOnly.has(relative)) {
        for (const specifier of concreteImports) {
          expect(source, relative).not.toContain(`from '${specifier}'`)
        }
      }
    }
  })
})

function listTs(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listTs(full))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const srcDir = fileURLToPath(new URL('../src/', import.meta.url))

const fsAllowed = new Set(['index.ts', 'files.ts', 'repository.ts'])
const driverAllowed = new Set(['repository.ts'])
const compositionOnly = new Set(['index.ts', 'backend.ts'])
const concreteImports = [
  './files.js',
  './events.js',
  './repository.js',
]

describe('adapter boundary', () => {
  it('keeps filesystem and sqlite driver imports inside adapters', () => {
    const files = listTs(srcDir)
    assert(files.length > 0)

    for (const file of files) {
      const relative = path.relative(srcDir, file).split(path.sep).join('/')
      const source = readFileSync(file, 'utf8')
      if (!fsAllowed.has(relative)) {
        assert.doesNotMatch(source, /from ['"]node:fs(?:\/promises)?['"]/, relative)
        assert.doesNotMatch(source, /from ['"]fs(?:\/promises)?['"]/, relative)
      }
      if (!driverAllowed.has(relative)) {
        assert.doesNotMatch(source, /from ['"]better-sqlite3['"]/, relative)
      }
      if (!compositionOnly.has(relative)) {
        for (const specifier of concreteImports) {
          // Type-only port imports are expected; runtime adapter imports belong at composition roots.
          const runtimeImports = source.split('\n').filter(line => !line.startsWith('import type ')).join('\n')
          assert(!runtimeImports.includes(`from '${specifier}'`), relative)
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

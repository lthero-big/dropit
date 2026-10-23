import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteDatabase } from '../src/db/sqlite.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SqliteDatabase', () => {
  it('opens a file in WAL mode through the Database port', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dropit-db-'))
    dirs.push(dir)
    const db = new SqliteDatabase(path.join(dir, 'nested', 'dropit.sqlite'))
    db.exec('create table scaffold (id integer primary key)')
    expect(() => db.ping()).not.toThrow()
    db.close()
  })

  it('pings an in-memory database', () => {
    const db = new SqliteDatabase(':memory:')
    expect(() => db.ping()).not.toThrow()
    db.close()
  })
})

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import BetterSqlite from 'better-sqlite3'
import type { Database } from './types.js'

export class SqliteDatabase implements Database {
  readonly #db: BetterSqlite.Database

  constructor(filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(filename), { recursive: true })
    }
    this.#db = new BetterSqlite(filename)
    this.#db.pragma('journal_mode = WAL')
  }

  ping(): void {
    this.#db.prepare('select 1 as ok').get()
  }

  exec(sql: string): void {
    this.#db.exec(sql)
  }

  close(): void {
    this.#db.close()
  }
}

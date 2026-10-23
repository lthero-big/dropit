/**
 * SQLite port. Route code depends on this interface, not on better-sqlite3.
 * Repositories in the backend milestone should sit on top of this seam.
 */
export interface Database {
  ping(): void
  exec(sql: string): void
  close(): void
}

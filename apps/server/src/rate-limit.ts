import proxyaddr from 'proxy-addr';
import type { Config } from './config.js';

export class RateLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  constructor(private windowMs: number) {}
  // Active buckets retain counts and reset times; the new duration applies when they expire.
  setWindow(windowMs: number) { this.windowMs = windowMs; }
  /** Seconds until a key may try again when it has already used up `limit`, without counting this look. */
  blocked(key: string, limit: number, now: number): number | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now || bucket.count < limit) return undefined;
    return Math.max(1, Math.ceil((bucket.reset - now) / 1000));
  }
  consume(key: string, limit: number, now: number): number | undefined {
    for (const [key, bucket] of this.buckets) if (bucket.reset <= now) this.buckets.delete(key);
    let bucket = this.buckets.get(key);
    // Bound memory without evicting live limits when an attacker rotates keys.
    if (!bucket && this.buckets.size >= 10000) return Math.ceil(this.windowMs / 1000);
    if (!bucket) { bucket = { count: 0, reset: now + this.windowMs }; this.buckets.set(key, bucket); }
    if (++bucket.count > limit) return Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    return undefined;
  }
}

/**
 * RHEA-190: total wrong-PIN counter per room (not per IP). After `maxFailures` wrong PINs inside one
 * `lockMs` window the room refuses every PIN attempt (even the right one) until `lockMs` has passed since the
 * failure that tripped it; then the counter starts over. A right PIN, or the owner changing the room's
 * code/PIN, clears it. Kept in memory only (a restart clears it) and bounded in size.
 */
export class PinLockout {
  private rooms = new Map<string, { count: number; since: number; until: number }>();
  constructor(private maxFailures: number, private lockMs: number, private maxRooms = 10000) {}
  private stale(entry: { since: number; until: number }, now: number) {
    return entry.until ? entry.until <= now : entry.since + this.lockMs <= now;
  }
  /** Seconds until the room accepts PIN attempts again, or undefined when it is not locked. */
  locked(room: string, now: number): number | undefined {
    const entry = this.rooms.get(room);
    if (!entry) return undefined;
    if (entry.until > now) return Math.max(1, Math.ceil((entry.until - now) / 1000));
    if (this.stale(entry, now)) this.rooms.delete(room);
    return undefined;
  }
  /** Counts one wrong PIN; returns the lock length in seconds when this failure locked the room. */
  fail(room: string, now: number): number | undefined {
    for (const [key, entry] of this.rooms) if (this.stale(entry, now)) this.rooms.delete(key);
    let entry = this.rooms.get(room);
    if (!entry) {
      if (this.rooms.size >= this.maxRooms) this.rooms.delete(this.rooms.keys().next().value as string);
      entry = { count: 0, since: now, until: 0 };
      this.rooms.set(room, entry);
    }
    if (++entry.count >= this.maxFailures) { entry.until = now + this.lockMs; return Math.ceil(this.lockMs / 1000); }
    return undefined;
  }
  clear(room: string) { this.rooms.delete(room); }
}

export function clientIpResolver(config: Pick<Config, 'trustProxy'>) {
  const trust = proxyaddr.compile(config.trustProxy);
  return (remote: string, forwarded?: string) => {
    // proxy-addr walks the chain from the actual socket and stops at the first untrusted hop.
    return proxyaddr({ socket: { remoteAddress: remote }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} } as Parameters<typeof proxyaddr>[0], trust);
  };
}

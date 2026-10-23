import proxyaddr from 'proxy-addr';
import type { Config } from './config.js';

export class RateLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  constructor(private windowMs: number) {}
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

export function clientIpResolver(config: Pick<Config, 'trustProxy'>) {
  const trust = proxyaddr.compile(config.trustProxy);
  return (remote: string, forwarded?: string) => {
    // proxy-addr walks the chain from the actual socket and stops at the first untrusted hop.
    return proxyaddr({ socket: { remoteAddress: remote }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} } as Parameters<typeof proxyaddr>[0], trust);
  };
}

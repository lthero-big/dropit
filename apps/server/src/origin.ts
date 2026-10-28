import proxyaddr from 'proxy-addr';

/** app_settings key for the site address saved in 管理 → 站点地址. */
export const ORIGIN_SETTING = 'appOrigin';

/**
 * Normalises a site address ("scheme://host[:port]", an optional trailing "/" is allowed)
 * to URL.origin. Anything else returns null: other schemes, credentials, a path, query or fragment.
 */
export function parseOrigin(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > 300 || /[\s?#\\]/.test(raw) || !/^https?:\/\/[^/@]+\/?$/i.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || !url.hostname) return null;
  return url.origin;
}

export interface RequestFacts {
  /** Request URL as seen by the server (scheme reflects the socket: http unless the server itself speaks TLS). */
  url: string;
  /** Socket peer address. */
  remote: string;
  host?: string;
  forwardedProto?: string;
  forwardedHost?: string;
}

/**
 * The origin a request was addressed to, used when no site address is configured.
 * X-Forwarded-Proto / X-Forwarded-Host count only when the socket peer is a trusted proxy
 * (TRUST_PROXY, same rule as client IPs); otherwise the connection scheme and the Host header are used.
 */
export function requestOriginResolver(trustProxy: string[]) {
  const trust = proxyaddr.compile(trustProxy);
  const first = (value?: string) => value?.split(',')[0]?.trim() || undefined;
  return (facts: RequestFacts): string | null => {
    let connection: URL;
    try { connection = new URL(facts.url); } catch { return null; }
    let trusted = false;
    if (trustProxy.length) { try { trusted = trust(facts.remote, 0); } catch { trusted = false; } }
    const proto = trusted ? first(facts.forwardedProto)?.toLowerCase() : undefined;
    const scheme = proto === 'http' || proto === 'https' ? proto : connection.protocol.slice(0, -1);
    const host = (trusted ? first(facts.forwardedHost) : undefined) || facts.host || connection.host;
    return parseOrigin(`${scheme}://${host}`);
  };
}

/**
 * Fallback CSRF rule (no site address configured): the browser's Origin must equal the
 * request's own origin. One relaxation: https://<same host> is accepted when the connection
 * looks like plain http, i.e. a TLS reverse proxy that is not listed in TRUST_PROXY. Browsers
 * only send that Origin from pages of exactly that host, so a cross-site page still fails.
 */
export function sameOrigin(header: string, own: string): boolean {
  return header === own || (own.startsWith('http://') && header === `https://${own.slice('http://'.length)}`);
}

/**
 * RHEA-190 auth step 1: the site address (APP_ORIGIN). Effective value =
 * 管理 → 站点地址 > APP_ORIGIN env > the address the browser used (same-origin).
 */
export type OriginSource = 'admin' | 'env' | 'request'
export type SiteInfo = { origin: string | null; source: OriginSource; requestOrigin: string | null }
export type SiteSettings = SiteInfo & {
  adminOrigin: string | null
  envOrigin: string | null
  effectiveOrigin: string
  production: boolean
  secureCookies: boolean
  trustProxy: boolean
  updatedAt: number | null
  updatedBy: string | null
  callbacks: { provider: string; label: string; url: string }[]
}

export const sourceLabel: Record<OriginSource, string> = {
  admin: '管理页面设置',
  env: '环境变量 APP_ORIGIN',
  request: '未设置，自动使用浏览器访问的地址',
}

/** Mirrors the server rule: scheme + host [+ port], optional trailing "/", nothing else. */
export function normalizeOrigin(value: string): string | null {
  const raw = value.trim()
  if (!raw || raw.length > 300 || /[\s?#\\]/.test(raw) || !/^https?:\/\/[^/@]+\/?$/i.test(raw)) return null
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || !url.hostname) return null
    return url.origin
  } catch {
    return null
  }
}

const upgraded = (server: string, browser: string) => server.startsWith('http://') && browser === `https://${server.slice('http://'.length)}`

/**
 * Explains, before anything fails with 403, that this browser's address differs from the
 * site address and what to change. null when everything matches.
 */
export function originMismatch(site: SiteInfo, current: string): string | null {
  if (site.origin) {
    if (site.origin === current) return null
    const fix =
      site.source === 'admin'
        ? '管理 → 站点地址；如果用正确地址也进不了后台，在 .env 加 RESET_APP_ORIGIN=1 重启一次即可清除页面设置'
        : '.env 里的 APP_ORIGIN，改完重启容器'
    return `当前访问地址 ${current} 与 APP_ORIGIN（${site.origin}）不一致，登录和保存会被拒绝。请改用 ${site.origin} 访问；如果 ${current} 才是正确地址，请把 APP_ORIGIN 改为 ${current}（${fix}）。`
  }
  if (!site.requestOrigin || site.requestOrigin === current) return null
  if (upgraded(site.requestOrigin, current))
    return `你通过 https 访问，但服务器收到的是 http 请求（反向代理没有加入 TRUST_PROXY）。临时房间可以正常用，但 OAuth 回调地址会是 http。请把 APP_ORIGIN 设为 ${current}（.env，或登录后在 管理 → 站点地址 保存）。`
  return `服务器收到的地址是 ${site.requestOrigin}，与当前访问地址 ${current} 不一致（通常是反向代理改写了 Host）。请把 APP_ORIGIN 设为 ${current}，或让反向代理保留原始 Host 头。`
}

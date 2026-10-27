// RHEA-190 step 9 headless check: the 更多 capsule opens as ONE row on desktop and mobile.
//   ACCEPTANCE_PORT=8799 DATA_DIR=$(mktemp -d) npx tsx apps/server/test/rhea188-browser-server.ts &
//   ORIGIN=http://127.0.0.1:8799 SHOTS=/tmp node scripts/acceptance-rhea190-step9.mjs
import { createRequire } from 'node:module'
const require = createRequire(process.env.PLAYWRIGHT_FROM ? `${process.env.PLAYWRIGHT_FROM.replace(/\/$/, '')}/package.json` : '/usr/lib/node_modules/openclaw/package.json')
const { chromium } = require('playwright-core')
const origin = process.env.ORIGIN ?? 'http://127.0.0.1:8799'
const shots = process.env.SHOTS
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const results = []
const errors = []
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log(ok ? 'PASS' : 'FAIL', name, extra === undefined ? '' : JSON.stringify(extra)) }
const tag = Date.now().toString(36)
let seeded = false
for (const [label, opts] of [
  ['desktop', { viewport: { width: 1280, height: 860 } }],
  ['tablet', { viewport: { width: 768, height: 1024 } }],
  ['mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ['small', { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }],
]) {
  const ctx = await browser.newContext(opts)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${origin}/api/auth/github`)
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'), { timeout: 15000 })
  const api = (path, init = {}) => page.evaluate(async ([path, init]) => {
    const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, [path, init])
  const { body: { spaces } } = await api('/api/spaces')
  const base = `/api/spaces/${spaces[0].id}`
  const text = `更多菜单 ${tag}`
  if (!seeded) { await api(`${base}/items/text`, { method: 'POST', body: JSON.stringify({ text }) }); seeded = true }
  await page.goto(`${origin}/`)
  await page.getByText(text).first().waitFor({ timeout: 15000 })
  await page.waitForTimeout(600)
  const card = page.locator('[data-clip-card]', { hasText: text }).first()
  if (opts.hasTouch) { await card.getByText(text).tap(); await page.waitForTimeout(400) } else await card.hover()
  check(`${label}: card actions visible before 更多`, await card.locator('[data-card]').first().evaluate((c) => c.hasAttribute('data-open') || c.matches(':hover')))
  await card.getByRole('button', { name: '更多' }).click()
  await page.waitForTimeout(700)
  const pill = card.locator('[data-slot="expand-capsule"]')
  const info = await pill.evaluate((p) => {
    const items = [...p.querySelectorAll('[data-slot="expand-capsule-actions"] button, [data-slot="expand-capsule-actions"] a')]
    const tops = new Set(items.map((i) => Math.round(i.getBoundingClientRect().top)))
    const r = p.getBoundingClientRect()
    const cardBox = p.closest('[data-card]')?.getBoundingClientRect()
    const vis = items.every((i) => { const b = i.getBoundingClientRect(); return b.right <= r.right + 1 && b.left >= r.left - 1 && b.bottom <= r.bottom + 1 })
    return { layout: p.dataset.layout, count: items.length, rows: tops.size, w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), cardLeft: cardBox ? Math.round(cardBox.left) : null, allInside: vis, names: items.map((i) => i.getAttribute('aria-label')) }
  })
  check(`${label}: 更多 opens as one row`, info.layout === 'row' && info.rows === 1 && info.count >= 3 && info.allInside, info)
  check(`${label}: capsule stays inside the card`, info.cardLeft === null || info.left >= info.cardLeft, info)
  if (shots) await card.screenshot({ path: `${shots}/rhea190-step9-more-${label}.png` })
  await ctx.close()
}
check('no page errors', errors.length === 0, errors)
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

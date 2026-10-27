// RHEA-190 step 8 headless check: points 1, 2, 3, 4, 5, 6 + no JS errors.
// Run against the mock-OAuth server (apps/server/test/rhea188-browser-server.ts):
//   ACCEPTANCE_PORT=8798 DATA_DIR=$(mktemp -d) npx tsx apps/server/test/rhea188-browser-server.ts &
//   ORIGIN=http://127.0.0.1:8798 PLAYWRIGHT_FROM=/path/with/playwright-core CHROME=/usr/bin/google-chrome node scripts/acceptance-rhea190-step8.mjs
import { createRequire } from 'node:module'
const require = createRequire(process.env.PLAYWRIGHT_FROM ? `${process.env.PLAYWRIGHT_FROM.replace(/\/$/, '')}/package.json` : '/usr/lib/node_modules/openclaw/package.json')
const { chromium } = require('playwright-core')
const origin = process.env.ORIGIN ?? 'http://127.0.0.1:8798'
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const errors = []
const results = []
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log(ok ? 'PASS' : 'FAIL', name, extra === undefined ? '' : JSON.stringify(extra)) }
const watch = (page) => { page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket|Loading the font 'data:/.test(m.text())) errors.push('console: ' + m.text()) }) }
const tag = Date.now().toString(36)

// ---- 1. login copy
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const p = await ctx.newPage(); watch(p)
  await p.goto(`${origin}/login`)
  await p.getByRole('button', { name: '进入临时房间' }).waitFor({ timeout: 10000 })
  const body = await p.locator('body').innerText()
  check('1 login says 进入临时房间, never 创建临时房间', !body.includes('创建临时房间') && body.includes('进入临时房间'))
  await p.getByRole('button', { name: '进入临时房间' }).click()
  await p.waitForURL((u) => u.pathname.startsWith('/r/') || u.pathname.startsWith('/room'), { timeout: 15000 }).catch(() => {})
  check('1 进入临时房间 still opens a room', /\/r\/|room/.test(p.url()), p.url())
  await ctx.close()
}

// ---- desktop board
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
const page = await ctx.newPage(); watch(page)
await page.goto(`${origin}/api/auth/github`)
await page.waitForURL((u) => !u.pathname.startsWith('/api/'), { timeout: 15000 })
const api = (path, init = {}) => page.evaluate(async ([path, init]) => {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } })
  return { status: r.status, body: await r.json().catch(() => null) }
}, [path, init])
const { body: { spaces } } = await api('/api/spaces')
const base = `/api/spaces/${spaces[0].id}`
for (const n of ['工作', '个人', '设计']) await api(`${base}/groups`, { method: 'POST', body: JSON.stringify({ name: n }) })
const dragText = `来回拖动 ${tag}`
const tagText = `带标签 ${tag}`
const shareText = `分享测试 ${tag}`
const tagged = await api(`${base}/items/text`, { method: 'POST', body: JSON.stringify({ text: tagText }) })
const tagRes = await api(`${base}/items/${tagged.body.item.id}/labels`, { method: 'PATCH', body: JSON.stringify({ tags: [`秘密标签${tag}`] }) })
await api(`${base}/items/text`, { method: 'POST', body: JSON.stringify({ text: shareText }) })
const dragged = await api(`${base}/items/text`, { method: 'POST', body: JSON.stringify({ text: dragText }) })
await page.goto(`${origin}/`)
await page.getByText(dragText).waitFor()
await page.waitForTimeout(800)
check('2 desktop mouse board uses pin-drag', (await page.locator('[data-gesture]').first().getAttribute('data-gesture')) === 'pin-drag')

// ---- 4. tags gone from UI, data kept
{
  const body = await page.locator('body').innerText()
  check('4 tag data kept in DB (API)', Array.isArray(tagRes.body?.item?.tags) && tagRes.body.item.tags.includes(`秘密标签${tag}`))
  check('4 no tag chip text on the board', !body.includes(`秘密标签${tag}`))
  const card = page.locator('[data-clip-card]', { hasText: tagText })
  await card.getByRole('button', { name: '更多' }).click()
  await page.waitForTimeout(300)
  check('4 更多 has no 标签 entry', (await card.getByRole('button', { name: '标签' }).count()) === 0)
  check('4 no tag filter / clear-tag chip', (await page.getByRole('button', { name: /清除标签|#秘密/ }).count()) === 0)
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 5)
}

// ---- 5. share in 更多, popover, row height unchanged
{
  const card = page.locator('[data-clip-card]', { hasText: shareText })
  const li = card.locator('xpath=ancestor-or-self::li[1]')
  check('5 分享 is not a top-level card button', (await card.getByRole('button', { name: '分享' }).filter({ visible: true }).count()) === 0)
  const before = await li.boundingBox()
  await card.getByRole('button', { name: '更多' }).click()
  await page.waitForTimeout(350)
  const share = card.getByRole('button', { name: '分享' })
  check('5 分享 sits inside 更多', (await share.count()) === 1)
  await share.click()
  const dialog = page.getByRole('dialog', { name: '分享链接' })
  await dialog.waitFor({ timeout: 5000 })
  await page.waitForTimeout(400)
  const after = await li.boundingBox()
  const inLi = await dialog.evaluate((d) => !!d.closest('li'))
  check('5 share opens as a popover (not inside the row)', !inLi)
  check('5 opening share keeps the row height', Math.abs(after.height - before.height) < 1, { before: before.height, after: after.height })
  await dialog.getByText(/还没有分享链接|分享链接/).first().waitFor({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('5 Escape closes the share popover', (await dialog.count()) === 0)
}

// ---- 6. PC retract: no hold button, tap → confirm
{
  check('6 desktop has no press-and-hold 撤回', (await page.locator('[data-gesture] .dd-hold').count()) === 0)
  const card = page.locator('[data-clip-card]', { hasText: shareText })
  await card.hover()
  await card.getByRole('button', { name: '撤回' }).click()
  const confirm = card.getByRole('button', { name: '确认撤回' })
  check('6 tap 撤回 asks 确认撤回', (await confirm.count()) === 1)
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 5)
  await page.waitForTimeout(300)
}

// ---- 3. drag back and forth between groups
{
  const card = page.locator('[data-clip-card]', { hasText: dragText })
  await card.scrollIntoViewIfNeeded()
  const cb = await card.boundingBox()
  const g1 = await page.locator('[data-group-chip="工作"]').boundingBox()
  const g2 = await page.locator('[data-group-chip="个人"]').boundingBox()
  const layout = () => page.evaluate(() => ['工作', '个人', '设计'].map((k) => { const el = document.querySelector(`[data-group-chip="${k}"]`); return [el.offsetLeft, el.offsetWidth] }))
  const rest = await layout()
  const sx = cb.x + cb.width / 2, sy = cb.y + cb.height / 2
  await page.mouse.move(sx, sy); await page.mouse.down()
  const ty = g1.y + g1.height / 2
  const xa = g1.x + g1.width / 2, xb = g2.x + g2.width / 2
  for (let i = 1; i <= 15; i++) { await page.mouse.move(sx + (xa - sx) * i / 15, sy + (ty - sy) * i / 15); await page.waitForTimeout(16) }
  const samples = []
  const sample = (px, py) => page.evaluate(([px, py]) => {
    const ghost = document.querySelector('[data-drag-ghost]')
    const r = ghost?.getBoundingClientRect()
    const chips = ['工作', '个人', '设计'].map((k) => { const el = document.querySelector(`[data-group-chip="${k}"]`); return [el.offsetLeft, el.offsetWidth] })
    return { px, py, gx: r ? Math.round(r.left - px) : null, gy: r ? Math.round(r.top - py) : null, hot: document.querySelector('[data-drop-hot]')?.getAttribute('data-group-chip') ?? null, chips }
  }, [px, py])
  for (let rep = 0; rep < 20; rep++) {
    for (const [from, to] of [[xa, xb], [xb, xa]]) {
      for (let i = 1; i <= 8; i++) {
        const x = from + (to - from) * i / 8
        await page.mouse.move(x, ty); await page.waitForTimeout(16)
        if (i === 4) samples.push(await sample(x, ty))
      }
      await page.waitForTimeout(220)
      samples.push(await sample(to, ty))
    }
  }
  const settled = samples.filter((_, i) => i % 2 === 1)
  const withGhost = samples.filter((s) => s.gx !== null)
  const offsets = new Set(withGhost.map((s) => `${s.gx},${s.gy}`))
  check('3 ghost shown over a group every time', settled.every((s) => s.gx !== null), settled.slice(0, 3))
  check('3 ghost stays at pointer + fixed offset (40 trips)', withGhost.every((s) => Math.abs(s.gx - 14) <= 2 && Math.abs(s.gy - 18) <= 2), [...offsets])
  check('3 hot chip follows pointer each pass', settled.every((s, i) => s.hot === (i % 2 === 0 ? '个人' : '工作')), settled.map((s) => s.hot).join(''))
  const sizes = new Set(samples.map((s) => JSON.stringify(s.chips)))
  const restW = JSON.stringify(rest.map((c) => c[1]))
  check('3 group chip layout never changes while hovering (40 trips)', sizes.size === 1 && JSON.stringify(JSON.parse([...sizes][0]).map((c) => c[1])) === restW, { rest, seen: [...sizes] })
  // drop on 个人
  for (let i = 1; i <= 8; i++) { await page.mouse.move(xa + (xb - xa) * i / 8, ty); await page.waitForTimeout(16) }
  await page.waitForTimeout(200)
  await page.mouse.up()
  await page.waitForTimeout(800)
  const items = await api(`${base}/items`)
  const list = items.body?.items ?? items.body
  const it = Array.isArray(list) ? list.find((x) => x.id === dragged.body.item.id) : null
  check('3 drop puts the clip in 个人', it?.group === '个人', it?.group)
  check('3 ghost removed after drop', (await page.locator('[data-drag-ghost]').count()) === 0)
}
await ctx.close()

// ---- 2. touch devices: swipe, no group drag
{
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const p = await m.newPage(); watch(p)
  await p.goto(`${origin}/api/auth/github`)
  await p.waitForURL((u) => !u.pathname.startsWith('/api/'), { timeout: 15000 })
  await p.goto(`${origin}/`)
  await p.getByText(dragText).waitFor()
  check('2 touch device uses swipe', (await p.locator('[data-gesture]').first().getAttribute('data-gesture')) === 'swipe')
  check('2 mobile keeps press-and-hold 撤回', (await p.locator('.dd-hold').count()) > 0)
  // a touch drag over a group chip never shows a ghost / drop target
  const card = p.locator('[data-clip-card]', { hasText: tagText })
  const cb = await card.boundingBox()
  const chip = await p.locator('[data-group-chip="工作"]').boundingBox().catch(() => null)
  const cdp = await m.newCDPSession(p)
  const pt = (x, y) => [{ x, y, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(cb.x + 40, cb.y + cb.height / 2) })
  const ty = chip ? chip.y + chip.height / 2 : 40
  let ghostSeen = false
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(cb.x + 40, cb.y + cb.height / 2 + (ty - cb.y - cb.height / 2) * i / 12) })
    await p.waitForTimeout(20)
    if (await p.locator('[data-drag-ghost], [data-drop-hot]').count()) ghostSeen = true
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  check('2 touch drag never targets a group', !ghostSeen)
  // swipe still works: horizontal swipe moves the card (same code path as before)
  await p.waitForTimeout(600)
  const sc = p.locator('[data-clip-card]', { hasText: shareText })
  await sc.scrollIntoViewIfNeeded()
  const sb = await sc.boundingBox()
  const y0 = sb.y + sb.height / 2, x0 = sb.x + sb.width - 40
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) })
  for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 - i * 8, y0) }); await p.waitForTimeout(30) }
  const moved = await sc.evaluate((el) => { const li = el.closest('li') ?? el; return [li, ...li.querySelectorAll('*')].map((n) => getComputedStyle(n).transform).find((t) => /matrix\(1, 0, 0, 1, -?[1-9]/.test(t)) ?? 'none' })
  check('2 horizontal swipe still moves the card', moved !== 'none', moved)
  await m.close()
}

check('no JS errors', errors.length === 0, errors)
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

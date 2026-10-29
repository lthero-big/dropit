// Regenerates the README / docs screenshots (docs/screenshots/*.png) from a throwaway dropit
// instance filled with fake demo data. Never point it at a real deployment: it writes data.
//
//   docker volume create dropit-shots-data
//   docker run -d --name dropit-shots -p 127.0.0.1:15244:8787 -v dropit-shots-data:/data \
//     -e APP_ORIGIN=http://dropit.example.com -e ADMIN_EMAIL=demo@example.com \
//     -e ADMIN_PASSWORD=demo-pass-2026 -e UPDATE_CHECK=false lthero1/dropit:latest
//   npm install --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install chromium
//   PLAYWRIGHT_PATH=/tmp/pw node scripts/screenshots.mjs http://127.0.0.1:15244 docs/screenshots
//   pngquant --force --skip-if-larger --quality 70-90 --ext .png docs/screenshots/*.png   # optional
//   docker rm -f dropit-shots && docker volume rm dropit-shots-data
//
// The browser maps SITE_ORIGIN (default http://dropit.example.com, must equal APP_ORIGIN) onto
// the given address, so links in the shots read dropit.example.com instead of 127.0.0.1.
// The instance must be empty: the script signs in as DEMO_EMAIL / DEMO_PASSWORD (defaults
// match the command above), seeds sample clips, files, groups, a share link, a temporary room,
// placeholder OAuth apps and a few pending users, then captures desktop and mobile PNGs.
// CHROME_PATH uses an installed Chrome instead of Playwright's bundled Chromium.
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const target = new URL(process.argv[2] ?? 'http://127.0.0.1:15244')
const outDir = process.argv[3] ?? 'docs/screenshots'
const origin = (process.env.SITE_ORIGIN ?? 'http://dropit.example.com').replace(/\/$/, '')
const email = process.env.DEMO_EMAIL ?? 'demo@example.com'
const password = process.env.DEMO_PASSWORD ?? 'demo-pass-2026'

async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_PATH) {
    const resolved = createRequire(import.meta.url).resolve('playwright', { paths: [process.env.PLAYWRIGHT_PATH] })
    return import(pathToFileURL(resolved).href)
  }
  return import('playwright')
}
const playwright = await loadPlaywright()
const { chromium } = playwright.chromium ? playwright : playwright.default
await mkdir(outDir, { recursive: true })

const siteHost = new URL(origin).hostname
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--font-render-hinting=none',
    ...(siteHost === target.hostname ? [] : [`--host-resolver-rules=MAP ${siteHost} ${target.host}`]),
  ],
})
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
const MOBILE = { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function newContext(options, theme = 'light') {
  const context = await browser.newContext({ ...options, colorScheme: theme, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  await context.addInitScript((value) => {
    try {
      localStorage.setItem('dropit-theme', value)
    } catch { /* storage blocked */ }
  }, theme)
  return context
}

// API calls run inside a page on the site origin, so they use the browser's resolver and cookies.
async function call(page, method, path, body, headers = {}) {
  const binary = body instanceof Uint8Array ? Buffer.from(body).toString('base64') : null
  const result = await page.evaluate(async ({ method, path, json, binary, headers }) => {
    const init = { method, headers: { ...headers }, credentials: 'same-origin' }
    if (binary !== null) init.body = Uint8Array.from(atob(binary), (char) => char.charCodeAt(0))
    else if (json !== undefined) {
      init.body = json
      init.headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(`/api${path}`, init)
    return { status: response.status, text: await response.text() }
  }, { method, path, json: binary === null && body !== undefined ? JSON.stringify(body) : undefined, binary, headers })
  if (result.status >= 400) throw new Error(`${method} ${path} → ${result.status} ${result.text}`)
  return result.text ? JSON.parse(result.text) : null
}

async function signedInPage(context) {
  const page = await context.newPage()
  await page.goto(`${origin}/healthz`)
  await call(page, 'POST', '/auth/password/login', { email, password })
  return page
}

const ICONS = {
  photo: '<rect x="8" y="8" width="174" height="134" rx="18"/><circle cx="60" cy="52" r="16"/><path d="M8 118l52-44 40 34 26-20 56 44"/>',
  palette: '<path d="M95 8C47 8 8 41 8 80c0 32 26 54 56 54 14 0 18-10 14-20-5-12 2-22 16-22h26c38 0 62-18 62-42C182 34 144 8 95 8z"/><circle cx="56" cy="62" r="9"/><circle cx="92" cy="40" r="9"/><circle cx="132" cy="54" r="9"/>',
  board: '<rect x="8" y="8" width="174" height="110" rx="12"/><path d="M60 142l35-24 35 24M36 44h70M36 70h110M36 94h50"/>',
}
// Fake picture "uploads", rendered by the browser so the script needs no image files or extra deps.
async function renderPicture(context, { title, subtitle, from, to, icon }) {
  const page = await context.newPage()
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.setContent(`<body style="margin:0;width:1200px;height:800px;display:grid;place-items:center;
    background:linear-gradient(135deg,${from},${to});font-family:system-ui,'Noto Sans CJK SC',sans-serif;color:#fff">
    <div style="text-align:center"><svg width="190" height="150" viewBox="0 0 190 150" fill="none" stroke="#fff"
    stroke-width="8" stroke-linecap="round" stroke-linejoin="round" style="opacity:.92">${ICONS[icon]}</svg>
    <div style="font-size:72px;font-weight:700;letter-spacing:-1px">${title}</div>
    <div style="font-size:34px;opacity:.85;margin-top:12px">${subtitle}</div></div></body>`)
  const png = await page.screenshot({ type: 'png' })
  await page.close()
  return png
}

const device = (id, name, kind) => ({ 'X-Dropit-Device': id, 'X-Dropit-Device-Name': encodeURIComponent(name), 'X-Dropit-Device-Kind': kind })
const devices = {
  mac: device('demo-mac-chrome', 'Mac · Chrome', 'mac'),
  phone: device('demo-iphone-safari', 'iPhone · Safari', 'phone'),
  pad: device('demo-ipad', 'iPad · Safari', 'pad'),
  pc: device('demo-win-edge', 'Windows · Edge', 'pc'),
  cli: device('demo-cli', 'dropit CLI', 'cli'),
}

async function seed() {
  const context = await newContext(DESKTOP)
  const page = await signedInPage(context)
  const { spaces } = await call(page, 'GET', '/spaces')
  const base = `/spaces/${spaces[0].id}`
  for (const name of ['工作', '灵感', '旅行']) await call(page, 'POST', `${base}/groups`, { name })

  const label = async (item, extra) => {
    if (extra.pinned || extra.tags) await call(page, 'PATCH', `${base}/items/${item.id}/labels`, { pinned: extra.pinned, tags: extra.tags })
    await sleep(250) // distinct createdAt, stable order
    return item
  }
  const text = async (body, from, extra = {}) => {
    const { item } = await call(page, 'POST', `${base}/items/text`, { text: body, group: extra.group ?? null }, devices[from])
    return label(item, extra)
  }
  const file = async (name, mime, bytes, from, extra = {}) => {
    const headers = { ...devices[from], 'Content-Type': mime, 'X-File-Name': encodeURIComponent(name) }
    if (extra.group) headers['X-Dropit-Group'] = encodeURIComponent(extra.group)
    const { item } = await call(page, 'POST', `${base}/items/file`, new Uint8Array(Buffer.from(bytes)), headers)
    return label(item, extra)
  }

  // Oldest first: the board shows newest first.
  await file('weekend-trip.png', 'image/png', await renderPicture(context, { title: '周末去海边', subtitle: 'Sample photo · demo data', from: '#0ea5e9', to: '#22c55e', icon: 'photo' }), 'phone', { group: '旅行', tags: ['照片'] })
  await text('杭州 → 舟山\n周六 08:30 出发，记得带充电宝和防晒。', 'phone', { group: '旅行' })
  await file('meeting-notes.md', 'text/markdown', '# 周会纪要\n\n- 发布 v0.2\n- 补充文档截图\n', 'pc', { group: '工作' })
  await text('docker compose up -d\ndocker logs dropit 2>&1 | grep "setup code"', 'cli', { group: '工作', tags: ['运维'] })
  await file('ui-moodboard.png', 'image/png', await renderPicture(context, { title: 'Moodboard', subtitle: 'paper · bento · swiss · terminal', from: '#f97316', to: '#db2777', icon: 'palette' }), 'pad', { group: '灵感', tags: ['设计'] })
  await text('配色灵感：#0A7BBB 主色 + 纸感米白背景，卡片用 1px 细线分隔。', 'pad', { group: '灵感', tags: ['设计'] })
  await file('release-checklist.pdf', 'application/pdf', '%PDF-1.4\n% demo placeholder\n', 'mac', { group: '工作' })
  const note = await text('## 本周待办\n\n- [x] 发布 **v0.2**\n- [ ] 给 README 加截图\n- [ ] 测试分片续传上传\n\n> 在一台设备上粘贴，其他设备立即看到。', 'mac', { group: '工作', tags: ['待办'] })
  await text('https://lthero-big.github.io/dropit/', 'mac', { pinned: true, tags: ['文档'] })
  await text('访客 Wi-Fi：dropit-guest\n密码：sunflower-2026（示例）', 'phone', { pinned: true })

  const share = await call(page, 'POST', `${base}/items/${note.id}/shares`, { expiresIn: '7d', maxViews: 10 })

  // A temporary room with a readable custom code (rooms need no account).
  const room = await call(page, 'POST', '/rooms', { code: 'demo-room' })
  const roomBase = `/rooms/${room.token}`
  await call(page, 'POST', `${roomBase}/items/text`, { text: '会议室投屏链接已发，扫码即可加入这个临时房间。' }, devices.mac)
  await sleep(250)
  await call(page, 'POST', `${roomBase}/items/file`, new Uint8Array(await renderPicture(context, { title: '白板照片', subtitle: 'Temporary room · demo data', from: '#6366f1', to: '#0ea5e9', icon: 'board' })), { ...devices.phone, 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('whiteboard.png') })
  await sleep(250)
  await call(page, 'POST', `${roomBase}/items/text`, { text: '临时房间 24 小时后自动销毁，不需要账号。' }, devices.pc)

  // Placeholder OAuth apps so the login page shows the GitHub / Google buttons (fake ids, never used).
  await call(page, 'PUT', '/admin/oauth/github', { clientId: 'demo-github-client-id', clientSecret: 'demo-secret', enabled: true })
  await call(page, 'PUT', '/admin/oauth/google', { clientId: 'demo-google-client-id', clientSecret: 'demo-secret', enabled: true })
  for (const [who, name] of [['alice@example.com', 'Alice'], ['bob@example.com', 'Bob'], ['carol@example.com', 'Carol']]) {
    await call(page, 'POST', '/admin/users', { email: who, name })
  }
  await context.close()
  return { sharePath: new URL(share.url).pathname, roomPath: new URL(room.url).pathname }
}

async function shot(page, name) {
  await page.evaluate(() => document.fonts?.ready)
  await sleep(700)
  const path = join(outDir, `${name}.png`)
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
  console.log('saved', path)
}

async function renderMarkdown(page) {
  for (const button of await page.getByRole('button', { name: '渲染', exact: true }).all()) await button.click()
  await settle(page)
}

// Clicking scrolls and leaves hover tooltips / focus rings behind; reset before a shot.
async function settle(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    window.scrollTo(0, 0)
  })
  const { height } = page.viewportSize()
  await page.mouse.move(2, height - 2)
  await sleep(300)
}

async function boardPage(theme, options) {
  const context = await newContext(options, theme)
  const page = await signedInPage(context)
  await page.goto(`${origin}/`)
  await page.getByText('本周待办').first().waitFor()
  await renderMarkdown(page)
  return { context, page }
}

const { sharePath, roomPath } = await seed()

// Signed out: the login page.
{
  const context = await newContext(DESKTOP)
  const page = await context.newPage()
  await page.goto(`${origin}/login`)
  await page.getByText('使用 GitHub 继续').waitFor()
  await page.locator('input[type="email"]').first().fill(email)
  await page.mouse.click(10, 10)
  await shot(page, 'login')
  await context.close()
}

// The board in light and dark, the command palette and the share panel.
{
  const { context, page } = await boardPage('light', DESKTOP)
  await shot(page, 'board-light')
  await page.keyboard.press('Control+K')
  await sleep(400)
  await shot(page, 'command-palette')
  await context.close()
}
{
  const { context, page } = await boardPage('dark', DESKTOP)
  await shot(page, 'board-dark')
  await context.close()
}
{
  const { context, page } = await boardPage('light', DESKTOP)
  const card = page.locator('[data-clip-card]').filter({ hasText: '给 README 加截图' }).first()
  await card.getByRole('button', { name: '更多' }).click()
  await sleep(500)
  await card.getByRole('button', { name: '分享' }).click()
  await shot(page, 'share-panel')
  await context.close()
}

// What a recipient sees when opening the share link (no account).
{
  const context = await newContext(DESKTOP)
  const page = await context.newPage()
  await page.goto(`${origin}${sharePath}`)
  await page.getByText('本周待办').first().waitFor()
  await renderMarkdown(page)
  await shot(page, 'share-link')
  await context.close()
}

// Temporary room, as a guest who opened /r/<code>, with its QR code.
{
  const context = await newContext(DESKTOP)
  const page = await context.newPage()
  await page.goto(`${origin}${roomPath}`)
  await page.getByText('临时房间 24 小时').first().waitFor()
  await page.getByRole('button', { name: '二维码' }).click()
  await page.getByRole('img', { name: '房间二维码' }).waitFor()
  await shot(page, 'room')
  await context.close()
}

// Settings and admin.
for (const [path, name] of [['/settings', 'settings'], ['/admin?tab=users', 'admin-users'], ['/admin?tab=limits', 'admin-limits']]) {
  const context = await newContext(DESKTOP)
  const page = await signedInPage(context)
  await page.goto(`${origin}${path}`)
  await page.waitForLoadState('networkidle')
  await shot(page, name)
  await context.close()
}

// Mobile: board in light and dark, and the room.
for (const [theme, name] of [['light', 'mobile-board'], ['dark', 'mobile-board-dark']]) {
  const { context, page } = await boardPage(theme, MOBILE)
  await shot(page, name)
  await context.close()
}
{
  const context = await newContext(MOBILE)
  const page = await context.newPage()
  await page.goto(`${origin}${roomPath}`)
  await page.getByText('临时房间 24 小时').first().waitFor()
  await shot(page, 'mobile-room')
  await context.close()
}

await browser.close()

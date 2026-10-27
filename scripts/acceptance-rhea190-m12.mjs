// RHEA-190 m12 preview check: 3 tabs of one desktop browser + 1 unnamed socket + an offline phone sender.
//   ORIGIN=http://152.53.141.33:15198 KEY=$(cat <preview key>) node scripts/acceptance-rhea190-m12.mjs
import { createRequire } from 'node:module'
const require = createRequire('/usr/lib/node_modules/openclaw/package.json')
const { chromium } = require('playwright-core')
const origin = process.env.ORIGIN, key = process.env.KEY
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let base = null
const watch = (page) => page.on('websocket', (ws) => { const u = new URL(ws.url()); base ??= u.pathname.replace(/\/ws$/, '') })
// phone: identifies as Android Chrome, sends one clip, then goes away
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' })
const pp = await phone.newPage(); watch(pp)
await pp.goto(`${origin}/__preview/login?key=${key}`); await sleep(2500)
// send via the composer-independent API with the phone's identity from its own ws url
const wsUrls = []
pp.on('websocket', (ws) => wsUrls.push(ws.url()))
await pp.reload(); await sleep(2500)
const u = new URL(wsUrls.at(-1))
const r = await pp.evaluate(async ({ b, d, n, k }) => (await fetch(`${b}/items/text`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dropit-device': d, 'x-dropit-device-name': encodeURIComponent(n), 'x-dropit-device-kind': k }, body: JSON.stringify({ text: 'from android (m12 check)' }) })).status,
  { b: base, d: u.searchParams.get('device'), n: u.searchParams.get('name'), k: u.searchParams.get('kind') })
console.log('phone sent', r, u.searchParams.get('name'))
await phone.close()
// desktop: 3 tabs of the same browser = 3 sockets, 1 device
const desk = await browser.newContext({ viewport: { width: 1280, height: 860 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' })
const tabs = []
const t0 = await desk.newPage(); await t0.goto(`${origin}/__preview/login?key=${key}`); tabs.push(t0)
for (let i = 0; i < 2; i++) { const t = await desk.newPage(); await t.goto(`${origin}/`); tabs.push(t) }
// one unnamed connection (like the CLI / an old client)
const cliCtx = await browser.newContext(); const cli = await cliCtx.newPage()
await cli.goto(`${origin}/__preview/login?key=${key}`); await sleep(1500)
await cli.goto(`${origin}/healthz`)
let raw = null
await cli.evaluate((b) => { window.__ws = new WebSocket(b + '/ws'); window.__ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'presence') window.__p = m } }, base)
await sleep(3000)
raw = await cli.evaluate(() => window.__p)
await tabs[0].bringToFront()
const status = tabs[0].locator('[data-presence]').first()
const label = await status.getAttribute('aria-label')
await tabs[0].locator('[data-presence-trigger]').first().click(); await sleep(600)
const listText = await tabs[0].locator('[data-presence-list]').innerText()
const rows = await tabs[0].locator('[data-presence-row]').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
await tabs[0].screenshot({ path: '/tmp/m12-presence.png' })
const online = rows.filter((r) => r.endsWith('在线'))
const count = Number((label ?? '').match(/^(\d+)/)?.[1])
console.log(JSON.stringify({ raw, label, rows, listText }, null, 1))
const ok = count === online.length && raw?.devices === 4 && rows.some((r) => r.includes('Android') && r.endsWith('离线'))
console.log(ok ? 'PASS' : 'FAIL', `pill=${count} onlineRows=${online.length} rawSockets=${raw?.devices}`)
await browser.close()
process.exit(ok ? 0 : 1)

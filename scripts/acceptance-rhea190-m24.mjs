import { createRequire } from 'node:module'
import { readFileSync, mkdirSync } from 'node:fs'
const require = createRequire('/usr/lib/node_modules/openclaw/package.json')
const { chromium } = require('playwright-core')
const origin = process.env.ORIGIN ?? 'http://152.53.141.33:15198'
const key = readFileSync('/root/dropit-m24-data/.preview-key', 'utf8').trim()
const out = '/tmp/m24-shots'; mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] })
const results = []
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log(pass ? 'PASS' : 'FAIL', name, info) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// login page (logged out)
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const p = await ctx.newPage(); await p.goto(`${origin}/login`); await p.waitForSelector('[data-login-provider]')
  const info = await p.evaluate(() => [...document.querySelectorAll('[data-login-provider]')].map((a) => ({ p: a.dataset.loginProvider, label: a.getAttribute('aria-label'), icon: !!a.querySelector('[data-brand-icon]') })))
  ok('login: brand icons + labels', info.length === 2 && info.every((x) => x.icon && x.label), JSON.stringify(info))
  await p.screenshot({ path: `${out}/login.png` }); await ctx.close()
}
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
const p = await ctx.newPage()
await p.goto(`${origin}/__preview/login?key=${key}`); await p.waitForSelector('[data-limits-subnav]')
const sbw = await p.evaluate(() => window.innerWidth - document.documentElement.clientWidth)
ok('real scrollbar gutter present', sbw > 0, `gutter=${sbw}px`)
const geom = () => p.evaluate(() => {
  const r = (el) => el ? Math.round(el.getBoundingClientRect().x * 10) / 10 : null
  return { header: r(document.querySelector('header > div')), title: r(document.querySelector('h1')), bodyW: document.body.getBoundingClientRect().width, clientW: document.documentElement.clientWidth, bodyStyle: document.body.getAttribute('style') || '', locked: document.body.hasAttribute('data-scroll-locked') }
})
// long page => test scroll state too
await p.evaluate(() => window.scrollTo(0, 0))
const g0 = await geom()
for (const [name, sel] of [['界面风格', '[data-skin-picker]'], ['账户菜单', 'button[aria-label="账户菜单"]']]) {
  await p.click(sel); await p.waitForSelector('[data-slot="dropdown-menu-content"][data-state="open"]')
  const anim = await p.evaluate(() => getComputedStyle(document.querySelector('[data-slot="dropdown-menu-content"]')).animationName)
  const samples = []
  for (let i = 0; i < 6; i++) { samples.push(await geom()); await sleep(40) }
  const same = samples.every((g) => g.header === g0.header && g.title === g0.title && g.bodyW === g0.bodyW && !g.locked)
  ok(`${name}: no layout shift while open`, same, JSON.stringify({ before: g0, open: samples.at(-1) }))
  ok(`${name}: fade/scale animation`, anim === 'dd-menu-in', anim)
  if (name === '界面风格') await p.screenshot({ path: `${out}/skin-menu.png` })
  await p.keyboard.press('Escape'); await sleep(250)
  const g2 = await geom()
  ok(`${name}: no shift after close`, g2.header === g0.header && g2.title === g0.title, JSON.stringify(g2))
}
// subtabs
const visible = () => p.evaluate(() => [...document.querySelectorAll('[data-limit-group]')].filter((el) => !el.hidden && el.offsetParent !== null).map((el) => el.dataset.limitGroup))
ok('limits: only 容量 shown', JSON.stringify(await visible()) === JSON.stringify(['容量']), JSON.stringify(await visible()))
await p.screenshot({ path: `${out}/limits-capacity.png`, fullPage: true })
await p.click('[data-subtab="时间"]')
ok('limits: click 时间 shows only 时间 + hash', JSON.stringify(await visible()) === '["时间"]' && (await p.evaluate(() => location.search + location.hash)) === '?tab=limits#limits-time', await p.evaluate(() => location.search + location.hash))
await p.screenshot({ path: `${out}/limits-time.png`, fullPage: true })
await p.goto(`${origin}/admin?tab=limits#limits-rate`); await p.waitForSelector('[data-limits-subnav]')
ok('limits: deep link #limits-rate', JSON.stringify(await visible()) === '["限流"]', JSON.stringify(await visible()))
ok('admin: sentence removed', !(await p.content()).includes('普通用户看不到这里'))
await p.goto(`${origin}/admin?tab=oauth`); await p.waitForSelector('[role="tablist"][aria-label="OAuth 提供方"]')
const prov = () => p.evaluate(() => [...document.querySelectorAll('[data-provider]')].filter((el) => !el.hidden).map((el) => el.dataset.provider))
ok('oauth: GitHub tab first', JSON.stringify(await prov()) === '["github"]', JSON.stringify(await prov()))
await p.click('[data-subtab="google"]')
ok('oauth: Google tab switch + hash', JSON.stringify(await prov()) === '["google"]' && (await p.evaluate(() => location.hash)) === '#oauth-google', JSON.stringify(await prov()))
await p.screenshot({ path: `${out}/oauth-google.png`, fullPage: true })
// reduced motion
const rm = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' })
const q = await rm.newPage(); await q.goto(`${origin}/__preview/login?key=${key}`); await q.waitForSelector('[data-skin-picker]')
await q.click('[data-skin-picker]'); await q.waitForSelector('[data-slot="dropdown-menu-content"]')
const rmAnim = await q.evaluate(() => getComputedStyle(document.querySelector('[data-slot="dropdown-menu-content"]')).animationName)
ok('reduced motion: no menu animation', rmAnim === 'none', rmAnim)
await browser.close()
const failed = results.filter((r) => !r.pass).length
console.log(`SUMMARY ${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

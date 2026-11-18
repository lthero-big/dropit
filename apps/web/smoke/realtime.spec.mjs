import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

async function login(page) {
  await page.goto('/')
  await page.getByLabel('邮箱', { exact: true }).fill(process.env.DROPIT_SMOKE_EMAIL)
  await page.getByLabel('密码', { exact: true }).fill(process.env.DROPIT_SMOKE_PASSWORD)
  await page.getByRole('button', { name: '用密码登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '私人空间', exact: true })).toBeVisible()
}

async function send(page, text) {
  await page.getByLabel('要发送的文本', { exact: true }).fill(text)
  const response = page.waitForResponse(r => r.request().method() === 'POST' && /\/items\/text$/.test(new URL(r.url()).pathname))
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).status()).toBe(201)
}

test('two independent browser sessions receive text and an authoritative reconnect snapshot', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL })
  const second = await browser.newContext({ baseURL })
  try {
    // Track real native sockets to simulate a lost connection without mocking traffic.
    await second.addInitScript(() => {
      const Native = window.WebSocket
      window.__smokeSockets = []
      window.WebSocket = class extends Native {
        constructor(...args) { super(...args); window.__smokeSockets.push(this) }
      }
    })
    const a = await first.newPage()
    const b = await second.newPage()
    const events = []
    let snapshots = 0
    b.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload))
      events.push(message)
      if (message.type === 'snapshot') snapshots++
    }))
    await login(a)
    await login(b)
    await expect.poll(() => events.some(m => m.type === 'presence' && m.devices === 2 && m.peers?.length === 2)).toBe(true)
    const live = '实时跨浏览器 ' + randomUUID()
    await send(a, live)
    await expect(b.getByText(live, { exact: true })).toBeVisible()
    expect(events.some(m => m.type === 'item.created' && m.item.text === live)).toBe(true)

    await second.setOffline(true)
    await b.evaluate(() => window.__smokeSockets.filter(socket => new URL(socket.url).pathname.startsWith('/api/spaces/')).forEach(socket => socket.close()))
    const missed = '断网期间文本 ' + randomUUID()
    await send(a, missed)
    const previous = snapshots
    await second.setOffline(false)
    await expect.poll(() => snapshots, { timeout: 15000 }).toBeGreaterThan(previous)
    await expect(b.getByText(missed, { exact: true })).toBeVisible()
    expect(events.filter(m => m.type === 'snapshot').at(-1).items.some(i => i.text === missed)).toBe(true)
    // Cookie jars and device identities are independent.
    const cookiesA = await first.cookies()
    const cookiesB = await second.cookies()
    expect(cookiesA.find(c => c.name.endsWith('dropit_session')).value).not.toBe(cookiesB.find(c => c.name.endsWith('dropit_session')).value)
  } finally {
    await first.close()
    await second.close()
  }
})

import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { resolveConfig } from 'vite'

test('Vite uses the same target for health, downloads and the API including WebSocket', async () => {
  const previous = process.env.DROPIT_DEV_BACKEND_ORIGIN
  const customTarget = 'http://127.0.0.1:28787'
  try {
    for (const target of [undefined, customTarget]) {
      if (target === undefined) delete process.env.DROPIT_DEV_BACKEND_ORIGIN
      else process.env.DROPIT_DEV_BACKEND_ORIGIN = target

      const config = await resolveConfig({}, 'serve')
      const expected = target ?? 'http://127.0.0.1:8787'
      expect(config.server.proxy).toEqual({
        '/healthz': expected,
        '/d/': expected,
        '/api': { target: expected, ws: true },
      })
    }
  } finally {
    if (previous === undefined) delete process.env.DROPIT_DEV_BACKEND_ORIGIN
    else process.env.DROPIT_DEV_BACKEND_ORIGIN = previous
  }
})

test('the isolated TS service responds through the custom HTTP proxy', async ({ request }) => {
  test.skip(Boolean(process.env.DROPIT_DEV_BACKEND_ORIGIN?.trim()), 'The short download assertion belongs to the TS baseline.')
  const health = await request.get('/healthz')
  expect(health.status()).toBe(200)
  expect(await health.json()).toEqual({ status: 'ok' })

  const download = await request.get('/d/' + randomUUID().replaceAll('-', ''))
  expect(download.status()).toBe(404)
  expect(download.headers()['cache-control']).toBe('no-store')
  expect(await download.json()).toEqual({ error: { code: 'NOT_FOUND' } })
})

async function clickAndWaitForPost(page, button, path) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === 'POST' &&
      path.test(new URL(candidate.url()).pathname)),
    button.click(),
  ])
  return response
}

test('password login, private clipboard text, reload and logout', async ({ page }) => {
  const health = await page.request.get('/healthz')
  expect(health.status(), 'Selected backend must serve GET /healthz').toBe(200)

  const site = await page.request.get('/api/site')
  expect.soft(site.status(), 'Site metadata requires GET /api/site').toBe(200)
  const providers = await page.request.get('/api/auth/providers')
  expect(providers.status(), 'Login form initialization requires GET /api/auth/providers').toBe(200)
  expect(await providers.json()).toMatchObject({ providers: expect.any(Array), password: true, setupRequired: false })

  const text = '浏览器验收 ' + randomUUID()
  let snapshotHasText = false
  page.on('websocket', (socket) => {
    if (!/^\/api\/spaces\/[^/]+\/ws$/.test(new URL(socket.url()).pathname)) return
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload))
      if (message.type === 'snapshot' && message.items?.some((item) => item.text === text)) snapshotHasText = true
    })
  })

  await page.goto('/')
  const login = page.getByRole('button', { name: '用密码登录', exact: true })
  await page.getByLabel('邮箱', { exact: true }).fill(process.env.DROPIT_SMOKE_EMAIL)
  await page.getByLabel('密码', { exact: true }).fill(process.env.DROPIT_SMOKE_PASSWORD)
  const signedIn = await clickAndWaitForPost(page, login, /^\/api\/auth\/password\/login$/)
  expect(signedIn.status(), 'POST /api/auth/password/login').toBe(200)
  await expect(page.getByRole('heading', { name: '私人空间', exact: true })).toBeVisible()

  await page.getByLabel('要发送的文本', { exact: true }).fill(text)
  const send = page.getByRole('button', { name: '发送', exact: true })
  const posted = await clickAndWaitForPost(page, send, /^\/api\/spaces\/[^/]+\/items\/text$/)
  expect(posted.status(), 'POST /api/spaces/:space/items/text').toBe(201)
  const clip = page.getByText(text, { exact: true })
  await expect(clip).toBeVisible()

  snapshotHasText = false
  await page.reload()
  await expect.soft.poll(() => snapshotHasText, {
    message: 'A fresh WebSocket snapshot must contain the saved text after reloading',
  }).toBe(true)
  await expect.soft(clip).toBeVisible()

  await page.getByRole('button', { name: '账户菜单', exact: true }).click()
  const logout = page.getByRole('menuitem', { name: '退出', exact: true })
  const loggedOut = await clickAndWaitForPost(page, logout, /^\/api\/auth\/logout$/)
  expect(loggedOut.status(), 'POST /api/auth/logout').toBe(204)
  await expect(login).toBeVisible()
  expect((await page.request.get('/api/me')).status()).toBe(401)
})

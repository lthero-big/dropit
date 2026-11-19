import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

async function login(page) {
  await page.goto('/')
  await page.getByLabel('邮箱', { exact: true }).fill(process.env.DROPIT_SMOKE_EMAIL)
  await page.getByLabel('密码', { exact: true }).fill(process.env.DROPIT_SMOKE_PASSWORD)
  const signedIn = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/auth/password/login')
  await page.getByRole('button', { name: '用密码登录', exact: true }).click()
  expect((await signedIn).status()).toBe(200)
  await expect(page.getByRole('heading', { name: '私人空间', exact: true })).toBeVisible()
}

async function responseFor(page, action, method, suffix) {
  const pending = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname.endsWith(suffix))
  await action()
  const response = await pending
  expect(response.status()).toBe(method === 'POST' ? 201 : 200)
  return response.json()
}

test('editing, group filters and group changes synchronize between real browsers', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL, reducedMotion: 'reduce' })
  const second = await browser.newContext({ baseURL, reducedMotion: 'reduce' })
  try {
    const a = await first.newPage(), b = await second.newPage()
    const remote = []
    b.on('websocket', socket => socket.on('framereceived', ({ payload }) => remote.push(JSON.parse(String(payload)))))
    await login(a)
    await login(b)
    await expect.poll(() => remote.some(message => message.type === 'snapshot')).toBe(true)
    const marker = randomUUID().slice(0, 8), text = `edit ${marker}`, edited = `edited ${marker} <img src=x onerror=alert(1)>`
    await a.getByLabel('要发送的文本', { exact: true }).fill(text)
    const { item } = await responseFor(a, () => a.getByRole('button', { name: '发送', exact: true }).click(), 'POST', '/items/text')
    await expect(b.getByText(text, { exact: true })).toBeVisible()
    const card = a.getByRole('listitem').filter({ hasText: text })
    await card.getByRole('button', { name: '更多', exact: true }).click()
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    await a.getByLabel('编辑文本', { exact: true }).fill(edited)
    await responseFor(a, () => a.getByRole('button', { name: '保存', exact: true }).click(), 'PATCH', `/items/${item.id}`)
    await expect(b.getByText(edited, { exact: true })).toBeVisible()
    await expect(b.locator('img[src="x"]')).toHaveCount(0)
    const group = `g${marker}`, renamed = `r${marker}`
    await a.getByRole('button', { name: '新建分组', exact: true }).click()
    await a.getByLabel('分组名', { exact: true }).fill(group)
    await responseFor(a, () => a.getByLabel('分组名', { exact: true }).press('Enter'), 'POST', '/groups')
    const bar = page => page.getByRole('toolbar', { name: '分组', exact: true })
    await expect(bar(b).getByRole('button', { name: new RegExp(`^${group}`) })).toBeVisible()
    await bar(b).getByRole('button', { name: new RegExp(`^${group}`) }).click()
    await expect(b.getByText(edited, { exact: true })).toHaveCount(0)
    const editedCard = a.getByRole('listitem').filter({ hasText: edited })
    await editedCard.getByRole('button', { name: '加入分组', exact: true }).click()
    await responseFor(a, () => a.getByRole('menuitem', { name: group, exact: true }).click(), 'PATCH', `/items/${item.id}/labels`)
    await expect(b.getByText(edited, { exact: true })).toBeVisible()
    await bar(a).getByRole('button', { name: new RegExp(`^${group}`) }).click()
    await a.getByRole('button', { name: `管理分组「${group}」`, exact: true }).click()
    await a.getByRole('menuitem', { name: '重命名', exact: true }).click()
    await a.getByLabel('分组名', { exact: true }).fill(renamed)
    await responseFor(a, () => a.getByLabel('分组名', { exact: true }).press('Enter'), 'PATCH', `/groups/${group}`)
    await expect(bar(b).getByRole('button', { name: new RegExp(`^${renamed}`) })).toBeVisible()
    await a.getByRole('button', { name: `管理分组「${renamed}」`, exact: true }).click()
    await responseFor(a, () => a.getByRole('menuitem', { name: '删除分组（内容移到未分组）', exact: true }).click(), 'DELETE', `/groups/${renamed}`)
    await expect(bar(b).getByRole('button', { name: new RegExp(`^${renamed}`) })).toHaveCount(0)
    await expect.poll(() => remote.some(message => message.type === 'item.updated' && message.item.id === item.id && message.item.group === null)).toBe(true)
    await b.reload()
    await expect(b.getByText(edited, { exact: true })).toBeVisible()
  } finally {
    await first.close()
    await second.close()
  }
})

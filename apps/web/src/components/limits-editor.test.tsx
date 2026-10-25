import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LimitsEditor } from './limits-editor.tsx'
import { defaultUnit, localLimitError, toCanonical, toInput } from '@/lib/limits-form.ts'
import type { AdminLimits, LimitAuditEntry, LimitField, LimitKey } from '@/lib/types.ts'

const MIB = 1024 ** 2
const GIB = 1024 ** 3
const HOUR = 3_600_000
const DAY = 86_400_000

function field(value: number, max: number, overridden = false, fallback = value): LimitField {
  return { value, default: fallback, overridden, min: 1, max }
}

function sample(): AdminLimits {
  return {
    maxFileBytes: field(25 * MIB, GIB),
    maxTextBytes: field(64 * 1024, MIB),
    maxItems: field(1000, 100_000),
    userQuotaBytes: field(GIB, 100 * GIB),
    retentionMs: field(7 * DAY, 365 * DAY),
    roomQuotaBytes: field(50 * MIB, 100 * GIB),
    roomMaxFileBytes: field(5 * MIB, GIB),
    roomRetentionMs: field(DAY, DAY),
    rateWindowMs: field(60_000, HOUR),
    rateGeneral: field(240, 1_000_000),
    rateAuth: field(20, 1_000_000),
    rateInvite: field(10, 1_000_000),
    rateUpload: field(30, 1_000_000),
    rateRoom: field(10, 1_000_000),
    sessionMs: field(3 * HOUR, 365 * DAY),
    uploadChunkBytes: field(8388608, 25165824),
    uploadChunkTimeoutMs: field(120000, 3600000),
    rateChunk: field(2000, 1000000),
    uploadChunksPerSession: field(3, 16),
    uploadChunksPerUser: field(6, 64),
    uploadChunksGlobal: field(16, 256),
    uploadSessionsPerUser: field(8, 1000),
    uploadSessionsGlobal: field(128, 10000),
  }
}

function applyPatch(limits: AdminLimits, patch: Record<string, number | null>): AdminLimits {
  const next = { ...limits }
  for (const [key, value] of Object.entries(patch)) {
    const current = { ...next[key as LimitKey] }
    if (value === null) {
      current.value = current.default
      current.overridden = false
    } else {
      current.value = value
      current.overridden = true
    }
    next[key as LimitKey] = current
  }
  return next
}

const calls: { url: string; init?: RequestInit }[] = []
let server = sample()
let failPatch = false
let audit: { entries: LimitAuditEntry[]; nextCursor: number | null } = { entries: [], nextCursor: null }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      if (url.startsWith('/api/admin/limits/audit')) {
        if (url.includes('cursor=7')) {
          return json({
            entries: [{ id: 2, actorId: 'u2', actorEmail: 'bea@example.com', createdAt: Date.UTC(2026, 9, 24, 1, 0), key: 'maxItems', oldValue: 1000, newValue: 12, oldOverride: null, newOverride: 12 }],
            nextCursor: null,
          })
        }
        return json(audit)
      }
      if (url === '/api/admin/limits' && init?.method === 'PATCH') {
        if (failPatch) return json({ error: { code: 'INVALID_LIMITS' } }, 400)
        server = applyPatch(server, JSON.parse(String(init.body)) as Record<string, number | null>)
        return json(server)
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    }),
  )
}

function Harness() {
  const [limits, setLimits] = useState(server)
  return <LimitsEditor limits={limits} onChange={setLimits} />
}

function row(key: string) {
  const node = document.querySelector(`[data-limit="${key}"]`)
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${key}`)
  return node
}

afterEach(() => {
  cleanup()
  calls.length = 0
  server = sample()
  failPatch = false
  audit = { entries: [], nextCursor: null }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('limit units', () => {
  it('converts bytes, durations and counts', () => {
    expect(toInput(64 * 1024, 'MB')).toBe('0.0625')
    expect(toCanonical('0.0625', 'MB')).toBe(64 * 1024)
    expect(toCanonical('2', 'MB')).toBe(2 * MIB)
    expect(toCanonical('2', 'GB')).toBe(2 * GIB)
    expect(toCanonical('2', 'day')).toBe(2 * DAY)
    expect(toCanonical('5', 'hour')).toBe(5 * HOUR)
    expect(toCanonical('90', 'second')).toBe(90_000)
    expect(toCanonical('2', 'minute')).toBe(120_000)
    expect(toCanonical('1.5', 'count')).toBeNull()
    expect(toCanonical('12', 'count')).toBe(12)
    expect(toCanonical(toInput(1, 'MB'), 'MB')).toBe(1)
    expect(defaultUnit('userQuotaBytes', GIB)).toBe('GB')
    expect(defaultUnit('retentionMs', 7 * DAY)).toBe('day')
    expect(defaultUnit('rateWindowMs', 60_000)).toBe('minute')
    const limits = sample()
    expect(localLimitError('roomMaxFileBytes', 25 * MIB, limits)).toBe('房间单文件必须小于单文件上限')
    expect(localLimitError('maxItems', 100_001, limits)).toMatch(/需在/)
  })
})

describe('LimitsEditor', () => {
  it('shows current, default, override state and the persistence note', async () => {
    server.maxFileBytes = field(2 * MIB, GIB, true, 25 * MIB)
    audit = {
      entries: [{
        id: 7,
        actorId: 'u1',
        actorEmail: 'ada@example.com',
        createdAt: Date.UTC(2026, 9, 25, 2, 16),
        key: 'maxFileBytes',
        oldValue: 500,
        newValue: 2 * MIB,
        oldOverride: null,
        newOverride: 2 * MIB,
      }],
      nextCursor: 7,
    }
    stubFetch()
    render(<Harness />)
    expect(screen.getByText('覆盖值保存在数据库，重启后保留；只读项仍需改环境变量。')).toBeTruthy()
    const file = row('maxFileBytes')
    expect(within(file).getByText('已覆盖')).toBeTruthy()
    expect(within(file).getByText('当前 2.0 MB')).toBeTruthy()
    expect(within(file).getByText('默认 25.0 MB')).toBeTruthy()
    expect(within(row('retentionMs')).getByText('当前 7 天')).toBeTruthy()
    expect(within(row('sessionMs')).getByText('当前 3 小时')).toBeTruthy()
    expect(within(row('rateWindowMs')).getByText('当前 1 分钟')).toBeTruthy()
    expect(await screen.findByText('ada@example.com')).toBeTruthy()
    expect(screen.getByText('500 B → 2.0 MB')).toBeTruthy()
    expect(document.querySelector('time')?.getAttribute('datetime')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更早的记录' }))
    expect(await screen.findByText('bea@example.com')).toBeTruthy()
    expect(screen.getByText('1000 条 → 12 条')).toBeTruthy()
    expect(calls.some((call) => call.url.includes('cursor=7'))).toBe(true)
  })

  it('saves MB and GB values and reflects the override immediately', async () => {
    stubFetch()
    render(<Harness />)
    fireEvent.change(within(row('maxFileBytes')).getByLabelText('单文件上限'), { target: { value: '10' } })
    fireEvent.click(within(row('maxFileBytes')).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(row('maxFileBytes')).getByText('已覆盖')).toBeTruthy())
    expect(within(row('maxFileBytes')).getByText('当前 10.0 MB')).toBeTruthy()
    const patch = calls.find((call) => call.init?.method === 'PATCH')
    expect(patch?.init?.body).toBe(JSON.stringify({ maxFileBytes: 10 * MIB }))

    fireEvent.change(within(row('userQuotaBytes')).getByLabelText('默认用户配额'), { target: { value: '2' } })
    fireEvent.click(within(row('userQuotaBytes')).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(row('userQuotaBytes')).getByText('当前 2.00 GB')).toBeTruthy())
    const quotaPatch = calls.filter((call) => call.init?.method === 'PATCH').at(-1)
    expect(quotaPatch?.init?.body).toBe(JSON.stringify({ userQuotaBytes: 2 * GIB }))
  })

  it('saves hours and days', async () => {
    stubFetch()
    render(<Harness />)
    fireEvent.change(within(row('retentionMs')).getByLabelText('内容保留'), { target: { value: '2' } })
    fireEvent.click(within(row('retentionMs')).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(row('retentionMs')).getByText('当前 2 天')).toBeTruthy())
    expect(calls.some((call) => call.init?.body === JSON.stringify({ retentionMs: 2 * DAY }))).toBe(true)

    fireEvent.change(within(row('sessionMs')).getByLabelText('会话时长'), { target: { value: '5' } })
    fireEvent.click(within(row('sessionMs')).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(row('sessionMs')).getByText('当前 5 小时')).toBeTruthy())
    expect(calls.some((call) => call.init?.body === JSON.stringify({ sessionMs: 5 * HOUR }))).toBe(true)
  })

  it('blocks invalid input locally and shows backend errors', async () => {
    stubFetch()
    render(<Harness />)
    const items = row('maxItems')
    fireEvent.change(within(items).getByLabelText('每空间条目上限'), { target: { value: '100001' } })
    fireEvent.click(within(items).getByRole('button', { name: '保存' }))
    expect(within(items).getByRole('alert').textContent).toMatch(/需在/)
    expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(false)

    const roomFile = row('roomMaxFileBytes')
    fireEvent.change(within(roomFile).getByLabelText('房间单文件'), { target: { value: '25' } })
    fireEvent.click(within(roomFile).getByRole('button', { name: '保存' }))
    expect(within(roomFile).getByRole('alert').textContent).toContain('房间单文件必须小于单文件上限')

    fireEvent.change(within(items).getByLabelText('每空间条目上限'), { target: { value: '1.5' } })
    fireEvent.click(within(items).getByRole('button', { name: '保存' }))
    expect(within(items).getByRole('alert').textContent).toContain('请输入大于 0 的整数')

    failPatch = true
    fireEvent.change(within(items).getByLabelText('每空间条目上限'), { target: { value: '12' } })
    fireEvent.click(within(items).getByRole('button', { name: '保存' }))
    expect(await within(items).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('限制值不在允许范围'))
    expect(within(items).getByText('未覆盖')).toBeTruthy()
  })

  it('restores one limit to its default', async () => {
    server.maxTextBytes = field(32 * 1024, MIB, true, 64 * 1024)
    stubFetch()
    render(<Harness />)
    expect(within(row('maxTextBytes')).getByText('已覆盖')).toBeTruthy()
    fireEvent.click(within(row('maxTextBytes')).getByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(within(row('maxTextBytes')).getByText('未覆盖')).toBeTruthy())
    expect(within(row('maxTextBytes')).getByText('当前 64.0 KB')).toBeTruthy()
    const patch = calls.find((call) => call.init?.method === 'PATCH')
    expect(patch?.init?.body).toBe(JSON.stringify({ maxTextBytes: null }))
    expect(within(row('maxTextBytes')).getByRole('button', { name: '恢复默认' })).toHaveProperty('disabled', true)
  })
})

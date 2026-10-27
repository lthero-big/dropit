import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateNotice, UpdatePanel } from './update-panel.tsx'
import { latestText, versionText } from '@/lib/update.ts'
import type { InstallKind, UpdateReport } from '@/lib/types.ts'

const commands: Record<InstallKind, string> = {
  docker: 'docker compose pull && docker compose up -d',
  'docker-build': './scripts/update.sh --docker',
  source: './scripts/update.sh',
}

function report(overrides: Partial<UpdateReport['check']> = {}, install: InstallKind = 'docker'): UpdateReport {
  return {
    current: { version: '0.1.0', commit: 'f9db2bd', buildDate: '2026-10-27T12:00:00.000Z', install },
    check: {
      enabled: true,
      status: 'up-to-date',
      source: install === 'docker' ? 'dockerhub' : 'github',
      checkedAt: Date.now() - 60_000,
      nextCheckAt: Date.now() + 3_600_000,
      intervalHours: 12,
      error: null,
      reason: null,
      image: 'lthero1/dropit',
      repo: 'lthero-big/dropit',
      branch: 'main',
      latest: { version: null, commit: 'f9db2bd', digest: 'sha256:cd12d65d46fb', publishedAt: null, url: 'https://hub.docker.com/r/lthero1/dropit/tags', behindBy: 0 },
      ...overrides,
    },
    upgrade: { install, command: commands[install], docs: 'https://github.com/lthero-big/dropit/blob/main/docs/wiki/Deployment.md#upgrading' },
  }
}

function stub(first: UpdateReport, afterCheck?: UpdateReport) {
  const calls: { url: string; method: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      const body = method === 'POST' ? (afterCheck ?? first) : first
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('update panel', () => {
  it('formats current and latest builds', () => {
    expect(versionText(report())).toBe('v0.1.0 · f9db2bd')
    expect(latestText(report({ latest: { version: '0.2.0', commit: 'ab078cf', digest: null, publishedAt: null, url: null, behindBy: 3 } }))).toBe(
      'v0.2.0 · ab078cf · 落后 3 个提交',
    )
    expect(latestText(report({ latest: { version: null, commit: null, digest: 'sha256:0123456789abcdef', publishedAt: null, url: null, behindBy: null } }))).toBe(
      '0123456789ab',
    )
  })

  it('shows the current build, status and the docker upgrade command; 立即检查 posts and refreshes', async () => {
    const calls = stub(report(), report({ status: 'available', latest: { version: null, commit: 'ab078cf', digest: 'sha256:9', publishedAt: null, url: null, behindBy: 2 } }))
    render(<UpdatePanel />)
    expect((await screen.findByTestId('current-version')).textContent).toContain('v0.1.0')
    expect(screen.getByText('f9db2bd')).toBeTruthy()
    expect(screen.getByTestId('update-status').textContent).toContain('已是最新')
    expect(screen.getByTestId('upgrade-command').textContent).toContain('docker compose pull && docker compose up -d')
    expect(screen.getByText(/--profile autoupdate/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '立即检查' }))
    await waitFor(() => expect(screen.getByTestId('update-status').textContent).toContain('有新版本可用'))
    expect(screen.getByText(/ab078cf · 落后 2 个提交/)).toBeTruthy()
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/admin/update', 'POST /api/admin/update/check'])
  })

  it('uses the local-build command for source installs and explains offline errors', async () => {
    stub(report({ status: 'error', error: 'NETWORK' }, 'source'))
    render(<UpdatePanel />)
    expect((await screen.findByTestId('upgrade-command')).textContent).toContain('./scripts/update.sh')
    expect(screen.getByTestId('update-status').textContent).toContain('检查失败')
    expect(screen.getByText(/离线或被防火墙拦截/)).toBeTruthy()
    expect(screen.getByText(/GitHub lthero-big\/dropit 的 main 分支/)).toBeTruthy()
  })

  it('says how to re-enable when UPDATE_CHECK=false and hides 立即检查', async () => {
    stub(report({ enabled: false, status: 'disabled', latest: null }, 'docker-build'))
    render(<UpdatePanel />)
    expect((await screen.findByTestId('update-status')).textContent).toContain('已关闭')
    expect(screen.getByText('UPDATE_CHECK=false')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '立即检查' })).toBeNull()
    expect(screen.getByTestId('upgrade-command').textContent).toContain('./scripts/update.sh --docker')
  })

  it('notice renders only when a new version is available', async () => {
    stub(report())
    const { container } = render(
      <MemoryRouter>
        <UpdateNotice />
      </MemoryRouter>,
    )
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    cleanup()
    stub(report({ status: 'available', latest: { version: '0.2.0', commit: null, digest: null, publishedAt: null, url: null, behindBy: null } }))
    render(
      <MemoryRouter>
        <UpdateNotice />
      </MemoryRouter>,
    )
    expect((await screen.findByRole('status', { name: '新版本提示' })).textContent).toContain('有新版本可用：v0.2.0')
    expect(screen.getByRole('link', { name: '查看更新' }).getAttribute('href')).toBe('/admin?tab=update')
  })
})

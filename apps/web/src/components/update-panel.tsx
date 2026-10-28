import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import { formatStamp } from '@/lib/machine.ts'
import type { UpdateReport, UpdateStatus } from '@/lib/types.ts'
import { INSTALL_LABEL, latestText, versionText } from '@/lib/update.ts'

const STATUS_LABEL: Record<UpdateStatus, string> = {
  disabled: '已关闭',
  pending: '尚未检查',
  'up-to-date': '已是最新',
  available: '有新版本可用',
  unknown: '无法判断',
  error: '检查失败',
}

const REASON_LABEL: Record<string, string> = {
  NO_LOCAL_COMMIT: '当前构建没有记录 git 提交号（构建时没有传 DROPIT_COMMIT，也不在 git 仓库里构建），无法比较。',
  COMMIT_NOT_ON_GITHUB: '当前提交不在 GitHub 上游仓库里（可能是本地修改或 fork），无法比较。',
  REMOTE_UNTAGGED: 'Docker Hub 的 latest 没有对应的提交号或版本号标签，无法比较。',
  COMPARE_UNAVAILABLE: 'Docker Hub 上的 latest 与当前提交不同；暂时无法确认先后。',
}

const ERROR_LABEL: Record<string, string> = {
  NETWORK: '连不上 Docker Hub / GitHub（离线或被防火墙拦截）。不影响正常使用，稍后会自动重试。',
  TIMEOUT: '请求超时。不影响正常使用，稍后会自动重试。',
  RATE_LIMITED: '被 GitHub / Docker Hub 限流了，稍后会自动重试。',
}

function useUpdateReport() {
  const [report, setReport] = useState<UpdateReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    api<UpdateReport>('/api/admin/update')
      .then((body) => {
        if (active) setReport(body)
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason))
      })
    return () => {
      active = false
    }
  }, [])
  return { report, setReport, error }
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <code className="grow rounded-md border border-line-2 bg-surface-2 px-2 py-1.5 font-mono text-xs break-all" data-testid="upgrade-command">
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        onClick={() => void copyText(command).then(() => toast.success('已复制升级命令'), () => toast.error('复制失败'))}
      >
        复制
      </Button>
    </div>
  )
}

/** Compact banner for admins; renders nothing unless an update is available. */
export function UpdateNotice({ onOpen }: { onOpen?: () => void }) {
  const { report } = useUpdateReport()
  if (!report || report.check.status !== 'available') return null
  const latest = latestText(report)
  return (
    <section role="status" aria-label="新版本提示" className="mb-6 rounded-md border border-primary/40 bg-primary/5 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          有新版本可用{latest ? `：${latest}` : ''}
          <span className="ml-2 text-xs font-normal text-muted-foreground">当前 {versionText(report)}</span>
        </p>
        {onOpen ? (
          <Button type="button" variant="outline" onClick={onOpen}>
            查看
          </Button>
        ) : (
          <Link to="/admin?tab=update" className="text-xs font-medium underline">
            查看更新
          </Link>
        )}
      </div>
      <CommandLine command={report.upgrade.command} />
    </section>
  )
}

/** Admin → 更新 tab. */
export function UpdatePanel() {
  const { report, setReport, error } = useUpdateReport()
  const [busy, setBusy] = useState(false)

  const checkNow = useCallback(async () => {
    setBusy(true)
    try {
      const body = await api<UpdateReport>('/api/admin/update/check', { method: 'POST' })
      setReport(body)
      if (body.check.status === 'error') toast.error('检查失败，稍后会自动重试')
      else toast.success(body.check.status === 'available' ? '有新版本可用' : '检查完成')
    } catch (reason) {
      toast.error(errorText(reason))
    } finally {
      setBusy(false)
    }
  }, [setReport])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!report) return <p className="text-sm text-muted-foreground">正在读取版本信息…</p>
  const { current, check, upgrade } = report
  const latest = latestText(report)
  const statusClass =
    check.status === 'available' ? 'text-primary' : check.status === 'error' ? 'text-destructive' : 'text-muted-foreground'

  return (
    <div className="grid gap-6">
      <section aria-label="当前版本">
        <h2 className="mb-3 text-xs font-medium">当前版本</h2>
        <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">版本</dt>
          <dd data-testid="current-version">v{current.version}</dd>
          <dt className="text-muted-foreground">提交</dt>
          <dd className="font-mono">{current.commit ?? '未知'}</dd>
          <dt className="text-muted-foreground">构建时间</dt>
          <dd>{current.buildDate ? formatStamp(Date.parse(current.buildDate)) : '未知'}</dd>
          <dt className="text-muted-foreground">部署方式</dt>
          <dd>{INSTALL_LABEL[current.install]}</dd>
        </dl>
      </section>

      <section aria-label="更新检查" className="border-t border-line-1 pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-medium">
            更新检查 · <span className={statusClass} data-testid="update-status">{STATUS_LABEL[check.status]}</span>
          </h2>
          {check.enabled ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void checkNow()}>
              {busy ? '检查中…' : '立即检查'}
            </Button>
          ) : null}
        </div>
        {check.enabled ? (
          <div className="grid gap-1 text-sm">
            <p className="text-muted-foreground">
              每 {check.intervalHours} 小时检查一次{check.source === 'dockerhub' || current.install === 'docker' ? ` Docker Hub ${check.image}:latest` : ` GitHub ${check.repo} 的 ${check.branch} 分支`}
              ，也会参考 GitHub Releases。结果会缓存，离线时不影响使用。
            </p>
            {check.checkedAt ? <p className="text-muted-foreground">上次检查：{formatStamp(check.checkedAt)}</p> : null}
            {latest ? (
              <p>
                最新：{latest}
                {check.latest?.url ? (
                  <a className="ml-2 text-xs underline" href={check.latest.url} target="_blank" rel="noreferrer">
                    详情
                  </a>
                ) : null}
              </p>
            ) : null}
            {check.status === 'error' && check.error ? <p className="text-destructive">{ERROR_LABEL[check.error] ?? `检查失败（${check.error}）`}</p> : null}
            {check.status === 'unknown' && check.reason ? <p className="text-muted-foreground">{REASON_LABEL[check.reason] ?? check.reason}</p> : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            已通过 <code className="font-mono">UPDATE_CHECK=false</code> 关闭，不会访问外网。删除该变量并重启即可开启。
          </p>
        )}
      </section>

      <section aria-label="升级方式" className="border-t border-line-1 pt-4">
        <h2 className="text-xs font-medium">升级方式 · {INSTALL_LABEL[upgrade.install]}</h2>
        <p className="mt-2 text-sm text-muted-foreground">在服务器上 dropit 的目录里执行：</p>
        <CommandLine command={upgrade.command} />
        <p className="mt-3 text-xs text-muted-foreground">
          {upgrade.install === 'docker'
            ? '想全自动：docker compose --profile autoupdate up -d 会启动只监控 dropit 容器的 watchtower，每 12 小时拉取一次 latest。'
            : upgrade.install === 'docker-build'
              ? '脚本会 git pull --ff-only，然后 docker compose up -d --build。数据卷不受影响，迁移会在启动时自动执行。'
              : '脚本会 git pull --ff-only、pnpm install --frozen-lockfile、pnpm build，然后重启（systemd / pm2 / DROPIT_RESTART_CMD）。'}{' '}
          <a className="underline" href={upgrade.docs} target="_blank" rel="noreferrer">
            升级文档
          </a>
        </p>
      </section>
    </div>
  )
}

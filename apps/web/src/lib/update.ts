import type { InstallKind, UpdateReport } from './types.ts'

export const INSTALL_LABEL: Record<InstallKind, string> = {
  docker: 'Docker 镜像（Docker Hub）',
  'docker-build': 'Docker（本地源码构建）',
  source: '源码部署（pnpm）',
}

export function versionText(report: Pick<UpdateReport, 'current'>): string {
  const { version, commit } = report.current
  return commit ? `v${version} · ${commit}` : `v${version}`
}

export function latestText(report: UpdateReport): string | null {
  const latest = report.check.latest
  if (!latest) return null
  const parts: string[] = []
  if (latest.version) parts.push(`v${latest.version}`)
  if (latest.commit) parts.push(latest.commit)
  if (!parts.length && latest.digest) parts.push(latest.digest.replace(/^sha256:/, '').slice(0, 12))
  if (latest.behindBy) parts.push(`落后 ${latest.behindBy} 个提交`)
  return parts.length ? parts.join(' · ') : null
}

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Note, Panel, StatusPill } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { formatBytes, formatRemain, formatWhen, useClock } from '@/lib/format.ts'
import type { AdminRoom } from '@/lib/types.ts'

const thClass = 'px-4 py-2.5 text-left text-[11px] font-medium text-fg-3 first:pl-4 sm:first:pl-5 last:pr-4 sm:last:pr-5'
const tdClass = 'px-4 py-3 align-middle first:pl-4 sm:first:pl-5 last:pr-4 sm:last:pr-5'

/**
 * RHEA-190 m50: 管理 → 临时房间. Metadata only (code, owner, times, item count, PIN): there is deliberately
 * no way to open a room's contents from here. Admins can close/reopen, delete, or clear a PIN lockout.
 */
export function AdminRooms() {
  const now = useClock(0)
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setRooms((await api<{ rooms: AdminRoom[] }>('/api/admin/rooms')).rooms)
  }, [])

  useEffect(() => {
    load().catch((error: unknown) => toast.error(errorText(error)))
  }, [load])

  async function act(room: AdminRoom, path: string, method: 'POST' | 'DELETE', message: string) {
    setBusy(room.id)
    try {
      await api(`/api/admin/rooms/${encodeURIComponent(room.id)}${path}`, { method })
      toast.success(message)
      await load()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(null)
    }
  }

  if (!rooms) return <p className="text-sm text-muted-foreground">正在读取…</p>
  return (
    <div className="grid gap-4">
      <Note>这里只显示房间的元数据，管理员无法查看房间内容。关闭后房间码立即失效、在线连接断开，内容保留到过期；重新开放后恢复。删除会立即清除房间及其全部内容，不可撤销。</Note>
      <Panel title={`临时房间 · ${rooms.length}`} flush>
        {rooms.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="临时房间">
              <thead className="bg-surface-0">
                <tr className="border-b border-line-1">
                  <th className={thClass}>房间码</th>
                  <th className={thClass}>创建者</th>
                  <th className={thClass}>创建</th>
                  <th className={thClass}>最后活跃</th>
                  <th className={thClass}>内容</th>
                  <th className={thClass}>PIN</th>
                  <th className={thClass}>状态</th>
                  <th className={thClass}>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((room) => (
                  <tr key={room.id} className={`border-b border-line-1 last:border-b-0 ${room.closed ? 'text-fg-3' : ''}`} data-admin-room={room.code ?? room.id}>
                    <td className={tdClass} data-l="房间码">
                      <code className="font-semibold">{room.code ?? '—'}</code>
                    </td>
                    <td className={`${tdClass} text-fg-2`} data-l="创建者">
                      {room.owner ?? (room.anonymous ? '匿名' : '—')}
                    </td>
                    <td className={`${tdClass} text-fg-2`} data-l="创建" title={new Date(room.createdAt).toLocaleString()}>
                      {room.createdAtEstimated ? '约 ' : ''}
                      {formatWhen(room.createdAt, now)}
                    </td>
                    <td className={`${tdClass} text-fg-2`} data-l="最后活跃">
                      {room.lastActiveAt ? formatWhen(room.lastActiveAt, now) : '—'}
                    </td>
                    <td className={`${tdClass} tabular-nums text-fg-2`} data-l="内容">
                      {room.itemCount} 条 · {formatBytes(room.bytes)}
                    </td>
                    <td className={tdClass} data-l="PIN">
                      {room.hasPin ? <StatusPill tone={room.lockedFor ? 'warn' : 'neutral'}>{room.lockedFor ? `已锁定 ${Math.ceil(room.lockedFor / 60)} 分钟` : '已设置'}</StatusPill> : <span className="text-fg-3">无</span>}
                    </td>
                    <td className={tdClass} data-l="状态">
                      <StatusPill tone={room.closed ? 'neutral' : 'good'}>{room.closed ? '已关闭' : '开放'}</StatusPill>
                      <small className="mt-0.5 block text-[11px] text-fg-4">{formatRemain(room.expiresAt - now)}</small>
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <div className="flex flex-wrap justify-end gap-2">
                        {room.lockedFor ? (
                          <Button type="button" variant="outline" size="sm" disabled={busy === room.id} onClick={() => void act(room, '/unlock', 'POST', 'PIN 锁定已解除')}>
                            解除锁定
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy === room.id}
                          onClick={() => void act(room, room.closed ? '/reopen' : '/close', 'POST', room.closed ? '房间已重新开放' : '房间已关闭')}
                        >
                          {room.closed ? '重新开放' : '关闭'}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={busy === room.id}
                          onClick={() => {
                            if (!window.confirm(`删除房间 ${room.code ?? ''}？房间内的全部内容会被立即清除，不可撤销。`)) return
                            void act(room, '', 'DELETE', '房间已删除')
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 py-3.5 text-sm text-muted-foreground sm:px-5">现在没有临时房间。</p>
        )}
      </Panel>
    </div>
  )
}

import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import { setRoomCode } from '@/lib/temp-room.ts'

/** RHEA-190 auth step 3: shows the room code and lets the browser that owns the room change its code and PIN. */
export function RoomCodeBar({
  token,
  code,
  hasPin,
  owner,
  onChanged,
}: {
  token: string
  code: string | null
  hasPin: boolean
  owner: boolean
  onChanged: (next: { code: string; hasPin: boolean }) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draftCode, setDraftCode] = useState('')
  const [draftPin, setDraftPin] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const next = await setRoomCode(token, draftCode.trim() || undefined, draftPin || undefined)
      onChanged(next)
      setEditing(false)
      toast.success('房间码已更新')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 border border-line-2 px-3 py-2 text-sm" data-room-code="">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">房间码</span>
        <code className="text-base font-semibold tracking-wide">{code ?? '未设置'}</code>
        {hasPin ? <span className="text-xs text-muted-foreground">已设置 PIN</span> : null}
        {code ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void copyText(code).then(() => toast.success('房间码已复制'))}>
            复制房间码
          </Button>
        ) : null}
        {owner ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={editing}
            onClick={() => {
              setEditing((open) => !open)
              setDraftCode(code ?? '')
              setDraftPin('')
            }}
          >
            {editing ? '取消' : '自定义房间码'}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <form className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" onSubmit={(event) => void save(event)}>
          <label className={labelClass}>
            自定义房间码（3–32 位字母、数字、- 或 _，区分大小写；留空则随机生成 5 位）
            <input className={fieldClass} value={draftCode} maxLength={32} autoCapitalize="none" spellCheck={false} onChange={(event) => setDraftCode(event.target.value)} />
          </label>
          <label className={labelClass}>
            PIN（可选，4–32 位，需要自定义房间码）
            <input className={fieldClass} type="password" autoComplete="off" value={draftPin} maxLength={32} onChange={(event) => setDraftPin(event.target.value)} />
          </label>
          <Button type="submit" disabled={busy || (Boolean(draftPin) && !draftCode.trim())}>
            保存
          </Button>
          <p className="text-xs text-muted-foreground sm:col-span-3">拿到房间链接的人不需要 PIN；PIN 只用于「输入房间码」进入。</p>
        </form>
      ) : null}
    </div>
  )
}

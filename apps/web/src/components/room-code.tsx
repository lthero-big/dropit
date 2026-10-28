import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import { setRoomCode } from '@/lib/temp-room.ts'

/**
 * RHEA-190 auth step 4: a room has one code and its link is /r/<code>. Shows the code and lets the browser
 * that owns the room change the code (custom, or a fresh random one) and set or remove the PIN.
 */
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

  async function change(next: { code?: string | null; pin?: string | null }, message: string) {
    setBusy(true)
    try {
      const saved = await setRoomCode(token, next)
      onChanged({ code: saved.code, hasPin: saved.hasPin })
      setDraftPin('')
      setDraftCode(saved.code)
      toast.success(message)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  function saveCode(event: FormEvent) {
    event.preventDefault()
    const next = draftCode.trim()
    if (!next || next === code) return
    void change({ code: next }, '房间码已更新，链接也随之改变')
  }
  function savePin(event: FormEvent) {
    event.preventDefault()
    if (!draftPin) return
    void change({ pin: draftPin }, hasPin ? 'PIN 已更新' : 'PIN 已设置')
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
            {editing ? '收起' : '房间码与 PIN'}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-3 grid gap-4">
          <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end" onSubmit={saveCode} aria-label="修改房间码">
            <label className={labelClass}>
              自定义房间码（3–32 位字母、数字、- 或 _，区分大小写）
              <input className={fieldClass} value={draftCode} maxLength={32} autoCapitalize="none" spellCheck={false} onChange={(event) => setDraftCode(event.target.value)} />
            </label>
            <Button type="submit" disabled={busy || !draftCode.trim() || draftCode.trim() === code}>
              保存房间码
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void change({ code: null }, '已换成新的随机房间码')}>
              随机生成
            </Button>
          </form>
          <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end" onSubmit={savePin} aria-label="设置 PIN">
            <label className={labelClass}>
              {hasPin ? '新 PIN（4–32 位）' : 'PIN（可选，4–32 位）'}
              <input className={fieldClass} type="password" autoComplete="off" value={draftPin} maxLength={32} onChange={(event) => setDraftPin(event.target.value)} />
            </label>
            <Button type="submit" disabled={busy || draftPin.length < 4}>
              {hasPin ? '更新 PIN' : '设置 PIN'}
            </Button>
            {hasPin ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void change({ pin: null }, 'PIN 已移除')}>
                移除 PIN
              </Button>
            ) : null}
          </form>
          <p className="text-xs text-muted-foreground">
            房间码就是房间链接（/r/房间码）。改码后旧码和旧链接失效。设置 PIN 后，用房间码或打开链接进入都要输入 PIN；你自己和已经进入过的设备不会被再次询问。
          </p>
        </div>
      ) : null}
    </div>
  )
}

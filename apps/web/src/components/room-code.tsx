import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Modal } from '@/components/modal.tsx'
import { fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import { setRoomCode } from '@/lib/temp-room.ts'

/** RHEA-190 m50: a code the owner picks is exactly 6 letters or digits, case-sensitive (the server checks the same). */
const ROOM_CODE_PATTERN = /^[A-Za-z0-9]{6}$/

/**
 * RHEA-190 auth step 4 / m50: a room has one code and its link is /r/<code>. Shows the code; the browser that
 * owns the room changes it in a popup (6 characters, or a fresh random one; the old code stops working at once)
 * and sets or removes the PIN there.
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
  const [open, setOpen] = useState(false)

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
          <Button type="button" variant="outline" size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            修改房间码
          </Button>
        ) : null}
      </div>
      {open ? <RoomCodeDialog token={token} code={code} hasPin={hasPin} onChanged={onChanged} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

function RoomCodeDialog({
  token,
  code,
  hasPin,
  onChanged,
  onClose,
}: {
  token: string
  code: string | null
  hasPin: boolean
  onChanged: (next: { code: string; hasPin: boolean }) => void
  onClose: () => void
}) {
  const [draftCode, setDraftCode] = useState(code && ROOM_CODE_PATTERN.test(code) ? code : '')
  const [draftPin, setDraftPin] = useState('')
  const [busy, setBusy] = useState(false)
  const trimmed = draftCode.trim()
  const valid = ROOM_CODE_PATTERN.test(trimmed)

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
    if (!valid || trimmed === code) return
    void change({ code: trimmed }, '房间码已更新，旧房间码和旧链接已失效')
  }
  function savePin(event: FormEvent) {
    event.preventDefault()
    if (!draftPin) return
    void change({ pin: draftPin }, hasPin ? 'PIN 已更新' : 'PIN 已设置')
  }

  return (
    <Modal title="修改房间码" onClose={onClose}>
      <div className="grid gap-5">
        <p className="text-sm">
          当前房间码 <code className="font-semibold tracking-wide">{code ?? '未设置'}</code>
          {hasPin ? <span className="ml-2 text-xs text-muted-foreground">已设置 PIN</span> : null}
        </p>
        <form className="grid gap-2" onSubmit={saveCode} aria-label="修改房间码">
          <label className={labelClass}>
            新房间码（6 位字母或数字，区分大小写）
            <input
              className={`${fieldClass} font-mono tracking-widest`}
              value={draftCode}
              maxLength={6}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="例如 k7Rm2x"
              aria-invalid={trimmed.length > 0 && !valid}
              onChange={(event) => setDraftCode(event.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 6))}
            />
          </label>
          {trimmed.length > 0 && !valid ? <p className="text-xs text-destructive">还差 {6 - trimmed.length} 位：房间码需要正好 6 位字母或数字。</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !valid || trimmed === code}>
              保存房间码
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void change({ code: null }, '已换成新的随机房间码，旧房间码已失效')}>
              随机生成
            </Button>
          </div>
        </form>
        <form className="grid gap-2" onSubmit={savePin} aria-label="设置 PIN">
          <label className={labelClass}>
            {hasPin ? '新 PIN（4–32 位）' : 'PIN（可选，4–32 位）'}
            <input className={fieldClass} type="password" autoComplete="off" value={draftPin} maxLength={32} onChange={(event) => setDraftPin(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || draftPin.length < 4}>
              {hasPin ? '更新 PIN' : '设置 PIN'}
            </Button>
            {hasPin ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void change({ pin: null }, 'PIN 已移除')}>
                移除 PIN
              </Button>
            ) : null}
          </div>
        </form>
        <p className="text-xs text-muted-foreground">
          房间码就是房间链接（/r/房间码）。改码后旧码和旧链接立即失效。设置 PIN 后，用房间码或打开链接进入都要输入 PIN；你自己和已经进入过的设备不会被再次询问。
        </p>
      </div>
    </Modal>
  )
}

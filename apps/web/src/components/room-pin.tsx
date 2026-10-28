import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { ApiError, errorText } from '@/lib/api.ts'
import { enterRoomByCode, type RoomEntry } from '@/lib/temp-room.ts'

/** RHEA-190 auth step 4: the PIN prompt shown when /r/<code> is opened and the room has a PIN. */
export function RoomPinForm({ code, onEntered }: { code: string; onEntered: (entry: RoomEntry) => void }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!pin) return
    setBusy(true)
    setError(null)
    try {
      onEntered(await enterRoomByCode(code, pin))
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PIN_INVALID') setError('PIN 不对。')
      else if (caught instanceof ApiError && caught.status === 429) setError(`尝试次数太多，请${caught.retryAfter ? ` ${caught.retryAfter} 秒` : '稍'}后再试。`)
      else if (caught instanceof ApiError && caught.code === 'NOT_FOUND') setError('房间不存在或已过期。')
      else setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="grid gap-3" onSubmit={(event) => void submit(event)} aria-label="输入 PIN">
      <label className={labelClass}>
        PIN
        <input className={fieldClass} type="password" autoComplete="off" autoFocus value={pin} maxLength={256} onChange={(event) => setPin(event.target.value)} />
      </label>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy || !pin}>
          进入房间
        </Button>
      </div>
    </form>
  )
}

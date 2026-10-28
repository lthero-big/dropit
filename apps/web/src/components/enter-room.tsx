import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { ApiError, errorText } from '@/lib/api.ts'
import { enterRoomByCode } from '@/lib/temp-room.ts'

/** RHEA-190 auth step 3: join a temporary room with its (case-sensitive) code, and the PIN when it has one. */
export function EnterRoomForm({ initialCode = '' }: { initialCode?: string }) {
  const navigate = useNavigate()
  const [code, setCode] = useState(initialCode)
  const [pin, setPin] = useState('')
  const [needPin, setNeedPin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!code.trim()) return
    setBusy(true)
    setError(null)
    try {
      const entry = await enterRoomByCode(code.trim(), needPin ? pin : undefined)
      navigate(`/r/${entry.token}`)
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PIN_REQUIRED') {
        setNeedPin(true)
        setError('这个房间设置了 PIN，请输入。')
      } else if (caught instanceof ApiError && caught.code === 'NOT_FOUND') {
        setNeedPin(false)
        setError('没有这个房间码，或房间已过期。注意区分大小写。')
      } else if (caught instanceof ApiError && caught.code === 'PIN_INVALID') {
        setError('PIN 不对。')
      } else {
        setError(errorText(caught))
        toast.error(errorText(caught))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="grid gap-3" onSubmit={(event) => void submit(event)} aria-label="输入房间码">
      <label className={labelClass}>
        房间码
        <input
          className={fieldClass}
          value={code}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          placeholder="例如 k7Rm2"
          onChange={(event) => {
            setCode(event.target.value)
            setNeedPin(false)
            setPin('')
            setError(null)
          }}
        />
      </label>
      {needPin ? (
        <label className={labelClass}>
          PIN
          <input className={fieldClass} type="password" autoComplete="off" value={pin} maxLength={256} onChange={(event) => setPin(event.target.value)} />
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy || !code.trim() || (needPin && !pin)}>
          进入房间
        </Button>
      </div>
    </form>
  )
}

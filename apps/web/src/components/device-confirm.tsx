import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api, errorText } from '@/lib/api.ts'
import { formatRemain, useClock } from '@/lib/format.ts'
import { lifetimeText, normalizeUserCode, parseDeviceEntry, scopeLabel } from '@/lib/machine.ts'
import type { DeviceRequest } from '@/lib/types.ts'

type Phase = 'form' | 'preview' | 'allowed' | 'denied'

async function fetchDevice(userCode: string, verificationId: string | null): Promise<DeviceRequest> {
  const params = new URLSearchParams({ user_code: userCode })
  if (verificationId) params.set('verification_id', verificationId)
  return api<DeviceRequest>(`/api/auth/device?${params}`)
}

export function DeviceConfirm({
  initialCode,
  initialVerificationId,
  auto,
}: {
  initialCode: string
  initialVerificationId: string | null
  auto: boolean
}) {
  const now = useClock(0)
  const [code, setCode] = useState(() => normalizeUserCode(initialCode))
  const [verificationId, setVerificationId] = useState(initialVerificationId)
  const [phase, setPhase] = useState<Phase>('form')
  const [device, setDevice] = useState<DeviceRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const request = useRef(0)

  useEffect(() => {
    if (!auto) return
    const userCode = normalizeUserCode(initialCode)
    if (userCode.replaceAll('-', '').length !== 8) return
    const current = ++request.current
    setBusy(true)
    fetchDevice(userCode, initialVerificationId)
      .then((body) => {
        if (request.current !== current) return
        setDevice(body)
        setCode(userCode)
        setPhase('preview')
      })
      .catch((error: unknown) => {
        if (request.current !== current) return
        if (error instanceof ApiError && error.status === 404) setNotice('代码无效、已过期或已处理')
        else toast.error(errorText(error))
      })
      .finally(() => {
        if (request.current === current) setBusy(false)
      })
    return () => {
      request.current += 1
    }
  }, [auto, initialCode, initialVerificationId])

  function onCodeChange(value: string) {
    request.current += 1
    setBusy(false)
    const parsed = parseDeviceEntry(value)
    setCode(parsed.code)
    if ('verificationId' in parsed) setVerificationId(parsed.verificationId ?? null)
    setPhase('form')
    setDevice(null)
    setNotice(null)
  }

  async function lookup() {
    const userCode = normalizeUserCode(code)
    if (userCode.replaceAll('-', '').length !== 8) {
      setNotice('请输入 8 位设备码')
      return
    }
    const current = ++request.current
    setBusy(true)
    setNotice(null)
    try {
      const body = await fetchDevice(userCode, verificationId)
      if (request.current !== current) return
      setDevice(body)
      setCode(userCode)
      setPhase('preview')
    } catch (error) {
      if (request.current !== current) return
      setDevice(null)
      setPhase('form')
      if (error instanceof ApiError && error.status === 404) setNotice('代码无效、已过期或已处理')
      else toast.error(errorText(error))
    } finally {
      if (request.current === current) setBusy(false)
    }
  }

  async function decide(action: 'approve' | 'deny') {
    setBusy(true)
    setNotice(null)
    try {
      await api(`/api/auth/device/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_code: code,
          ...(verificationId ? { verification_id: verificationId } : {}),
        }),
      })
      setPhase(action === 'approve' ? 'allowed' : 'denied')
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setNotice('代码无效、已过期或已处理')
      else toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border-2 border-foreground p-4">
      <h2 className="text-xs font-extrabold tracking-widest uppercase">设备码</h2>
      <p className="mt-2 text-sm text-muted-foreground">核对终端上的代码、设备名和网络概要后再允许。允许后，令牌要等终端领取才会创建。</p>
      <form
        className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault()
          void lookup()
        }}
      >
        <label className="grow text-xs font-extrabold tracking-widest uppercase">
          用户码
          <input
            className="mt-1 block w-full border-2 border-foreground bg-background px-3 py-2 font-mono text-lg font-black tracking-[0.3em] normal-case"
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            aria-describedby="device-code-hint"
            placeholder="ABCD-EFGH"
          />
        </label>
        <Button type="submit" variant="outline" disabled={busy}>
          查询
        </Button>
      </form>
      <p id="device-code-hint" className="mt-2 text-xs text-muted-foreground">
        可以粘贴确认链接。大小写和空格会被忽略。
        {verificationId ? ' 当前代码绑定到打开的确认链接。' : ''}
      </p>
      {notice ? (
        <p role="alert" className="mt-3 border-l-4 border-primary bg-secondary px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {phase === 'preview' && device ? (
        <div className="mt-4 border-2 border-foreground">
          <dl className="grid gap-px bg-foreground sm:grid-cols-2">
            <div className="bg-background p-3">
              <dt className="text-xs font-extrabold tracking-widest uppercase">设备名</dt>
              <dd className="mt-1 text-lg font-black break-all">{device.name}</dd>
            </div>
            <div className="bg-background p-3">
              <dt className="text-xs font-extrabold tracking-widest uppercase">网络概要</dt>
              <dd className="mt-1 font-mono text-sm">{device.ipSummary}</dd>
            </div>
            <div className="bg-background p-3">
              <dt className="text-xs font-extrabold tracking-widest uppercase">权限</dt>
              <dd className="mt-1 text-sm">{device.scopes.map(scopeLabel).join('、')}</dd>
            </div>
            <div className="bg-background p-3">
              <dt className="text-xs font-extrabold tracking-widest uppercase">令牌有效期</dt>
              <dd className="mt-1 text-sm">{lifetimeText(device.tokenExpiresInDays)}</dd>
            </div>
            <div className="bg-background p-3 sm:col-span-2">
              <dt className="text-xs font-extrabold tracking-widest uppercase">申请剩余</dt>
              <dd className="mt-1 text-sm">{formatRemain(device.expiresAt - now)}</dd>
            </div>
          </dl>
          <div className="flex flex-col gap-2 border-t-2 border-foreground p-3 sm:flex-row">
            <Button type="button" disabled={busy} onClick={() => void decide('approve')}>
              允许
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void decide('deny')}>
              拒绝
            </Button>
          </div>
        </div>
      ) : null}
      {phase === 'allowed' ? (
        <p role="status" className="mt-4 border-l-4 border-foreground bg-secondary px-3 py-2 text-sm">
          已允许。回到终端完成登录。令牌被领取后会出现在设置里，可以在那里撤销。
        </p>
      ) : null}
      {phase === 'denied' ? (
        <p role="status" className="mt-4 border-l-4 border-primary bg-secondary px-3 py-2 text-sm">
          已拒绝。这台设备拿不到令牌。
        </p>
      ) : null}
    </section>
  )
}

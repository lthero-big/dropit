import { Link, useSearchParams } from 'react-router'
import { EnterRoomForm } from '@/components/enter-room.tsx'
import { Shell } from '@/components/shell.tsx'

/** RHEA-190 auth step 3: /join (optionally /join?code=…) — enter a temporary room by code. */
export function JoinPage() {
  const [params] = useSearchParams()
  return (
    <Shell>
      <h1 className="text-4xl font-semibold">输入房间码</h1>
      <p className="mt-4 max-w-md text-sm text-muted-foreground">房间码区分大小写。无需登录；房间有 PIN 时会再问一次。</p>
      <div className="mt-6 max-w-sm">
        <EnterRoomForm initialCode={params.get('code') ?? ''} />
      </div>
      <Link to="/" className="mt-6 inline-block text-sm font-medium">
        返回
      </Link>
    </Shell>
  )
}

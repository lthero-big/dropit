import { Link, useLocation } from 'react-router'
import { Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'

/** Any address the app does not know (the server answers these with 404 too). */
export function NotFoundPage() {
  const oldRoomLink = /^\/rooms\//.test(useLocation().pathname)
  return (
    <Shell>
      <h1 className="text-4xl font-semibold">页面不存在</h1>
      <p className="mt-4 max-w-md text-sm text-muted-foreground">{oldRoomLink ? '房间不存在：旧的长房间链接已经停用。' : '这个地址不存在。'}临时房间的链接是 /r/&lt;房间码&gt;，可以向对方要房间码或新的链接。</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="button" variant="outline" asChild>
          <Link to="/">返回首页</Link>
        </Button>
      </div>
    </Shell>
  )
}

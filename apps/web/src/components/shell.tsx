import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { api, errorText } from '@/lib/api.ts'
import { connectionText, spaceLabel } from '@/lib/format.ts'
import { useSession } from '@/lib/session.tsx'
import type { ConnectionStatus, SpaceSummary } from '@/lib/types.ts'
import { useTheme } from './theme-provider.tsx'

export function Shell({
  connection = 'idle',
  spaces = [],
  spaceId,
  onSpace,
  children,
}: {
  connection?: ConnectionStatus
  spaces?: SpaceSummary[]
  spaceId?: string
  onSpace?: (id: string) => void
  children: ReactNode
}) {
  const { me, logout } = useSession()
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const current = spaces.find((space) => space.id === spaceId)
  const initial = (me?.user.name || me?.user.email || '访客').slice(0, 1).toUpperCase()

  async function newRoom() {
    try {
      const room = await api<{ token: string }>('/api/rooms', { method: 'POST' })
      navigate(`/rooms/${room.token}`)
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b-2 border-foreground bg-background">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 md:px-8">
          <Link to="/" className="text-[22px] font-black tracking-tight">
            dropit
          </Link>
          {me && current && onSpace ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" className="normal-case tracking-normal">
                  {spaceLabel(current, me.user.id, spaces)}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {spaces.map((space) => (
                  <DropdownMenuItem key={space.id} onSelect={() => onSpace(space.id)}>
                    {spaceLabel(space, me.user.id, spaces)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <nav className="hidden items-center gap-4 text-xs font-extrabold tracking-widest uppercase md:flex">
            <Link to="/" className={location.pathname === '/' ? 'border-b-2 border-primary' : ''}>
              剪贴板
            </Link>
            <button type="button" className="uppercase" onClick={() => void newRoom()}>
              临时房间
            </button>
            {me?.user.role === 'admin' ? (
              <Link to="/admin" className={location.pathname === '/admin' ? 'border-b-2 border-primary' : ''}>
                管理
              </Link>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <p className="hidden items-center gap-2 sm:flex" role="status">
              <span className="grid size-8 place-items-center border border-foreground text-xs font-black">{initial}</span>
              <span>
                <span className="block text-xs font-extrabold tracking-widest uppercase">本机</span>
                <span className="text-xs text-muted-foreground">{connectionText[connection]}</span>
              </span>
            </p>
            {me ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline">
                    {me.user.name || '账户'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setTheme('light')}>浅色{theme === 'light' ? ' · 当前' : ''}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setTheme('dark')}>深色{theme === 'dark' ? ' · 当前' : ''}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setTheme('system')}>跟随系统{theme === 'system' ? ' · 当前' : ''}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      void logout().then(() => navigate('/'))
                    }}
                  >
                    退出
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button type="button" variant="outline" onClick={() => navigate('/login')}>
                登录
              </Button>
            )}
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-[1240px] px-4 pt-6 pb-24 md:px-8 md:pb-12">{children}</div>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t-2 border-foreground bg-background md:hidden">
        <Link to="/" className="py-3 text-center text-xs font-extrabold tracking-widest uppercase">
          剪贴板
        </Link>
        <button type="button" className="py-3 text-xs font-extrabold tracking-widest uppercase" onClick={() => void newRoom()}>
          房间
        </button>
        {me?.user.role === 'admin' ? (
          <Link to="/admin" className="py-3 text-center text-xs font-extrabold tracking-widest uppercase">
            管理
          </Link>
        ) : (
          <Link to="/login" className="py-3 text-center text-xs font-extrabold tracking-widest uppercase">
            登录
          </Link>
        )}
      </nav>
    </div>
  )
}

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="mb-6 border-b-2 border-foreground pb-3">
      <h1 className="border-l-[14px] border-primary pl-4 text-4xl font-black tracking-tight md:text-[56px] md:leading-none">
        {title}
      </h1>
      {sub ? <p className="mt-3 text-sm text-muted-foreground">{sub}</p> : null}
    </header>
  )
}

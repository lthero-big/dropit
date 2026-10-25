import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { LogOutIcon, MoonIcon, SettingsIcon, ShieldIcon, SunIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { api, errorText } from '@/lib/api.ts'
import { formatBytes, quotaTone, spaceLabel } from '@/lib/format.ts'
import { useSession } from '@/lib/session.tsx'
import type { SpaceSummary } from '@/lib/types.ts'
import { useTheme } from './theme-provider.tsx'

const themeIconClass = 'inline-flex size-10 shrink-0 items-center justify-center border-2 border-foreground bg-background text-foreground hover:bg-foreground hover:text-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
const menuItemClass = 'min-h-10 rounded-none px-3 text-sm font-bold tracking-normal normal-case'

export function Shell({
  spaces = [],
  spaceId,
  onSpace,
  children,
}: {
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
  const displayName = me?.user.name || me?.user.email || '访客'
  const initial = displayName.slice(0, 1).toUpperCase()
  const [menuOpen, setMenuOpen] = useState(false)
  const [drawer, setDrawer] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const sync = () => setDrawer(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!menuOpen || !drawer) return
    const previous = document.activeElement
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [drawer, menuOpen])

  function cycleTheme() {
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    setTheme(resolved === 'dark' ? 'light' : 'dark')
  }

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
        <div className="mx-auto flex max-w-[1240px] items-center gap-x-3 gap-y-3 px-4 py-3 md:flex-wrap md:gap-x-5 md:px-8">
          <Link to="/" className="shrink-0 text-[22px] font-black tracking-tight">
            dropit
          </Link>
          {me && current && onSpace ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" className="max-w-[9rem] truncate normal-case tracking-normal">
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
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" className={themeIconClass} aria-label="切换主题" title={theme === 'dark' ? '当前深色，点击切换到浅色' : theme === 'light' ? '当前浅色，点击切换到深色' : '跟随系统，点击切换'} onClick={cycleTheme}>
              {theme === 'dark' ? <SunIcon className="size-4" aria-hidden="true" /> : <MoonIcon className="size-4" aria-hidden="true" />}
            </button>
            {me ? (
              drawer ? (
                <>
                  <button
                    type="button"
                    aria-label="账户菜单"
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    className="inline-flex h-10 max-w-[11rem] items-center gap-2 border-2 border-foreground bg-background px-1.5 text-foreground hover:bg-foreground hover:text-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    onClick={() => setMenuOpen(true)}
                  >
                    <span className="grid size-7 shrink-0 place-items-center bg-foreground text-xs font-black text-background" aria-hidden="true">
                      {initial}
                    </span>
                  </button>
                  {menuOpen ? (
                    <AccountDrawer
                      name={displayName}
                      email={me.user.email}
                      role={me.user.role}
                      usedBytes={me.usedBytes}
                      quotaBytes={me.quotaBytes}
                      onClose={() => setMenuOpen(false)}
                      onNavigate={(path) => {
                        setMenuOpen(false)
                        navigate(path)
                      }}
                      onLogout={() => {
                        setMenuOpen(false)
                        void logout().then(() => navigate('/'))
                      }}
                    />
                  ) : null}
                </>
              ) : (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="账户菜单"
                    className="inline-flex h-10 max-w-[11rem] items-center gap-2 border-2 border-foreground bg-background px-1.5 text-foreground hover:bg-foreground hover:text-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <span className="grid size-7 shrink-0 place-items-center bg-foreground text-xs font-black text-background" aria-hidden="true">
                      {initial}
                    </span>
                    <span className="hidden min-w-0 truncate text-xs font-extrabold tracking-wide lg:block">{displayName}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-64 p-0" onCloseAutoFocus={(event) => event.preventDefault()}>
                  <AccountMenuBody
                    name={displayName}
                    email={me.user.email}
                    role={me.user.role}
                    usedBytes={me.usedBytes}
                    quotaBytes={me.quotaBytes}
                    onNavigate={(path) => {
                      setMenuOpen(false)
                      navigate(path)
                    }}
                    onLogout={() => {
                      setMenuOpen(false)
                      void logout().then(() => navigate('/'))
                    }}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
              )
            ) : (
              <Button type="button" variant="outline" className="h-10" onClick={() => navigate('/login')}>
                登录
              </Button>
            )}
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-[1240px] px-4 pt-6 pb-24 md:px-8 md:pb-12">{children}</div>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-2 border-t-2 border-foreground bg-background md:hidden">
        <Link to="/" className="flex min-h-11 items-center justify-center text-xs font-extrabold tracking-widest uppercase">
          剪贴板
        </Link>
        <button type="button" className="min-h-11 text-xs font-extrabold tracking-widest uppercase" onClick={() => void newRoom()}>
          房间
        </button>
      </nav>
    </div>
  )
}

function AccountDrawer({
  name,
  email,
  role,
  usedBytes,
  quotaBytes,
  onNavigate,
  onLogout,
  onClose,
}: {
  name: string
  email: string
  role: 'admin' | 'user'
  usedBytes: number
  quotaBytes: number
  onNavigate: (path: string) => void
  onLogout: () => void
  onClose: () => void
}) {
  const ratio = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0
  const tone = quotaTone(usedBytes, quotaBytes)
  const bar = tone === 'over' ? 'bg-destructive' : tone === 'warn' ? 'bg-[#b45309]' : 'bg-primary'
  return (
    <div className="fixed inset-0 z-50 flex items-end pb-16">
      <button type="button" aria-label="关闭账户菜单" className="absolute inset-0 bg-foreground/30" onClick={onClose} />
      <div role="dialog" aria-label="账户" className="relative w-full border-t-2 border-foreground bg-popover p-3 pb-4">
        <div className="px-3 py-3">
          <p className="truncate text-sm font-black tracking-tight">{name}</p>
          <p className="mt-0.5 truncate text-xs font-medium text-muted-foreground">{email}</p>
          <p className="mt-3 text-[10px] font-extrabold tracking-widest uppercase">配额</p>
          <p className="mt-1 text-xs font-bold">
            {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
          </p>
          <span
            className="mt-2 block h-1 bg-secondary"
            role="progressbar"
            aria-label="配额"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={ratio}
            data-quota-tone={tone}
          >
            <span className={`block h-full ${bar}`} style={{ width: `${ratio}%` }} />
          </span>
        </div>
        <div className="mt-1 border-t-2 border-foreground pt-1">
          <button type="button" className={`${menuItemClass} flex w-full items-center gap-1.5`} onClick={() => onNavigate('/settings')}>
            <SettingsIcon className="size-4" aria-hidden="true" />
            设置
          </button>
          {role === 'admin' ? (
            <button type="button" className={`${menuItemClass} flex w-full items-center gap-1.5`} onClick={() => onNavigate('/admin')}>
              <ShieldIcon className="size-4" aria-hidden="true" />
              管理
            </button>
          ) : null}
        </div>
        <div className="mt-1 border-t-2 border-foreground pt-1">
          <button type="button" className={`${menuItemClass} flex w-full items-center gap-1.5 text-destructive`} onClick={onLogout}>
            <LogOutIcon className="size-4" aria-hidden="true" />
            退出
          </button>
        </div>
      </div>
    </div>
  )
}

function AccountMenuBody({
  name,
  email,
  role,
  usedBytes,
  quotaBytes,
  onNavigate,
  onLogout,
}: {
  name: string
  email: string
  role: 'admin' | 'user'
  usedBytes: number
  quotaBytes: number
  onNavigate: (path: string) => void
  onLogout: () => void
}) {
  const ratio = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0
  const tone = quotaTone(usedBytes, quotaBytes)
  const bar = tone === 'over' ? 'bg-destructive' : tone === 'warn' ? 'bg-[#b45309]' : 'bg-primary'
  return (
    <>
      <DropdownMenuLabel className="px-3 py-3 text-foreground">
        <span className="block truncate text-sm font-black tracking-tight normal-case">{name}</span>
        <span className="mt-0.5 block truncate text-xs font-medium text-muted-foreground normal-case">{email}</span>
        <span className="mt-3 block text-[10px] font-extrabold tracking-widest uppercase">配额</span>
        <span className="mt-1 block text-xs font-bold normal-case">
          {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
        </span>
        <span
          className="mt-2 block h-1 bg-secondary"
          role="progressbar"
          aria-label="配额"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ratio}
          data-quota-tone={tone}
        >
          <span className={`block h-full ${bar}`} style={{ width: `${ratio}%` }} />
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem className={menuItemClass} onSelect={() => onNavigate('/settings')}>
          <SettingsIcon className="size-4" aria-hidden="true" />
          设置
        </DropdownMenuItem>
        {role === 'admin' ? (
          <DropdownMenuItem className={menuItemClass} onSelect={() => onNavigate('/admin')}>
            <ShieldIcon className="size-4" aria-hidden="true" />
            管理
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem className={menuItemClass} variant="destructive" onSelect={onLogout}>
        <LogOutIcon className="size-4" aria-hidden="true" />
        退出
      </DropdownMenuItem>
    </>
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

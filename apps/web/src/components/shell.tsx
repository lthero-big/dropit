import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { CheckIcon, ChevronDownIcon, LogOutIcon, MoonIcon, SettingsIcon, ShieldIcon, SunIcon } from 'lucide-react'
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
import { errorText } from '@/lib/api.ts'
import { openTempRoom } from '@/lib/temp-room.ts'
import { formatBytes, quotaTone, spaceLabel } from '@/lib/format.ts'
import { useSession } from '@/lib/session.tsx'
import type { SpaceSummary } from '@/lib/types.ts'
import { PRESENCE_SLOT } from '@/lib/device.ts'
import { Logo } from './logo.tsx'
import { useTheme } from './theme-provider.tsx'

const themeIconClass = 'inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-line-2 bg-background text-foreground hover:bg-surface-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
const menuItemClass = 'min-h-10 min-w-10 rounded-none px-3 text-sm font-bold tracking-normal normal-case'
const menuItemStyle = { minHeight: 40, minWidth: 40 }
const hitTarget = { minHeight: 40, minWidth: 40 }

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
    if (resolved === 'dark') setTheme('light')
    else setTheme('dark')
  }

  async function newRoom() {
    try {
      const room = await openTempRoom()
      navigate(`/rooms/${room.token}`)
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="dd-noselect sticky top-0 z-40 border-b border-line-1 bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex min-h-14 max-w-[1120px] items-center gap-x-2 px-3 py-1.5 sm:gap-x-3 sm:px-6">
          <Link to="/" aria-label="dropit" className="flex min-h-10 shrink-0 items-center no-underline">
            <Logo />
          </Link>
          {/* the board portals its named presence dots here (RHEA-190 step 5) */}
          <div id={PRESENCE_SLOT} className="flex min-w-0 items-center" />
          {me && current && onSpace ? (
            // RHEA-190 r4: this is a *space switcher*, not a "create space" menu.
            // dropit has no public spaces: every account owns one 私人空间 and may
            // also belong to spaces it was invited into. With a single space there
            // is nothing to switch to, so it renders as a plain label.
            spaces.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 min-h-10 min-w-10 max-w-[10rem] gap-1 truncate normal-case tracking-normal"
                    style={hitTarget}
                    title="切换空间"
                    data-space-switcher=""
                  >
                    <span className="truncate">{spaceLabel(current, me.user.id, spaces)}</span>
                    <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-56">
                  <DropdownMenuLabel className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground normal-case">切换空间</DropdownMenuLabel>
                  {spaces.map((space) => (
                    <DropdownMenuItem key={space.id} className="gap-2 normal-case tracking-normal" onSelect={() => onSpace(space.id)}>
                      <CheckIcon className={`size-3.5 shrink-0 ${space.id === current.id ? '' : 'invisible'}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{spaceLabel(space, me.user.id, spaces)}</span>
                      <span className="text-[11px] text-muted-foreground">{space.ownerId === me.user.id ? '我的' : '受邀加入'}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <p className="max-w-64 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">只列出你的私人空间和受邀加入的空间。dropit 没有公开空间，也不能在这里新建空间。</p>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span
                className="inline-flex h-10 min-h-10 max-w-[10rem] items-center truncate rounded-md border border-line-1 px-3 text-sm font-medium text-fg-2"
                style={hitTarget}
                title="只有你和你登录的设备能看到这个空间"
                data-space-label=""
              >
                {spaceLabel(current, me.user.id, spaces)}
              </span>
            )
          ) : null}
          <nav className="hidden items-center gap-4 text-xs font-medium text-fg-2 md:flex">
            <Link to="/" className={location.pathname === '/' ? 'border-b border-primary' : ''}>
              剪贴板
            </Link>
            <button type="button" className="inline-flex min-h-10 min-w-10 items-center" style={hitTarget} onClick={() => void newRoom()}>
              临时房间
            </button>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" className={themeIconClass} style={hitTarget} aria-label="切换主题" title={theme === 'dark' ? '当前深色，点击切换到浅色' : theme === 'light' ? '当前浅色，点击切换到深色' : '跟随系统，点击切换'} onClick={cycleTheme}>
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
                    className="inline-flex h-10 min-h-10 min-w-10 max-w-[11rem] items-center gap-2 rounded-md border border-line-2 bg-background px-1.5 text-foreground hover:bg-surface-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    style={hitTarget}
                    onClick={() => setMenuOpen(true)}
                  >
                    <span className="grid size-7 shrink-0 place-items-center bg-foreground text-xs font-semibold text-background" aria-hidden="true">
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
                    className="inline-flex h-10 min-h-10 min-w-10 max-w-[11rem] items-center gap-2 rounded-md border border-line-2 bg-background px-1.5 text-foreground hover:bg-surface-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    style={hitTarget}
                  >
                    <span className="grid size-7 shrink-0 place-items-center bg-foreground text-xs font-semibold text-background" aria-hidden="true">
                      {initial}
                    </span>
                    <span className="hidden min-w-0 truncate text-xs font-medium tracking-wide lg:block">{displayName}</span>
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
              <Button type="button" variant="outline" className="h-10 min-h-10 min-w-10" style={hitTarget} onClick={() => navigate('/login')}>
                登录
              </Button>
            )}
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-[1120px] px-4 pt-5 pb-24 sm:px-6 md:pb-12">{children}</div>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-2 border-t border-line-1 bg-[color-mix(in_oklab,var(--bg)_88%,transparent)] pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden" data-shell-nav="">
        <Link to="/" className="flex min-h-11 items-center justify-center text-xs font-medium">
          剪贴板
        </Link>
        <button type="button" className="min-h-11 min-w-10 text-xs font-medium" style={hitTarget} onClick={() => void newRoom()}>
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
      <div role="dialog" aria-label="账户" className="relative w-full border-t border-line-1 bg-popover p-3 pb-4">
        <div className="px-3 py-3">
          <p className="truncate text-sm font-semibold tracking-tight">{name}</p>
          <p className="mt-0.5 truncate text-xs font-medium text-muted-foreground">{email}</p>
          <p className="mt-3 text-[10px] font-medium">配额</p>
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
        <div className="mt-1 border-t border-line-1 pt-1">
          <button type="button" className={`${menuItemClass} flex w-full items-center gap-1.5`} style={menuItemStyle} onClick={() => onNavigate('/settings')}>
            <SettingsIcon className="size-4" aria-hidden="true" />
            设置
          </button>
          {role === 'admin' ? (
            <button type="button" className={`${menuItemClass} flex w-full items-center gap-1.5`} style={menuItemStyle} onClick={() => onNavigate('/admin')}>
              <ShieldIcon className="size-4" aria-hidden="true" />
              管理
            </button>
          ) : null}
        </div>
        <div className="mt-1 border-t border-line-1 pt-1">
          <button type="button" className={`${menuItemClass} flex w-full items-center gap-1.5 text-destructive`} style={menuItemStyle} onClick={onLogout}>
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
        <span className="block truncate text-sm font-semibold tracking-tight normal-case">{name}</span>
        <span className="mt-0.5 block truncate text-xs font-medium text-muted-foreground normal-case">{email}</span>
        <span className="mt-3 block text-[10px] font-medium">配额</span>
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
        <DropdownMenuItem className={menuItemClass} style={menuItemStyle} onSelect={() => onNavigate('/settings')}>
          <SettingsIcon className="size-4" aria-hidden="true" />
          设置
        </DropdownMenuItem>
        {role === 'admin' ? (
          <DropdownMenuItem className={menuItemClass} style={menuItemStyle} onSelect={() => onNavigate('/admin')}>
            <ShieldIcon className="size-4" aria-hidden="true" />
            管理
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem className={menuItemClass} style={menuItemStyle} variant="destructive" onSelect={onLogout}>
        <LogOutIcon className="size-4" aria-hidden="true" />
        退出
      </DropdownMenuItem>
    </>
  )
}

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="mb-6 border-b border-line-1 pb-3">
      <h1 className="text-3xl font-semibold tracking-tight text-fg md:text-[40px] md:leading-none">
        {title}
      </h1>
      {sub ? <p className="mt-3 text-sm text-muted-foreground">{sub}</p> : null}
    </header>
  )
}

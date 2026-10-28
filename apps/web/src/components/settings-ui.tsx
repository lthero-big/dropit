import { useId, useRef, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ArrowUpRightIcon } from 'lucide-react'
import { Link } from 'react-router'

/**
 * RHEA-190 m22: shared building blocks for 设置 / 管理.
 *
 * The old pages were plain text on the page background, so a label, a value and a
 * control all looked the same. These pieces separate the three:
 * - information lives in Panel / SettingRow text and in StatusPill (no border, soft fill, never clickable);
 * - actions are Buttons (border + shadow + hover) or Switches;
 * - inputs share `fieldClass` (sunken fill, hover border, focus ring);
 * - navigation is a grouped side nav with icons, hover and a clear selected state.
 * Everything uses the paper tokens, so the Bento / Swiss / 终端 skins still apply.
 */

export const fieldClass =
  'block w-full min-h-10 rounded-md border border-line-2 bg-surface-0 px-3 py-2 text-sm font-medium text-fg normal-case shadow-[inset_0_1px_1px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow,background-color] duration-[var(--dur-fast)] placeholder:font-normal placeholder:text-fg-4 hover:border-line-3 focus-visible:border-brand focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-3 disabled:hover:border-line-2 aria-invalid:border-destructive'
export const selectClass = `${fieldClass} dd-select cursor-pointer`
export const labelClass = 'grid gap-1.5 text-xs font-medium text-fg-2'

export interface NavItem<T extends string> {
  id: T
  label: string
  icon: LucideIcon
  hint?: string
}
export interface NavGroup<T extends string> {
  label: string
  items: NavItem<T>[]
}

const navItemClass =
  'group relative flex min-h-10 shrink-0 items-center gap-2.5 rounded-md border border-transparent px-2.5 text-left text-sm font-medium text-fg-2 no-underline transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary md:w-full'
const navActiveClass = '!border-line-2 !bg-surface-1 !text-fg shadow-elev-1'

function NavIcon({ icon: Icon, active }: { icon: LucideIcon; active: boolean }) {
  return <Icon className={`size-4 shrink-0 ${active ? 'text-brand' : 'text-fg-3 group-hover:text-fg-2'}`} aria-hidden="true" />
}

/** Grouped side nav. `tabs` mode switches panels (role=tab); `anchors` mode scrolls to sections. */
export function SideNav<T extends string>({
  label,
  groups,
  active,
  onSelect,
  mode,
  footer,
}: {
  label: string
  groups: NavGroup<T>[]
  active: T
  onSelect: (id: T) => void
  mode: 'tabs' | 'anchors'
  footer?: ReactNode
}) {
  const list = (
    <div
      className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:gap-0.5 md:overflow-visible md:p-0"
      {...(mode === 'tabs' ? { role: 'tablist', 'aria-label': label, 'aria-orientation': 'vertical' as const } : {})}
    >
      {groups.map((group, index) => (
        <div key={group.label} className="contents" role="presentation">
          <p
            aria-hidden="true"
            className={`hidden px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-4 md:block ${index === 0 ? 'pt-0' : 'pt-4'}`}
          >
            {group.label}
          </p>
          {group.items.map((item) => {
            const current = item.id === active
            const className = `${navItemClass} ${current ? navActiveClass : ''}`
            const inner = (
              <>
                {current ? <span aria-hidden="true" className="absolute inset-y-2 left-0 hidden w-0.5 rounded-full bg-brand md:block" /> : null}
                <NavIcon icon={item.icon} active={current} />
                <span className="min-w-0 truncate">{item.label}</span>
              </>
            )
            return mode === 'tabs' ? (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`tab-${item.id}`}
                aria-selected={current}
                aria-controls={`panel-${item.id}`}
                title={item.hint}
                data-nav-item={item.id}
                className={className}
                onClick={() => onSelect(item.id)}
              >
                {inner}
              </button>
            ) : (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={current ? 'location' : undefined}
                title={item.hint}
                data-nav-item={item.id}
                className={className}
                onClick={(event) => {
                  event.preventDefault()
                  onSelect(item.id)
                }}
              >
                {inner}
              </a>
            )
          })}
        </div>
      ))}
    </div>
  )
  return (
    <nav aria-label={label} className="min-w-0 md:sticky md:top-20 md:self-start" data-side-nav="">
      {list}
      {footer ? <div className="mt-4 hidden border-t border-line-1 pt-4 md:block">{footer}</div> : null}
    </nav>
  )
}

/** Nav-styled link that leaves the page (e.g. 设置 → 管理 · OAuth). */
export function NavLinkOut({ to, icon, children }: { to: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <Link to={to} className={navItemClass}>
      <NavIcon icon={icon} active={false} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ArrowUpRightIcon className="size-3.5 shrink-0 text-fg-4 group-hover:text-fg-2" aria-hidden="true" />
    </Link>
  )
}

/** Two columns on desktop: fixed-width nav + a content column whose width never depends on its content. */
export function SettingsLayout({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-5 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8" data-settings-layout="">
      {nav}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Heading of the active admin category. */
export function SectionHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
        {description ? <p className="mt-1 max-w-[60ch] text-sm text-fg-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

/** A card that groups related settings. Header = information, body = rows and controls. */
export function Panel({
  id,
  title,
  description,
  actions,
  children,
  flush = false,
  className = '',
  ...rest
}: {
  id?: string
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
} & Omit<ComponentProps<'section'>, 'title'>) {
  const titleId = id ? `${id}-title` : undefined
  return (
    <section
      id={id}
      aria-labelledby={title && titleId ? titleId : undefined}
      className={`mb-5 scroll-mt-24 overflow-hidden rounded-lg border border-line-1 bg-surface-1 shadow-elev-1 ${className}`}
      data-panel=""
      {...rest}
    >
      {title ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line-1 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-semibold text-fg">
              {title}
            </h2>
            {description ? <p className="mt-1 max-w-[68ch] text-[13px] leading-relaxed text-fg-3">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? '' : 'px-4 py-4 sm:px-5'}>{children}</div>
    </section>
  )
}

/** Label + description on the left, the control on the right. */
export function SettingRow({ title, description, children, htmlFor }: { title: ReactNode; description?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-3 border-b border-line-1 px-4 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
            {title}
          </label>
        ) : (
          <p className="text-sm font-medium text-fg">{title}</p>
        )}
        {description ? <p className="mt-0.5 text-[13px] text-fg-3">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{children}</div> : null}
    </div>
  )
}

export type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'brand'
const toneClass: Record<Tone, string> = {
  good: 'bg-ok-soft text-ok',
  bad: 'bg-brand-soft text-destructive',
  warn: 'bg-[color-mix(in_oklab,#b45309_14%,transparent)] text-[#b45309] dark:text-[#e0a165]',
  neutral: 'bg-surface-2 text-fg-3',
  brand: 'bg-brand-soft text-brand',
}

/** Read-only status. Pill shape, no border, no hover: it should never look like a button. */
export function StatusPill({ tone = 'neutral', children, className = '', ...rest }: { tone?: Tone; children: ReactNode } & ComponentProps<'span'>) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${toneClass[tone]} ${className}`} data-tone={tone} {...rest}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-80" />
      {children}
    </span>
  )
}

/** On/off switch. Still a native checkbox (keyboard + forms), announced as a switch. The whole card is the hit area. */
export function Switch({ label, description, className = '', id, ...props }: { label: ReactNode; description?: ReactNode } & Omit<ComponentProps<'input'>, 'type' | 'role'>) {
  const auto = useId()
  const inputId = id ?? auto
  const descId = description ? `${inputId}-desc` : undefined
  return (
    <div className={`relative flex items-center justify-between gap-4 rounded-md border border-line-2 bg-surface-0 px-3 py-2.5 transition-colors hover:border-line-3 hover:bg-surface-2 has-[:disabled]:opacity-60 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/35 ${className}`} data-switch-row="">
      <span className="min-w-0">
        <label htmlFor={inputId} className="block cursor-pointer text-sm font-medium text-fg after:absolute after:inset-0 after:content-['']">
          {label}
        </label>
        {description ? (
          <span id={descId} className="mt-0.5 block text-xs text-fg-3">
            {description}
          </span>
        ) : null}
      </span>
      <input id={inputId} type="checkbox" role="switch" aria-describedby={descId} className="dd-switch relative z-10" {...props} />
    </div>
  )
}

/** Selectable chip for multi-choice options (checkbox semantics). */
export function ChoiceChip({ label, ...props }: { label: string } & Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-line-2 bg-surface-0 px-3 text-sm font-medium text-fg-2 transition-colors hover:border-line-3 hover:text-fg has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:checked]:text-fg has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/35">
      <input type="checkbox" className="size-4 accent-[var(--brand)]" {...props} />
      {label}
    </label>
  )
}

/** Key/value facts. Labels are muted, values are plain: information, not controls. */
export function Facts({ items, className = '' }: { items: { label: string; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={`grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4 ${className}`}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[11px] font-medium text-fg-3">{item.label}</dt>
          <dd className="mt-0.5 truncate text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Inline note: an info strip with a brand rule, visually distinct from controls. */
export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <div className={`rounded-md border-l-2 px-3 py-2 text-[13px] leading-relaxed ${tone === 'warn' ? 'border-l-destructive bg-brand-soft text-fg-2' : 'border-l-line-3 bg-surface-2 text-fg-2'}`}>{children}</div>
  )
}

export interface SubTabItem<T extends string> {
  /** id of the controlled tabpanel; the tab itself gets `${id}-tab`. */
  id: string
  value: T
  label: ReactNode
  /** accessible name when `label` is not plain text (e.g. icon + name). */
  name?: string
  icon?: ReactNode
  hint?: string
  count?: number
}

/**
 * RHEA-190 m24: segmented sub-tabs inside a 管理 section (限制 → 容量 / 时间 / 限流 /
 * 变更记录, OAuth → GitHub / Google). WAI-ARIA tabs: arrow keys / Home / End move
 * between tabs, only the selected panel is shown.
 */
export function SubTabs<T extends string>({
  label,
  items,
  active,
  onSelect,
  className = '',
  ...rest
}: {
  label: string
  items: SubTabItem<T>[]
  active: T
  onSelect: (value: T) => void
  className?: string
} & Omit<ComponentProps<'div'>, 'onSelect' | 'role'>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = items.length - 1
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null
    if (next === null) return
    event.preventDefault()
    onSelect(items[next]!.value)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`mb-4 flex gap-1 overflow-x-auto rounded-lg border border-line-1 bg-surface-2 p-1 ${className}`}
      data-subtabs=""
      {...rest}
    >
      {items.map((item, index) => {
        const selected = item.value === active
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="tab"
            id={`${item.id}-tab`}
            aria-controls={item.id}
            aria-selected={selected}
            aria-label={item.name}
            tabIndex={selected ? 0 : -1}
            title={item.hint}
            data-subtab={item.value}
            className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors ${
              selected ? 'border-line-2 bg-surface-1 text-fg shadow-elev-1' : 'border-transparent text-fg-2 hover:bg-surface-1/60 hover:text-fg'
            }`}
            onClick={() => onSelect(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.icon}
            {item.label}
            {item.count === undefined ? null : <span className="text-[11px] tabular-nums text-muted-foreground">{item.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

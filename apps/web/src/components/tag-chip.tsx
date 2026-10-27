/**
 * A clip's #tag (RHEA-190 step 7). Tapping the name filters the board by that
 * tag (tap again to clear); the × removes the tag from the clip in one tap —
 * no more 更多 → 标签 → 移除 detour.
 */
import { motion } from 'motion/react'
import { XIcon } from 'lucide-react'
import { dur, easeIn, springBounce } from '@/lib/motion.ts'

export function TagChip({ name, active, onFilter, onRemove, compact = false, reduced = false }: { name: string; active: boolean; onFilter: () => void; onRemove?: () => void; compact?: boolean; reduced?: boolean }) {
  return (
    <motion.span
      layout={reduced ? false : 'position'}
      initial={reduced ? false : { opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6, transition: { duration: dur.fast, ease: easeIn } }}
      transition={springBounce}
      data-tag-chip={name}
      className={`group/tag inline-flex shrink-0 items-center rounded-full border text-[11px] leading-none transition-colors duration-(--dur-fast) ${compact ? 'mx-0.5 text-[10.5px]' : ''} ${
        active ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]' : 'border-[var(--line-2)] text-[var(--fg-2)] hover:border-[var(--line-3)] hover:text-[var(--fg)]'
      }`}
    >
      <button
        type="button"
        data-action=""
        aria-pressed={active}
        title={active ? `取消按 #${name} 筛选` : `按 #${name} 筛选`}
        onClick={onFilter}
        className={`whitespace-nowrap rounded-full ${compact ? 'py-px pl-1.5' : 'py-1 pl-2'} ${onRemove ? 'pr-0.5' : compact ? 'pr-1.5' : 'pr-2'}`}
      >
        #{name}
      </button>
      {onRemove ? (
        <button
          type="button"
          data-action=""
          aria-label={`移除标签 #${name}`}
          title={`移除标签 #${name}`}
          onClick={onRemove}
          className={`mr-0.5 grid place-items-center rounded-full opacity-70 transition-[opacity,background-color] duration-(--dur-fast) hover:opacity-100 ${active ? 'hover:bg-[color-mix(in_oklab,var(--brand-fg)_20%,transparent)]' : 'hover:bg-[var(--surface-2)]'} ${compact ? 'size-4' : 'size-5'}`}
        >
          <XIcon className={compact ? 'size-2.5' : 'size-3'} aria-hidden="true" />
        </button>
      ) : null}
    </motion.span>
  )
}

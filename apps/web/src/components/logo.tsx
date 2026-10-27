/** The dropit mark from the RHEA-191 demo: an ink tile with a lowercase d and a brand dot. */
export function Logo({ size = 'md', word = true }: { size?: 'md' | 'lg'; word?: boolean }) {
  const lg = size === 'lg'
  return (
    <span className={`inline-flex items-center font-semibold tracking-tight text-[var(--fg)] ${lg ? 'gap-3 text-[40px]' : 'gap-2 text-[15px]'}`} data-logo="">
      <span className={`relative grid shrink-0 place-items-center bg-[var(--fg)] text-[var(--bg)] ${lg ? 'size-12 rounded-[10px]' : 'size-6 rounded-[5px]'}`} aria-hidden="true">
        <span className={`dd-display leading-none ${lg ? 'text-[26px]' : 'text-[13px]'}`}>d</span>
        <span className={`absolute rounded-full bg-[var(--brand)] ring-[var(--bg)] ${lg ? '-right-1 -top-1 size-4 ring-4' : '-right-0.5 -top-0.5 size-2 ring-2'}`} />
      </span>
      {word ? <span className="dd-display">dropit</span> : <span className="sr-only">dropit</span>}
    </span>
  )
}

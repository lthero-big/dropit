import type { Transition } from 'motion/react'

// Mirrors the CSS tokens in demo.css so JS-driven animation uses the same rhythm.
export const dur = { fast: 0.12, base: 0.2, slow: 0.32 } as const
export const easeOut = [0.22, 1, 0.36, 1] as const
export const easeIn = [0.55, 0, 1, 0.45] as const

export const enter: Transition = { duration: dur.base, ease: easeOut }
export const exit: Transition = { duration: dur.fast, ease: easeIn }
/** settle without overshoot: layout reflow, view switch */
export const springSettle: Transition = { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 }
/** visible bounce: pin snap, spring-back, landing */
export const springBounce: Transition = { type: 'spring', stiffness: 520, damping: 22, mass: 0.8 }
/** loose tether for drag-away return */
export const springTether: Transition = { type: 'spring', stiffness: 300, damping: 16 }

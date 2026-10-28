import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'dark' | 'light' | 'system'

/**
 * Interface skins (RHEA-190 m21). `paper` is the default look and sets no attribute;
 * the others come from the early demos/ui-three-variants branch and only swap the
 * design tokens in skins.css via `data-skin` on <html>.
 */
export const SKINS = [
  { id: 'paper', label: '纸感', hint: '默认' },
  { id: 'bento', label: 'Bento', hint: '圆角卡片 · 蓝' },
  { id: 'swiss', label: 'Swiss', hint: '直角黑线 · 红' },
  { id: 'terminal', label: '终端', hint: '等宽 · 绿' },
] as const
export type Skin = (typeof SKINS)[number]['id']
const isSkin = (value: unknown): value is Skin => SKINS.some((skin) => skin.id === value)

type ThemeProviderProps = {
  children: ReactNode
  defaultTheme?: Theme
  storageKey?: string
  skinStorageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  skin: Skin
  setSkin: (skin: Skin) => void
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined)

function applySkin(skin: Skin) {
  const root = document.documentElement
  if (skin === 'paper') delete root.dataset.skin
  else root.dataset.skin = skin
}

function initialSkin(storageKey: string): Skin {
  try {
    // ?skin=bento|swiss|terminal|paper previews a skin and remembers it.
    const fromUrl = new URLSearchParams(window.location.search).get('skin')
    if (isSkin(fromUrl)) {
      localStorage.setItem(storageKey, fromUrl)
      return fromUrl
    }
    const stored = localStorage.getItem(storageKey)
    if (isSkin(stored)) return stored
  } catch {
    // Storage can be blocked. Fall through to the default.
  }
  return 'paper'
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'dropit-theme',
  skinStorageKey = 'dropit-skin',
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    } catch {
      // Storage can be blocked. Fall through to the default.
    }
    return defaultTheme
  })
  const [skin, setSkinState] = useState<Skin>(() => {
    const value = initialSkin(skinStorageKey)
    // Apply before first paint so a stored skin does not flash the default look.
    applySkin(value)
    return value
  })

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    root.classList.add(resolved)
  }, [theme])

  useEffect(() => {
    applySkin(skin)
  }, [skin])

  const setTheme = (next: Theme) => {
    try {
      localStorage.setItem(storageKey, next)
    } catch {
      // Ignore persistence failures.
    }
    setThemeState(next)
  }

  const setSkin = (next: Skin) => {
    try {
      localStorage.setItem(skinStorageKey, next)
    } catch {
      // Ignore persistence failures.
    }
    setSkinState(next)
  }

  return (
    <ThemeProviderContext.Provider value={{ theme, setTheme, skin, setSkin }}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export function useTheme(): ThemeProviderState {
  const context = useContext(ThemeProviderContext)
  if (!context) throw new Error('useTheme must be used within a ThemeProvider')
  return context
}

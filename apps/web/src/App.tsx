import { useTheme } from '@/components/theme-provider.tsx'

const themes = ['light', 'dark', 'system'] as const

export function App() {
  const { theme, setTheme } = useTheme()

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex max-w-lg flex-col gap-4 px-6 py-16">
        <p className="text-sm text-muted-foreground">dropit</p>
        <h1 className="text-3xl font-semibold tracking-tight">Scaffold</h1>
        <p className="text-muted-foreground">
          Frontend shell. Product screens land after a design is chosen.
        </p>
        <div className="flex gap-2">
          {themes.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
              className="border border-border bg-card px-3 py-1.5 text-sm text-card-foreground"
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </main>
  )
}

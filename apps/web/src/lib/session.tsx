import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, api } from './api.ts'
import type { Me } from './types.ts'

type Status = 'loading' | 'anon' | 'ready' | 'error'

type SessionValue = {
  status: Status
  me: Me | null
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [me, setMe] = useState<Me | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await api<Me>('/api/me')
      setMe(next)
      setStatus('ready')
    } catch (error) {
      setMe(null)
      setStatus(error instanceof ApiError && (error.status === 401 || error.status === 403) ? 'anon' : 'error')
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      // A missing session is already signed out.
    }
    setMe(null)
    setStatus('anon')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(() => ({ status, me, refresh, logout }), [status, me, refresh, logout])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used within SessionProvider')
  return value
}

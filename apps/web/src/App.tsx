import { useEffect } from 'react'
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { Toaster } from '@/components/ui/sonner.tsx'
import { SessionProvider, useSession } from '@/lib/session.tsx'
import { ChangePasswordPage } from '@/pages/change-password-page.tsx'
import { SetupPage } from '@/pages/setup-page.tsx'
import { AdminPage } from '@/pages/admin-page.tsx'
import { DevicePage } from '@/pages/device-page.tsx'
import { HomePage } from '@/pages/home-page.tsx'
import { InvitePage } from '@/pages/invite-page.tsx'
import { JoinPage } from '@/pages/join-page.tsx'
import { LoginPage } from '@/pages/login-page.tsx'
import { NotFoundPage } from '@/pages/not-found-page.tsx'
import { RoomPage } from '@/pages/room-page.tsx'
import { SettingsPage } from '@/pages/settings-page.tsx'
import { SharePage } from '@/pages/share-page.tsx'

/** RHEA-190 auth step 2: a temporary password must be replaced before anything else. */
function PasswordGate() {
  const { me } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (me?.mustChangePassword && location.pathname !== '/change-password') navigate('/change-password', { replace: true })
  }, [location.pathname, me?.mustChangePassword, navigate])
  return null
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/r/:token" element={<RoomPage />} />
          <Route path="/join" element={<JoinPage />} />
          <Route path="/s/:token" element={<SharePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/device" element={<DevicePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        <PasswordGate />
        <Toaster position="top-center" />
      </BrowserRouter>
    </SessionProvider>
  )
}

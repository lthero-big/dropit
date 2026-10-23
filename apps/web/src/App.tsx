import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner.tsx'
import { SessionProvider } from '@/lib/session.tsx'
import { AdminPage } from '@/pages/admin-page.tsx'
import { HomePage } from '@/pages/home-page.tsx'
import { InvitePage } from '@/pages/invite-page.tsx'
import { LoginPage } from '@/pages/login-page.tsx'
import { RoomPage } from '@/pages/room-page.tsx'

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/rooms/:token" element={<RoomPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster position="top-center" />
      </BrowserRouter>
    </SessionProvider>
  )
}

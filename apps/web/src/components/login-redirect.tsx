import { Navigate, useLocation } from 'react-router'
import { loginPath } from '@/lib/machine.ts'

/** Sends a signed-out visitor to /login and brings them back to this page (query and hash kept) after login. */
export function LoginRedirect() {
  const location = useLocation()
  return <Navigate to={loginPath(`${location.pathname}${location.search}${location.hash}`)} replace />
}

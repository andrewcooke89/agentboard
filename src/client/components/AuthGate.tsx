import { useEffect, useState, type ReactNode } from 'react'
import { useAuthStore } from '../stores/authStore'
import { checkAuth } from '../utils/api'
import LoginPage from './LoginPage'

interface AuthGateProps {
  children: ReactNode
}

/**
 * AuthGate checks whether authentication is required and whether the user
 * has a valid token. If auth is required and the token is missing/invalid,
 * it renders the LoginPage. Otherwise, it renders children (the main app).
 */
export default function AuthGate({ children }: AuthGateProps) {
  const token = useAuthStore((state) => state.token)
  const authRequired = useAuthStore((state) => state.authRequired)
  const setAuthRequired = useAuthStore((state) => state.setAuthRequired)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        const result = await checkAuth()
        if (cancelled) return
        setAuthRequired(result.authRequired)
      } catch {
        // Network error - will retry on next render
      } finally {
        if (!cancelled) setChecking(false)
      }
    }

    check()
    return () => { cancelled = true }
  }, [token, setAuthRequired])

  // Still loading initial auth check
  if (checking && authRequired === null) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: 'var(--bg-base)',
          color: 'var(--text-secondary)',
          fontSize: '14px',
        }}
      >
        Connecting...
      </div>
    )
  }

  // Auth required but no valid token -> show login
  if (authRequired && !token) {
    return <LoginPage />
  }

  // Auth not required, or we have a token -> show app
  return <>{children}</>
}

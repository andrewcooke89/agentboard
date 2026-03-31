import { useState, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import { checkAuth } from '../utils/api'

export default function LoginPage() {
  const [inputToken, setInputToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const setToken = useAuthStore((state) => state.setToken)
  const setAuthRequired = useAuthStore((state) => state.setAuthRequired)

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = inputToken.trim()
      if (!trimmed) {
        setError('Token is required')
        return
      }

      setLoading(true)
      setError(null)

      // Temporarily set the token to test it
      setToken(trimmed)

      try {
        const result = await checkAuth()
        if (result.authenticated) {
          // Token is valid - store is already updated
          setAuthRequired(true)
        } else {
          // Token is invalid
          setToken(null)
          setError('Invalid token')
        }
      } catch {
        setToken(null)
        setError('Unable to connect to server')
      } finally {
        setLoading(false)
      }
    },
    [inputToken, setToken, setAuthRequired]
  )

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        background: 'var(--bg-base)',
        color: 'var(--text-primary)',
        padding: '1rem',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '360px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          padding: '2rem',
        }}
      >
        <h1
          style={{
            fontSize: '18px',
            fontWeight: 600,
            marginBottom: '0.5rem',
            color: 'var(--text-primary)',
          }}
        >
          Agentboard
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            marginBottom: '1.5rem',
          }}
        >
          Enter your access token to continue.
        </p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            className="input"
            placeholder="Access token"
            value={inputToken}
            onChange={(e) => {
              setInputToken(e.target.value)
              setError(null)
            }}
            autoFocus
            autoComplete="current-password"
            style={{ marginBottom: '0.75rem' }}
          />

          {error && (
            <p
              style={{
                fontSize: '12px',
                color: 'var(--danger)',
                marginBottom: '0.75rem',
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{ width: '100%' }}
          >
            {loading ? 'Verifying...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

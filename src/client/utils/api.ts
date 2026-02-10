import { useAuthStore } from '../stores/authStore'

/**
 * Get the auth token from the store.
 */
function getAuthToken(): string | null {
  return useAuthStore.getState().token
}

/**
 * Build headers with Authorization if token is available.
 */
function getAuthHeaders(): HeadersInit {
  const token = getAuthToken()
  if (token) {
    return { Authorization: `Bearer ${token}` }
  }
  return {}
}

/**
 * Handle 401 responses by clearing the token and flagging auth required.
 */
function handle401(): void {
  const store = useAuthStore.getState()
  store.setToken(null)
  store.setAuthRequired(true)
}

/**
 * Wrapper around fetch that automatically adds auth headers
 * and handles 401 responses.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers)
  const authHeaders = getAuthHeaders()
  for (const [key, value] of Object.entries(authHeaders)) {
    if (!headers.has(key)) {
      headers.set(key, value)
    }
  }

  const response = await fetch(input, { ...init, headers })

  if (response.status === 401) {
    handle401()
  }

  return response
}

/**
 * Check auth status with the server.
 * Returns { authenticated, authRequired }.
 */
export async function checkAuth(): Promise<{
  authenticated: boolean
  authRequired: boolean
}> {
  try {
    const response = await authFetch('/api/auth-check')
    if (!response.ok) {
      return { authenticated: false, authRequired: true }
    }
    return await response.json()
  } catch {
    // Network error - assume no auth required (can't reach server)
    return { authenticated: false, authRequired: false }
  }
}

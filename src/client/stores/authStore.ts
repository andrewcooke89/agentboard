import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'

interface AuthState {
  token: string | null
  authRequired: boolean | null // null = unknown (loading), false = no auth, true = auth required
  setToken: (token: string | null) => void
  setAuthRequired: (required: boolean) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      authRequired: null,
      setToken: (token) => set({ token }),
      setAuthRequired: (required) => set({ authRequired: required }),
      logout: () => set({ token: null }),
    }),
    {
      name: 'agentboard-auth',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ token: state.token }),
    }
  )
)

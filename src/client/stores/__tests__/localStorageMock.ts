// Shared localStorage mock for store tests.
// MUST be imported BEFORE any store module so that globalThis.localStorage
// is available when Zustand's createJSONStorage(() => localStorage) evaluates.

const globalAny = globalThis as typeof globalThis & {
  window?: { localStorage: Storage }
  localStorage?: Storage
}

export const originalWindow = globalAny.window
export const originalLocalStorage = globalAny.localStorage

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

export const storage = createStorage()
globalAny.localStorage = storage
globalAny.window = { localStorage: storage } as typeof window

export function restoreGlobals() {
  globalAny.window = originalWindow
  globalAny.localStorage = originalLocalStorage
}

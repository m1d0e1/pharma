export const INVENTORY_CHANGED_EVENT = 'inventory-alerts-refresh'
export const INVENTORY_CHANGED_STORAGE_KEY = 'pharma:inventory-updated'

export function notifyInventoryChanged(): void {
  if (typeof window === 'undefined') return

  window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT))

  try {
    window.localStorage.setItem(
      INVENTORY_CHANGED_STORAGE_KEY,
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
  } catch {
    // Storage can be disabled; same-window listeners still received the event.
  }
}

export function subscribeInventoryChanges(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  const handleStorage = (event: StorageEvent) => {
    if (event.key === INVENTORY_CHANGED_STORAGE_KEY) callback()
  }

  window.addEventListener(INVENTORY_CHANGED_EVENT, callback)
  window.addEventListener('storage', handleStorage)
  window.addEventListener('focus', callback)

  return () => {
    window.removeEventListener(INVENTORY_CHANGED_EVENT, callback)
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener('focus', callback)
  }
}

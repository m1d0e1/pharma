export const INVENTORY_CHANGED_EVENT = 'inventory-alerts-refresh'
export const INVENTORY_CHANGED_STORAGE_KEY = 'pharma:inventory-updated'
export const DRUG_IDENTITY_CHANGED_EVENT = 'drug-identity-changed'
export const DRUG_IDENTITY_CHANGED_STORAGE_KEY = 'pharma:drug-identity-updated'
export const DRUG_CATALOG_CHANGED_STORAGE_KEY = 'pharma:drug-catalog-updated'

export interface DrugIdentityChange {
  sourceIds: number[]
  targetId: number
}

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

export function notifyDrugIdentityChanged(change: DrugIdentityChange): void {
  if (typeof window === 'undefined') return

  const sourceIds = [...new Set(
    (change.sourceIds || [])
      .map(Number)
      .filter(id => Number.isInteger(id) && id > 0 && id !== Number(change.targetId))
  )]
  const targetId = Number(change.targetId)
  if (!Number.isInteger(targetId) || targetId <= 0) return
  const payload = { sourceIds, targetId }

  window.dispatchEvent(new CustomEvent<DrugIdentityChange>(DRUG_IDENTITY_CHANGED_EVENT, { detail: payload }))

  try {
    window.localStorage.setItem(
      DRUG_IDENTITY_CHANGED_STORAGE_KEY,
      JSON.stringify({
        ...payload,
        nonce: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
      }),
    )
  } catch {
    // Storage can be disabled; same-window listeners still received the event.
  }

  // Identity changes also move or relabel inventory, so existing inventory listeners
  // must refresh in this window and every other app window.
  notifyInventoryChanged()
}

export function notifyDrugCatalogChanged(): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(
      DRUG_CATALOG_CHANGED_STORAGE_KEY,
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
  } catch {
    // Storage can be disabled. The applying window refreshes its cache directly;
    // this token only exists to refresh other open Tauri windows.
  }
}

export function subscribeDrugIdentityChanges(
  callback: (change: DrugIdentityChange) => void,
): () => void {
  if (typeof window === 'undefined') return () => {}

  const handleLocal = (event: Event) => {
    const detail = (event as CustomEvent<DrugIdentityChange>).detail
    if (detail) callback(detail)
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== DRUG_IDENTITY_CHANGED_STORAGE_KEY || !event.newValue) return
    try {
      const parsed = JSON.parse(event.newValue)
      const targetId = Number(parsed?.targetId)
      const sourceIds = Array.isArray(parsed?.sourceIds)
        ? parsed.sourceIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
        : []
      if (Number.isInteger(targetId) && targetId > 0) callback({ sourceIds, targetId })
    } catch {
      // Ignore malformed/stale cross-window signals.
    }
  }

  window.addEventListener(DRUG_IDENTITY_CHANGED_EVENT, handleLocal)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(DRUG_IDENTITY_CHANGED_EVENT, handleLocal)
    window.removeEventListener('storage', handleStorage)
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

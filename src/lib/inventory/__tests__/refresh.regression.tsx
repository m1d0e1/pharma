import { act, render, screen, waitFor } from '@testing-library/react'
import InventoryPage from '@/app/(dashboard)/inventory/page'
import { getInventoryListAction } from '@/app/actions-client/inventory'
import {
  INVENTORY_CHANGED_EVENT,
  INVENTORY_CHANGED_STORAGE_KEY,
  notifyInventoryChanged,
  subscribeInventoryChanges,
} from '@/lib/inventory/refresh'

jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ pharmacy_id: 'local_default' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}))
jest.mock('@/app/actions-client/inventory', () => ({ getInventoryListAction: jest.fn() }))
jest.mock('@/components/InventoryClientWrapper', () => () => null)
jest.mock('@/components/inventory/InventoryTable', () => function MockInventoryTable({ items }: any) {
  return <div>inventory:{items.map((item: any) => item.id).join(',')}</div>
})

describe('inventory change refresh wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('notifies same-window subscribers and stores a cross-window change token', () => {
    const callback = jest.fn()
    const unsubscribe = subscribeInventoryChanges(callback)
    const setItem = jest.spyOn(Storage.prototype, 'setItem')

    notifyInventoryChanged()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(
      INVENTORY_CHANGED_STORAGE_KEY,
      expect.stringMatching(/^\d+-[a-z0-9]+$/),
    )
    unsubscribe()
    setItem.mockRestore()
  })

  it('subscribes only to the inventory storage key and removes all listeners on cleanup', () => {
    const callback = jest.fn()
    const unsubscribe = subscribeInventoryChanges(callback)

    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key', newValue: 'x' }))
    expect(callback).not.toHaveBeenCalled()
    window.dispatchEvent(new StorageEvent('storage', { key: INVENTORY_CHANGED_STORAGE_KEY, newValue: 'x' }))
    window.dispatchEvent(new Event('focus'))
    expect(callback).toHaveBeenCalledTimes(2)

    unsubscribe()
    window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT))
    window.dispatchEvent(new StorageEvent('storage', { key: INVENTORY_CHANGED_STORAGE_KEY, newValue: 'y' }))
    window.dispatchEvent(new Event('focus'))
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('still dispatches same-window changes when local storage is blocked', () => {
    const callback = jest.fn()
    const unsubscribe = subscribeInventoryChanges(callback)
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })

    expect(() => notifyInventoryChanged()).not.toThrow()
    expect(callback).toHaveBeenCalledTimes(1)

    unsubscribe()
    setItem.mockRestore()
  })

  it('refreshes a mounted inventory list when another window changes stock', async () => {
    (getInventoryListAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [{ id: 'old-stock' }] })
      .mockResolvedValueOnce({ success: true, data: [{ id: 'updated-stock' }] })

    render(<InventoryPage />)
    expect(await screen.findByText('inventory:old-stock')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: INVENTORY_CHANGED_STORAGE_KEY,
        newValue: 'external-change',
      }))
    })

    expect(await screen.findByText('inventory:updated-stock')).toBeInTheDocument()
    await waitFor(() => expect(getInventoryListAction).toHaveBeenCalledTimes(2))
  })
})

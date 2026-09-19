import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeadStockWidget from '@/components/dashboard/DeadStockWidget';
import ExpiryWidget from '@/components/dashboard/ExpiryWidget';
import InventoryTable from '@/components/inventory/InventoryTable';
import { dbSelect } from '@/lib/db/tauri';
import { getClientSession } from '@/lib/auth/local';

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn().mockResolvedValue(undefined),
    enrich: jest.fn((rows: any[]) => rows),
  },
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-to-print', () => ({ useReactToPrint: () => jest.fn() }));
jest.mock('@/components/EditInventoryModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/pos/DrugDetailsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/AddInventoryModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/actions-client/inventory', () => ({ deleteInventoryAction: jest.fn() }));
jest.mock('@/lib/inventory/import', () => ({ importInventoryWorkbookRows: jest.fn() }));

jest.mock('react-hot-toast', () => ({
  toast: {
    loading: jest.fn(() => 'toast-id'),
    success: jest.fn(),
    error: jest.fn(),
    dismiss: jest.fn(),
  },
}));

jest.mock('@tauri-apps/plugin-dialog', () => ({
  save: jest.fn().mockResolvedValue('C:\\tmp\\inventory_export.xlsx'),
}));

jest.mock('@tauri-apps/api/core', () => ({
  invoke: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('xlsx', () => ({
  utils: {
    book_new: jest.fn(() => ({})),
    json_to_sheet: jest.fn(() => ({})),
    book_append_sheet: jest.fn(),
  },
  write: jest.fn(() => new Uint8Array([1, 2, 3])),
}));

describe('active branch UI pharmacy scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'user-1',
      role: 'owner',
      pharmacy_id: 'ph-1',
    });
    (dbSelect as jest.Mock).mockResolvedValue([]);
  });

  it('scopes dead-stock inventory and last-sale lookup to the current pharmacy', async () => {
    render(<DeadStockWidget />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(1));
    const [sql, params] = (dbSelect as jest.Mock).mock.calls[0];
    expect(String(sql)).toContain('JOIN sales_invoices sinv ON sinv.id = si.invoice_id');
    expect(String(sql)).toContain('sinv.pharmacy_id = ?');
    expect(String(sql)).toContain('i.pharmacy_id = ?');
    expect(params).toEqual(['ph-1', 'ph-1', 'ph-1', 'ph-1']);
  });

  it('scopes expiry inventory to the current pharmacy', async () => {
    render(<ExpiryWidget />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(1));
    const [sql, params] = (dbSelect as jest.Mock).mock.calls[0];
    expect(String(sql)).toContain('i.pharmacy_id = ?');
    expect(params).toHaveLength(3);
    expect(params.slice(1)).toEqual(['ph-1', 'ph-1']);
  });

  it('scopes full inventory export and exported master-drug set to the pharmacy prop', async () => {
    render(
      <InventoryTable
        items={[]}
        searchTerm=""
        setSearchTerm={jest.fn()}
        onRefresh={jest.fn()}
        pharmacyId="ph-1"
        canManageInventory={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /تصدير Excel/ }));

    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(2));
    const [inventorySql, inventoryParams] = (dbSelect as jest.Mock).mock.calls[0];
    expect(String(inventorySql)).toContain('i.pharmacy_id = ?');
    expect(String(inventorySql)).toContain('ii.pharmacy_id = ?');
    expect(inventoryParams).toEqual(['ph-1', 'ph-1', 'ph-1', 'ph-1']);

    const [drugsSql, drugsParams] = (dbSelect as jest.Mock).mock.calls[1];
    expect(String(drugsSql)).toContain('WHERE EXISTS');
    expect(String(drugsSql)).toContain('i.pharmacy_id = ?');
    expect(drugsParams).toEqual(['ph-1', 'ph-1']);
  });
});

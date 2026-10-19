/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InventoryTable from '@/components/inventory/InventoryTable';
import { toast } from 'react-hot-toast';
import { importInventoryWorkbookAction } from '@/app/actions-client/inventory';
import { dbSelect } from '@/lib/db/tauri';
import * as XLSX from 'xlsx';

const invokeNative = jest.fn();
const saveDialog = jest.fn();
const appendSheet = jest.fn();
const parseWorkbook = jest.fn();
const toRows = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeNative(...args) }));
jest.mock('@tauri-apps/plugin-dialog', () => ({ save: (...args: unknown[]) => saveDialog(...args) }));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));
jest.mock('@/app/actions-client/inventory', () => ({
  deleteInventoryAction: jest.fn(),
  importInventoryWorkbookAction: jest.fn(),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { reload: jest.fn() } }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-to-print', () => ({ useReactToPrint: jest.fn(() => jest.fn()) }));
jest.mock('@/components/AddInventoryModal', () => () => null);
jest.mock('@/components/EditInventoryModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('xlsx', () => ({
  __esModule: true,
  read: (...args: unknown[]) => parseWorkbook(...args),
  utils: {
    book_new: () => ({ Sheets: {}, SheetNames: [] }),
    book_append_sheet: (...args: unknown[]) => appendSheet(...args),
    json_to_sheet: (rows: unknown[]) => rows,
    sheet_to_json: (...args: unknown[]) => toRows(...args),
  },
  write: () => new Uint8Array([80, 75, 3, 4]).buffer,
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: Object.assign(jest.fn(), {
    loading: jest.fn(() => 'export-toast'),
    dismiss: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  }),
}));

function table() {
  return render(<InventoryTable
    items={[]} searchTerm="" setSearchTerm={jest.fn()} onRefresh={jest.fn()}
    pharmacyId="FORGED-OTHER-BRANCH" canManageInventory
  />);
}

const good = {
  inventoryRows: [{
    id: 'owned-lot', pharmacy_id: 'trusted-branch', drug_id: 10,
    quantity: 4, local_selling_price: 12.5, barcode: 'OWNED',
  }],
  drugRows: [{ id: 10, trade_name: 'Shared Catalog Drug' }],
};

describe('desktop inventory Excel export/import guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveDialog.mockResolvedValue('C:/exports/inventory_export.xlsx');
    invokeNative.mockImplementation((command: string) => {
      if (command === 'export_inventory_snapshot_native') return Promise.resolve(good);
      if (command === 'save_workbook_export_native') return Promise.resolve('C:/exports/inventory_export.xlsx');
      return Promise.resolve(undefined);
    });
  });

  it('exports only a native authorized snapshot without trusting the displayed pharmacy or running renderer SELECT', async () => {
    table();
    fireEvent.click(screen.getByRole('button', { name: /تصدير Excel/ }));
    await waitFor(() => expect(invokeNative).toHaveBeenCalledWith('save_workbook_export_native', {
      kind: 'inventory', data: [80, 75, 3, 4],
    }));
    expect(invokeNative).toHaveBeenCalledWith('export_inventory_snapshot_native');
    expect(invokeNative.mock.calls[0]).toHaveLength(1);
    expect(JSON.stringify(invokeNative.mock.calls)).not.toContain('FORGED-OTHER-BRANCH');
    expect(JSON.stringify(invokeNative.mock.calls)).not.toContain('C:/exports/');
    expect(dbSelect).not.toHaveBeenCalled();
    expect(appendSheet).toHaveBeenCalledWith(expect.anything(), good.inventoryRows, 'inventory');
    expect(appendSheet).toHaveBeenCalledWith(expect.anything(), good.drugRows, 'master_drugs');
    expect(toast.success).toHaveBeenCalled();
  });

  it('fails closed before file writing or renderer database fallback for a malformed native snapshot', async () => {
    invokeNative.mockReset().mockResolvedValueOnce({
      inventoryRows: [{ id: 'lot', drug_id: 10, quantity: Infinity, local_selling_price: 1 }],
      drugRows: [{ id: 10 }],
    });
    table();
    fireEvent.click(screen.getByRole('button', { name: /تصدير Excel/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(saveDialog).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
    expect(invokeNative).toHaveBeenCalledTimes(1);
    expect(appendSheet).not.toHaveBeenCalled();
  });

  it('rejects oversized and unsupported desktop files before any workbook parser or native import', async () => {
    const view = table();
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'stock.xlsx')] },
    });
    fireEvent.change(input, { target: { files: [new File(['xlsx'], 'stock.xls')] } });
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(parseWorkbook).not.toHaveBeenCalled();
    expect(importInventoryWorkbookAction).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('rejects malformed sheet ranges and catalog-overwrite sheets before converting rows', async () => {
    const realXlsx = jest.requireActual('xlsx') as typeof XLSX;
    const sourceWorkbook = realXlsx.utils.book_new();
    realXlsx.utils.book_append_sheet(sourceWorkbook, realXlsx.utils.aoa_to_sheet([
      ['drug_id', 'quantity'], [10, 2],
    ]), 'inventory');
    const safeArchive = realXlsx.write(sourceWorkbook, { bookType: 'xlsx', type: 'binary' }) as string;
    const originalFileReader = global.FileReader;
    class MockReader {
      onload: ((event: any) => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsBinaryString() { this.onload?.({ target: { result: safeArchive } }); }
    }
    Object.defineProperty(global, 'FileReader', { configurable: true, value: MockReader });
    try {
      const view = table();
      const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
      parseWorkbook.mockReturnValueOnce({
        SheetNames: ['inventory'], Sheets: { inventory: { '!ref': 'A1:AZ1000000' } },
      }).mockReturnValueOnce({
        SheetNames: ['inventory', 'master_drugs'],
        Sheets: { inventory: { '!ref': 'A1:D2' }, master_drugs: { '!ref': 'A1:B2' } },
      });
      fireEvent.change(input, { target: { files: [new File(['z'], 'stock.xlsx')] } });
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      fireEvent.change(input, { target: { files: [new File(['z'], 'stock.xlsx')] } });
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
      expect(toRows).not.toHaveBeenCalled();
      expect(importInventoryWorkbookAction).not.toHaveBeenCalled();
      expect(dbSelect).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(global, 'FileReader', { configurable: true, value: originalFileReader });
    }
  });
});

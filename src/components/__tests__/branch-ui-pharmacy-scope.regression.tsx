import React from 'react';
import Database from 'better-sqlite3';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeadStockWidget from '@/components/dashboard/DeadStockWidget';
import ExpiryWidget from '@/components/dashboard/ExpiryWidget';
import InventoryTable from '@/components/inventory/InventoryTable';
import { dbSelect } from '@/lib/db/tauri';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { INVENTORY_CHANGED_EVENT } from '@/lib/inventory/refresh';

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    user?.role === 'owner' || user?.permissions?.[permission] === true
  ),
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
jest.mock('@/app/actions-client/inventory', () => ({
  deleteInventoryAction: jest.fn(),
  importInventoryWorkbookAction: jest.fn(),
}));

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
    (getClientSession as jest.Mock).mockReset().mockResolvedValue({
      id: 'user-1',
      role: 'owner',
      pharmacy_id: 'ph-1',
    });
    (hasUserPermissionSync as jest.Mock).mockReset().mockImplementation((user: any, permission: string) =>
      user?.role === 'owner' || user?.permissions?.[permission] === true
    );
    (dbSelect as jest.Mock).mockReset().mockResolvedValue([]);
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

  it('ignores draft and cancelled sales when calculating dead-stock idle time', async () => {
    render(<DeadStockWidget />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(1));
    const [sql, params] = (dbSelect as jest.Mock).mock.calls[0];
    expect(String(sql)).toContain("sinv.status IN ('completed', 'approved', 'delivered')");

    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE master_drugs (
          id INTEGER PRIMARY KEY,
          trade_name TEXT,
          trade_name_en TEXT,
          active_ingredient TEXT,
          generic_name TEXT,
          manufacturer TEXT
        );
        CREATE TABLE inventory (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          drug_id INTEGER,
          quantity REAL,
          created_at TEXT
        );
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          status TEXT
        );
        CREATE TABLE sales_items (
          invoice_id TEXT,
          drug_id INTEGER,
          created_at TEXT
        );

        INSERT INTO master_drugs (id, trade_name) VALUES (1, 'Dead Stock Drug');
        INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, created_at)
        VALUES ('lot-1', 'ph-1', 1, 5, datetime('now', '-90 days'));
        INSERT INTO sales_invoices (id, pharmacy_id, status)
        VALUES ('draft-sale', 'ph-1', 'draft');
        INSERT INTO sales_items (invoice_id, drug_id, created_at)
        VALUES ('draft-sale', 1, datetime('now', '-1 day'));
      `);

      const rows = sqlite.prepare(String(sql)).all(...params) as any[];
      expect(rows).toEqual([
        expect.objectContaining({ drug_id: 1, quantity: 5 }),
      ]);
      expect(rows[0].months_idle).toBeGreaterThanOrEqual(2);
    } finally {
      sqlite.close();
    }
  });

  it('scopes expiry inventory to the current pharmacy', async () => {
    render(<ExpiryWidget />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(1));
    const [sql, params] = (dbSelect as jest.Mock).mock.calls[0];
    expect(String(sql)).toContain('i.pharmacy_id = ?');
    expect(params).toHaveLength(3);
    expect(params.slice(1)).toEqual(['ph-1', 'ph-1']);
  });

  it.each([
    ['dead stock', DeadStockWidget],
    ['expiry', ExpiryWidget],
  ])('does not query %s inventory data without can_view_stores', async (_name, Widget) => {
    (getClientSession as jest.Mock).mockResolvedValueOnce({
      id: 'restricted-user',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_view_stores: false },
    });

    render(<Widget />);

    expect(await screen.findByText('غير مصرح بعرض بيانات المخزون')).toBeInTheDocument();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('refreshes dead-stock analysis when another inventory module changes stock', async () => {
    (dbSelect as jest.Mock)
      .mockResolvedValueOnce([{
        id: 'old-dead',
        drug_id: 1,
        trade_name: 'Old Dead Stock',
        quantity: 5,
        months_idle: 3,
      }])
      .mockResolvedValueOnce([{
        id: 'new-dead',
        drug_id: 2,
        trade_name: 'New Dead Stock',
        quantity: 4,
        months_idle: 2,
      }]);

    render(<DeadStockWidget />);
    expect(await screen.findByText('Old Dead Stock')).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)));

    expect(await screen.findByText('New Dead Stock')).toBeInTheDocument();
    expect(screen.queryByText('Old Dead Stock')).not.toBeInTheDocument();
    expect(dbSelect).toHaveBeenCalledTimes(2);
  });

  it('refreshes expiry alerts when another inventory module changes stock', async () => {
    (dbSelect as jest.Mock)
      .mockResolvedValueOnce([{
        id: 'old-expiry',
        drug_id: 1,
        trade_name: 'Old Expiry',
        quantity: 5,
        expiry_date: '2026-10-01',
        days_left: 3,
      }])
      .mockResolvedValueOnce([{
        id: 'new-expiry',
        drug_id: 2,
        trade_name: 'New Expiry',
        quantity: 4,
        expiry_date: '2026-10-02',
        days_left: 4,
      }]);

    render(<ExpiryWidget />);
    expect(await screen.findByText('Old Expiry')).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)));

    expect(await screen.findByText('New Expiry')).toBeInTheDocument();
    expect(screen.queryByText('Old Expiry')).not.toBeInTheDocument();
    expect(dbSelect).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest dead-stock refresh when an older request resolves later', async () => {
    let resolveOlder!: (value: any[]) => void;
    let resolveNewer!: (value: any[]) => void;
    (dbSelect as jest.Mock)
      .mockResolvedValueOnce([{
        id: 'initial-dead',
        drug_id: 1,
        trade_name: 'Initial Dead Stock',
        quantity: 5,
        months_idle: 3,
      }])
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    render(<DeadStockWidget />);
    expect(await screen.findByText('Initial Dead Stock')).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)));
    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(2));
    act(() => window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)));
    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveNewer([{
        id: 'newest-dead',
        drug_id: 3,
        trade_name: 'Newest Dead Stock',
        quantity: 3,
        months_idle: 2,
      }]);
    });
    expect(await screen.findByText('Newest Dead Stock')).toBeInTheDocument();

    await act(async () => {
      resolveOlder([{
        id: 'older-dead',
        drug_id: 2,
        trade_name: 'Older Dead Stock',
        quantity: 4,
        months_idle: 2,
      }]);
    });
    expect(screen.getByText('Newest Dead Stock')).toBeInTheDocument();
    expect(screen.queryByText('Older Dead Stock')).not.toBeInTheDocument();
  });

  it('keeps the newest expiry refresh when an older request resolves later', async () => {
    let resolveOlder!: (value: any[]) => void;
    let resolveNewer!: (value: any[]) => void;
    (dbSelect as jest.Mock)
      .mockResolvedValueOnce([{
        id: 'initial-expiry',
        drug_id: 1,
        trade_name: 'Initial Expiry',
        quantity: 5,
        expiry_date: '2026-10-01',
        days_left: 3,
      }])
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    render(<ExpiryWidget />);
    expect(await screen.findByText('Initial Expiry')).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)));
    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(2));
    act(() => window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)));
    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveNewer([{
        id: 'newest-expiry',
        drug_id: 3,
        trade_name: 'Newest Expiry',
        quantity: 3,
        expiry_date: '2026-10-03',
        days_left: 5,
      }]);
    });
    expect(await screen.findByText('Newest Expiry')).toBeInTheDocument();

    await act(async () => {
      resolveOlder([{
        id: 'older-expiry',
        drug_id: 2,
        trade_name: 'Older Expiry',
        quantity: 4,
        expiry_date: '2026-10-02',
        days_left: 4,
      }]);
    });
    expect(screen.getByText('Newest Expiry')).toBeInTheDocument();
    expect(screen.queryByText('Older Expiry')).not.toBeInTheDocument();
  });

  it('distinguishes dead-stock load failure from a healthy moving inventory and retries', async () => {
    (dbSelect as jest.Mock)
      .mockRejectedValueOnce(new Error('dead stock bridge unavailable'))
      .mockResolvedValueOnce([]);

    render(<DeadStockWidget />);

    expect(await screen.findByText('تعذر تحميل تحليل الرواكد')).toBeInTheDocument();
    expect(screen.queryByText('جميع الأصناف تتحرك بشكل جيد! 🚀')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('جميع الأصناف تتحرك بشكل جيد! 🚀')).toBeInTheDocument();
    expect(dbSelect).toHaveBeenCalledTimes(2);
  });

  it('distinguishes expiry load failure from a genuinely clear expiry window and retries', async () => {
    (dbSelect as jest.Mock)
      .mockRejectedValueOnce(new Error('expiry bridge unavailable'))
      .mockResolvedValueOnce([]);

    render(<ExpiryWidget />);

    expect(await screen.findByText('تعذر تحميل تنبيهات انتهاء الصلاحية')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد أصناف قاربت على الانتهاء 👍')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('لا توجد أصناف قاربت على الانتهاء 👍')).toBeInTheDocument();
    expect(dbSelect).toHaveBeenCalledTimes(2);
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

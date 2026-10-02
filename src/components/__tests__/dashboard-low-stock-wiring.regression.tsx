import React from 'react';
import Database from 'better-sqlite3';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DashboardPage from '@/app/(dashboard)/page';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { dbGet, dbSelect } from '@/lib/db/tauri';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getInvoiceDetailsAction } from '@/app/actions-client/sales-reports';
import { toast } from 'react-hot-toast';

jest.mock('next/dynamic', () => {
  let dynamicIndex = 0;
  return () => {
    dynamicIndex += 1;
    const componentIndex = dynamicIndex;
    return function DynamicStub(props: any) {
      if (componentIndex === 1) return <div data-testid="expiry-widget-stub">expiry</div>;
      if (componentIndex === 2) return <div data-testid="dead-stock-widget-stub">dead-stock</div>;
      if (componentIndex === 3) return <div
        data-testid="reorder-alerts-stub"
        data-low-stock={String(!!props.canViewLowStock)}
        data-restock={String(!!props.canViewRestock)}
        data-purchases={String(!!props.canViewPurchases)}
        data-inventory={String(!!props.canViewInventory)}
      >reorder</div>;
      if (componentIndex === 5) return <div data-testid="subscription-status-stub">subscription</div>;
      if (props?.invoice?.sales_items) {
        return <div
          data-testid="dynamic-receipt-items"
          data-points-redeemed={props.invoice.points_redeemed ?? ''}
          data-loyalty-discount={props.invoice.loyalty_discount_amount ?? ''}
        >{props.invoice.sales_items.map((item: any) => item.trade_name).join(',')}</div>;
      }
      return null;
    };
  };
});
jest.mock('next/link', () => function LinkStub({ href, children }: any) {
  return <a href={href}>{children}</a>;
});
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/auth/local', () => ({
  hasUserPermissionSync: jest.fn((user: any) => user?.role === 'owner'),
  getClientSession: jest.fn().mockResolvedValue({
    id: 'user-1',
    username: 'owner',
    role: 'owner',
    pharmacy_id: 'pharmacy-1',
  }),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn().mockResolvedValue([]),
  dbGet: jest.fn(),
}));
jest.mock('@/app/actions-client/inventory', () => ({
  getLowStockAction: jest.fn(),
}));
jest.mock('@/app/actions-client/sales-reports', () => ({
  getInvoiceDetailsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn() },
}));

describe('dashboard low-stock wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any) => user?.role === 'owner');
    (dbGet as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*) as count FROM master_drugs')) return { count: 50 };
      if (sql.includes('SUM(total_amount)')) return { total: 100, total_cogs: 60 };
      if (sql.includes("category = 'cash_drawer'")) return { account_id: 6 };
      if (sql.includes('payment_method =')) return { total: 20 };
      if (sql.includes('stock_adjustments')) return { total_loss: 5 };
      return { balance: 0 };
    });
    (getLowStockAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { drug_id: 1, current_stock: 0, reorder_point: 10 },
        { drug_id: 2, current_stock: 2, reorder_point: 8 },
      ],
    });
  });

  it('uses the shared inventory alert result for the dashboard count and link', async () => {
    render(<DashboardPage />);

    const title = await screen.findByText('تنبيهات المخزون');
    const cardLink = title.closest('a');
    expect(cardLink).toHaveAttribute('href', '/inventory/low-stock');
    expect(cardLink).toHaveTextContent('2');
    expect(getLowStockAction).toHaveBeenCalledWith(10);

    await waitFor(() => expect(dbGet).toHaveBeenCalled());
    expect((dbGet as jest.Mock).mock.calls.some(([sql]) => String(sql).includes('WITH DrugStock'))).toBe(false);
  });

  it('uses the full low-stock count without unbounding the dashboard list query', async () => {
    (getLowStockAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: Array.from({ length: 250 }, (_, index) => ({ drug_id: index + 1 })),
      totalCount: 251,
    });

    render(<DashboardPage />);

    const title = await screen.findByText('تنبيهات المخزون');
    expect(title.closest('.stat-card-interactive')).toHaveTextContent('251');
    expect(getLowStockAction).toHaveBeenCalledWith(10);
  });

  it('shows a yesterday comparison only for the KPI that actually queries yesterday', async () => {
    render(<DashboardPage />);

    expect(await screen.findByText('إيرادات اليوم')).toBeInTheDocument();
    expect(screen.getAllByText('من الأمس')).toHaveLength(1);
  });

  it('does not invent a 100% revenue increase when yesterday has no sales baseline', async () => {
    (dbGet as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*) as count FROM master_drugs')) return { count: 50 };
      if (sql.includes('total_cogs')) return { total: 100, total_cogs: 60 };
      if (sql.includes('payment_method =')) return { total: 20 };
      if (sql.includes('stock_adjustments')) return { total_loss: 5 };
      if (sql.includes('SUM(total_amount)')) return { total: 0 };
      if (sql.includes("category = 'cash_drawer'")) return { account_id: 6 };
      return { balance: 0 };
    });

    render(<DashboardPage />);

    const revenueTitle = await screen.findByText('إيرادات اليوم');
    const revenueCard = revenueTitle.closest('.stat-card-interactive');
    expect(revenueCard).toHaveTextContent('مبيعات أولية اليوم');
    expect(revenueCard).not.toHaveTextContent('+100.0%');
  });

  it('hides inventory alert widgets when store visibility is denied', async () => {
    (getClientSession as jest.Mock).mockResolvedValueOnce({
      id: 'pharmacist-no-store',
      username: 'pharmacist',
      role: 'pharmacist',
      pharmacy_id: 'pharmacy-1',
      permissions: {
        rep_can_view_sales: false,
        can_view_stores: false,
      },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, permission: string) =>
      user?.permissions?.[permission] === true
    );

    render(<DashboardPage />);

    expect(await screen.findByText('لوحة التحكم الرئيسية (محلي)')).toBeInTheDocument();
    expect(screen.queryByTestId('expiry-widget-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dead-stock-widget-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reorder-alerts-stub')).not.toBeInTheDocument();
  });

  it('renders low-stock alerts for the default pharmacist without exposing restock, purchase, or full-inventory actions', async () => {
    (getClientSession as jest.Mock).mockResolvedValueOnce({
      id: 'default-pharmacist',
      username: 'pharmacist',
      role: 'pharmacist',
      pharmacy_id: 'pharmacy-1',
      permissions: {
        rep_can_view_sales: true,
        can_view_low_stock: true,
        can_view_restock: false,
        can_view_purchases: false,
        can_view_stores: false,
      },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, permission: string) =>
      user?.permissions?.[permission] === true
    );

    render(<DashboardPage />);

    const reorder = await screen.findByTestId('reorder-alerts-stub');
    expect(reorder).toHaveAttribute('data-low-stock', 'true');
    expect(reorder).toHaveAttribute('data-restock', 'false');
    expect(reorder).toHaveAttribute('data-purchases', 'false');
    expect(reorder).toHaveAttribute('data-inventory', 'false');
    expect(screen.queryByTestId('expiry-widget-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dead-stock-widget-stub')).not.toBeInTheDocument();
  });

  it('fails closed when the shared low-stock source cannot load', async () => {
    (getLowStockAction as jest.Mock).mockResolvedValue({ success: false, error: 'offline' });
    render(<DashboardPage />);

    const title = await screen.findByText('تنبيهات المخزون');
    expect(title.closest('a')).toHaveTextContent('0');
  });

  it('counts delivered invoices as finalized dashboard revenue and demand', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());

    const getSql = (dbGet as jest.Mock).mock.calls.map(([sql]) => String(sql)).join('\n');
    const selectSql = (dbSelect as jest.Mock).mock.calls.map(([sql]) => String(sql)).join('\n');

    expect(getSql).toContain("status IN ('completed', 'approved', 'delivered')");
    expect(selectSql).toContain("status IN ('completed', 'approved', 'delivered')");
    expect(selectSql).toContain("s.status IN ('completed', 'approved', 'delivered')");
  });

  it('keeps draft and cancelled invoices out of recent dashboard transactions', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    const recentCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('LEFT JOIN patients p ON s.patient_id = p.id')
    );
    expect(recentCall).toBeDefined();
    expect(String(recentCall![0])).toContain("s.status IN ('completed', 'approved', 'delivered')");

    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT);
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          patient_id TEXT,
          total_amount REAL,
          payment_method TEXT,
          status TEXT,
          created_at TEXT
        );
        INSERT INTO patients VALUES ('p-1', 'Patient');
        INSERT INTO sales_invoices VALUES
          ('completed-sale', 'pharmacy-1', 'p-1', 100, 'cash', 'completed', '2026-09-28 10:00:00'),
          ('draft-sale', 'pharmacy-1', 'p-1', 200, 'cash', 'draft', '2026-09-28 12:00:00'),
          ('cancelled-sale', 'pharmacy-1', 'p-1', 300, 'cash', 'cancelled', '2026-09-28 11:00:00');
      `);

      const rows = sqlite.prepare(String(recentCall![0])).all(...recentCall![1]) as any[];
      expect(rows.map(row => row.id)).toEqual(['completed-sale']);
    } finally {
      sqlite.close();
    }
  });

  it('converts custom medium-unit quantities before calculating dashboard trend COGS', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    const dailyCall = (dbGet as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('total_cogs')
    );
    const trendCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('WITH RECURSIVE dates(date)')
    );
    expect(dailyCall).toBeDefined();
    expect(trendCall).toBeDefined();

    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          total_amount REAL,
          status TEXT,
          created_at TEXT
        );
        CREATE TABLE returns (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          total_refund REAL,
          status TEXT,
          created_at TEXT
        );
        CREATE TABLE master_drugs (
          id INTEGER PRIMARY KEY,
          base_price REAL,
          large_to_medium REAL,
          medium_to_small REAL,
          medium_unit TEXT,
          small_unit TEXT
        );
        CREATE TABLE inventory (
          id TEXT PRIMARY KEY,
          drug_id INTEGER,
          cost_price REAL,
          strips_per_box REAL,
          medium_to_small REAL
        );
        CREATE TABLE sales_items (
          id INTEGER PRIMARY KEY,
          invoice_id TEXT,
          inventory_id TEXT,
          drug_id INTEGER,
          quantity_sold REAL,
          unit TEXT,
          cost_price REAL,
          large_to_medium REAL,
          medium_to_small REAL
        );
        CREATE TABLE return_items (
          return_id TEXT, sale_item_id INTEGER, inventory_id TEXT, drug_id INTEGER,
          quantity_returned REAL, unit TEXT
        );

        INSERT INTO master_drugs VALUES (1, 100, 10, 1, 'blister', 'tablet');
        INSERT INTO inventory VALUES ('inv-1', 1, 100, 10, 1);
        INSERT INTO sales_invoices VALUES ('sale-1', 'pharmacy-1', 200, 'completed', datetime('now'));
        INSERT INTO sales_items VALUES (1, 'sale-1', 'inv-1', 1, 10, 'blister', 100, 10, 1);
      `);

      const daily = sqlite.prepare(String(dailyCall![0])).get(...dailyCall![1]) as { total_cogs: number };
      const rows = sqlite.prepare(String(trendCall![0])).all(...trendCall![1]) as Array<{ date: string; cogs: number }>;
      expect(daily.total_cogs).toBe(100);
      expect(rows[rows.length - 1].cogs).toBe(100);
    } finally {
      sqlite.close();
    }
  });

  it('uses sale-time unit conversion snapshots for dashboard daily and trend COGS', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    const dailyCall = (dbGet as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('total_cogs')
    );
    const trendCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('WITH RECURSIVE dates(date)')
    );
    expect(dailyCall).toBeDefined();
    expect(trendCall).toBeDefined();

    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          total_amount REAL,
          status TEXT,
          created_at TEXT
        );
        CREATE TABLE returns (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          total_refund REAL,
          status TEXT,
          created_at TEXT
        );
        CREATE TABLE master_drugs (
          id INTEGER PRIMARY KEY,
          base_price REAL,
          large_to_medium REAL,
          medium_to_small REAL,
          medium_unit TEXT,
          small_unit TEXT
        );
        CREATE TABLE inventory (
          id TEXT PRIMARY KEY,
          drug_id INTEGER,
          cost_price REAL,
          strips_per_box REAL,
          medium_to_small REAL
        );
        CREATE TABLE sales_items (
          id INTEGER PRIMARY KEY,
          invoice_id TEXT,
          inventory_id TEXT,
          drug_id INTEGER,
          quantity_sold REAL,
          unit TEXT,
          cost_price REAL,
          large_to_medium REAL,
          medium_to_small REAL
        );
        CREATE TABLE return_items (
          return_id TEXT, sale_item_id INTEGER, inventory_id TEXT, drug_id INTEGER,
          quantity_returned REAL, unit TEXT
        );

        -- The product was sold when a box contained 10 strips, then the master
        -- conversion was edited to 20. Historical COGS must stay at sale-time value.
        INSERT INTO master_drugs VALUES (1, 100, 20, 1, 'strip', 'tablet');
        INSERT INTO inventory VALUES ('inv-1', 1, 100, 20, 1);
        INSERT INTO sales_invoices VALUES ('sale-1', 'pharmacy-1', 200, 'completed', datetime('now'));
        INSERT INTO sales_items VALUES (1, 'sale-1', 'inv-1', 1, 10, 'strip', 100, 10, 1);
      `);

      const daily = sqlite.prepare(String(dailyCall![0])).get(...dailyCall![1]) as { total_cogs: number };
      const trendRows = sqlite.prepare(String(trendCall![0])).all(...trendCall![1]) as Array<{ cogs: number }>;
      expect(daily.total_cogs).toBe(100);
      expect(trendRows[trendRows.length - 1].cogs).toBe(100);
    } finally {
      sqlite.close();
    }
  });

  it('nets legacy NULL-unit returned item cost using the original sale unit in dashboard trend COGS', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    const trendCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('WITH RECURSIVE dates(date)')
    );
    expect(trendCall).toBeDefined();

    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY, pharmacy_id TEXT, total_amount REAL, status TEXT, created_at TEXT
        );
        CREATE TABLE returns (
          id TEXT PRIMARY KEY, pharmacy_id TEXT, total_refund REAL, status TEXT, created_at TEXT
        );
        CREATE TABLE master_drugs (
          id INTEGER PRIMARY KEY, base_price REAL, large_to_medium REAL, medium_to_small REAL,
          medium_unit TEXT, small_unit TEXT
        );
        CREATE TABLE inventory (
          id TEXT PRIMARY KEY, drug_id INTEGER, cost_price REAL, strips_per_box REAL, medium_to_small REAL
        );
        CREATE TABLE sales_items (
          id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER,
          quantity_sold REAL, unit TEXT, cost_price REAL, large_to_medium REAL, medium_to_small REAL
        );
        CREATE TABLE return_items (
          return_id TEXT, sale_item_id INTEGER, inventory_id TEXT, drug_id INTEGER,
          quantity_returned REAL, unit TEXT
        );

        INSERT INTO master_drugs VALUES (1, 40, 10, 1, 'strip', 'tablet');
        INSERT INTO inventory VALUES ('inv-1', 1, 40, 10, 1);
        INSERT INTO sales_invoices VALUES ('sale-1', 'pharmacy-1', 100, 'completed', datetime('now'));
        INSERT INTO sales_items VALUES (1, 'sale-1', 'inv-1', 1, 2, 'medium', 40, 10, 1);
        INSERT INTO returns VALUES ('return-1', 'pharmacy-1', 100, 'APPROVED', datetime('now'));
        INSERT INTO return_items VALUES ('return-1', 1, 'inv-1', 1, 1, NULL);
      `);

      const rows = sqlite.prepare(String(trendCall![0])).all(...trendCall![1]) as Array<{
        sales: number;
        returns: number;
        cogs: number;
      }>;
      const today = rows[rows.length - 1];
      expect(today).toMatchObject({ sales: 100, returns: 100, cogs: 4 });
    } finally {
      sqlite.close();
    }
  });

  it('ranks top-selling dashboard items by comparable large-unit volume', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    const topItemsCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('Fetch Top Selling Items') || String(sql).includes('ORDER BY quantity DESC')
    );
    expect(topItemsCall).toBeDefined();

    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY, pharmacy_id TEXT, status TEXT, created_at TEXT
        );
        CREATE TABLE master_drugs (
          id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT,
          large_to_medium REAL, medium_to_small REAL, medium_unit TEXT, small_unit TEXT
        );
        CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER);
        CREATE TABLE sales_items (
          invoice_id TEXT, inventory_id TEXT, drug_id INTEGER,
          quantity_sold REAL, unit_price REAL, unit TEXT,
          large_to_medium REAL, medium_to_small REAL
        );

        INSERT INTO sales_invoices VALUES ('sale-1', 'pharmacy-1', 'completed', datetime('now'));
        INSERT INTO master_drugs VALUES
          (1, 'Two Boxes', '', 1, 1, 'strip', 'tablet'),
          (2, 'Nine Strips', '', 20, 1, 'blister', 'tablet');
        INSERT INTO inventory VALUES ('inv-a', 1), ('inv-b', 2);
        INSERT INTO sales_items VALUES
          ('sale-1', 'inv-a', 1, 2, 100, 'large', 1, 1),
          ('sale-1', 'inv-b', 2, 9, 10, 'blister', 10, 1);
      `);

      const rows = sqlite.prepare(String(topItemsCall![0])).all(...topItemsCall![1]) as Array<{ name: string; quantity: number }>;
      expect(rows[0]).toMatchObject({ name: 'Two Boxes', quantity: 2 });
      expect(rows[1]).toMatchObject({ name: 'Nine Strips', quantity: 0.9 });
    } finally {
      sqlite.close();
    }
  });

  it('keeps top-selling items on the same inclusive 30-day window as the trend', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    const topItemsCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('ORDER BY quantity DESC')
    );
    expect(topItemsCall).toBeDefined();

    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY, pharmacy_id TEXT, status TEXT, created_at TEXT
        );
        CREATE TABLE master_drugs (
          id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT,
          large_to_medium REAL, medium_to_small REAL, medium_unit TEXT, small_unit TEXT
        );
        CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER);
        CREATE TABLE sales_items (
          invoice_id TEXT, inventory_id TEXT, drug_id INTEGER,
          quantity_sold REAL, unit_price REAL, unit TEXT,
          large_to_medium REAL, medium_to_small REAL
        );

        INSERT INTO master_drugs VALUES
          (1, 'Within Window', '', 1, 1, 'strip', 'tablet'),
          (2, 'Thirty One Day Old', '', 1, 1, 'strip', 'tablet');
        INSERT INTO inventory VALUES ('inv-in', 1), ('inv-old', 2);
        INSERT INTO sales_invoices VALUES
          ('sale-in', 'pharmacy-1', 'completed', datetime('now', '-29 days')),
          ('sale-old', 'pharmacy-1', 'completed', datetime('now', '-30 days'));
        INSERT INTO sales_items VALUES
          ('sale-in', 'inv-in', 1, 1, 10, 'large', 1, 1),
          ('sale-old', 'inv-old', 2, 100, 10, 'large', 1, 1);
      `);

      const rows = sqlite.prepare(String(topItemsCall![0])).all(...topItemsCall![1]) as Array<{ name: string }>;
      expect(rows.map(row => row.name)).toEqual(['Within Window']);
    } finally {
      sqlite.close();
    }
  });

  it('scopes direct dashboard liquidity and recent activity to the signed-in pharmacy', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());

    const liquidityCall = (dbGet as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('FROM journal_entries je')
    );
    expect(liquidityCall).toBeDefined();
    expect(String(liquidityCall![0])).toContain('JOIN daily_journals dj');
    expect(String(liquidityCall![0])).toContain('dj.pharmacy_id = ?');
    expect(liquidityCall![1]).toEqual([6, 'pharmacy-1', 'pharmacy-1']);

    const activityCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('FROM activity_log a')
    );
    expect(activityCall).toBeDefined();
    expect(String(activityCall![0])).toContain('a.pharmacy_id = ?');
    expect(activityCall![1]).toEqual(['pharmacy-1', 'pharmacy-1']);
  });

  it('counts only the signed-in pharmacy journal entries in dashboard liquidity', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(dbGet).toHaveBeenCalled());
    const liquidityCall = (dbGet as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('FROM journal_entries je')
    );
    expect(liquidityCall).toBeDefined();

    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE daily_journals (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT
        );
        CREATE TABLE journal_entries (
          journal_id TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          amount REAL NOT NULL
        );

        INSERT INTO daily_journals (id, pharmacy_id) VALUES
          ('ph1-cash', 'pharmacy-1'),
          ('ph2-cash', 'pharmacy-2');
        INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES
          ('ph1-cash', 6, 'debit', 125),
          ('ph2-cash', 6, 'debit', 900);
      `);

      const row = sqlite.prepare(String(liquidityCall![0])).get(...liquidityCall![1]) as { balance: number };
      expect(row.balance).toBe(125);
    } finally {
      sqlite.close();
    }
  });

  it('does not load dashboard activity for a user without audit permission', async () => {
    (getClientSession as jest.Mock).mockResolvedValueOnce({
      id: 'admin-1',
      username: 'admin',
      role: 'admin',
      pharmacy_id: 'pharmacy-1',
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user: any, permission: string) =>
      permission === 'rep_can_view_sales'
    );

    render(<DashboardPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    expect((dbSelect as jest.Mock).mock.calls.some(([sql]) =>
      String(sql).includes('FROM activity_log a')
    )).toBe(false);
  });

  it('hides the settings mutation card from an admin with explicit settings denial', async () => {
    (getClientSession as jest.Mock).mockResolvedValueOnce({
      id: 'admin-settings-denied',
      username: 'admin',
      role: 'admin',
      pharmacy_id: 'pharmacy-1',
      permissions: { can_view_settings: false },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, permission: string) =>
      user?.role === 'owner' || user?.permissions?.[permission] === true
    );

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('لوحة التحكم الرئيسية (محلي)')).toBeInTheDocument());
    expect(screen.queryByTestId('subscription-status-stub')).not.toBeInTheDocument();
  });

  it('shows a retryable dashboard error when its session disappears during load', async () => {
    (getClientSession as jest.Mock).mockResolvedValueOnce(null);

    render(<DashboardPage />);

    expect(await screen.findByText('تعذر تحميل لوحة التحكم')).toBeInTheDocument();
    expect(dbGet).not.toHaveBeenCalled();
  });

  it('shows a retryable dashboard error instead of default KPI values when a core DB read throws', async () => {
    (dbGet as jest.Mock)
      .mockRejectedValueOnce(new Error('bridge unavailable'))
      .mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*) as count FROM master_drugs')) return { count: 50 };
        if (sql.includes('SUM(total_amount)')) return { total: 100, total_cogs: 60 };
        if (sql.includes("category = 'cash_drawer'")) return { account_id: 6 };
        if (sql.includes('payment_method =')) return { total: 20 };
        if (sql.includes('stock_adjustments')) return { total_loss: 5 };
        return { balance: 0 };
      });

    render(<DashboardPage />);

    expect(await screen.findByText('تعذر تحميل لوحة التحكم')).toBeInTheDocument();
    expect(screen.queryByText('لوحة التحكم الرئيسية (محلي)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('لوحة التحكم الرئيسية (محلي)')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('surfaces a recent-transaction detail failure and allows a later retry', async () => {
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('LEFT JOIN patients p')) {
        return [{
          id: 'invoice-dashboard-1',
          total_amount: 75,
          payment_method: 'cash',
          patient_name: 'عميل لوحة التحكم',
          created_at: '2026-09-21T10:00:00.000Z',
        }];
      }
      return [];
    });
    (getInvoiceDetailsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('details bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: [] });

    render(<DashboardPage />);

    const transaction = await screen.findByText('عميل لوحة التحكم');
    fireEvent.click(transaction.closest('[class*="cursor-pointer"]') as HTMLElement);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل تفاصيل الفاتورة'));

    fireEvent.click(transaction.closest('[class*="cursor-pointer"]') as HTMLElement);
    await waitFor(() => expect(getInvoiceDetailsAction).toHaveBeenCalledTimes(2));
  });

  it('passes persisted loyalty redemption snapshots into the dashboard receipt modal', async () => {
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('LEFT JOIN patients p')) {
        return [{
          id: 'invoice-dashboard-loyalty',
          total_amount: 110,
          discount_amount: 10,
          points_redeemed: 100,
          loyalty_discount_amount: 10,
          payment_method: 'cash',
          patient_name: 'عميل ولاء',
          created_at: '2026-09-29T17:21:42.000Z',
        }];
      }
      return [];
    });
    (getInvoiceDetailsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{ trade_name: 'تفاصيل ولاء', quantity_sold: 1, unit_price: 120 }],
    });

    render(<DashboardPage />);

    const transaction = await screen.findByText('عميل ولاء');
    fireEvent.click(transaction.closest('[class*="cursor-pointer"]') as HTMLElement);

    const receipt = await screen.findByTestId('dynamic-receipt-items');
    expect(receipt).toHaveAttribute('data-points-redeemed', '100');
    expect(receipt).toHaveAttribute('data-loyalty-discount', '10');
  });

  it('keeps the latest recent-transaction details when an older request resolves afterwards', async () => {
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('LEFT JOIN patients p')) {
        return [
          {
            id: 'invoice-a',
            total_amount: 75,
            payment_method: 'cash',
            patient_name: 'عميل أ',
            created_at: '2026-09-21T10:00:00.000Z',
          },
          {
            id: 'invoice-b',
            total_amount: 90,
            payment_method: 'cash',
            patient_name: 'عميل ب',
            created_at: '2026-09-21T11:00:00.000Z',
          },
        ];
      }
      return [];
    });

    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;
    const detailA = new Promise(resolve => { resolveA = resolve; });
    const detailB = new Promise(resolve => { resolveB = resolve; });
    (getInvoiceDetailsAction as jest.Mock)
      .mockImplementationOnce(() => detailA)
      .mockImplementationOnce(() => detailB);

    render(<DashboardPage />);

    const transactionA = await screen.findByText('عميل أ');
    const transactionB = await screen.findByText('عميل ب');
    fireEvent.click(transactionA.closest('[class*="cursor-pointer"]') as HTMLElement);
    fireEvent.click(transactionB.closest('[class*="cursor-pointer"]') as HTMLElement);
    await waitFor(() => expect(getInvoiceDetailsAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveB({ success: true, data: [{ trade_name: 'تفاصيل ب', quantity_sold: 1, unit_price: 90 }] });
      await detailB;
    });
    expect(await screen.findByText('تفاصيل ب')).toBeInTheDocument();

    await act(async () => {
      resolveA({ success: true, data: [{ trade_name: 'تفاصيل أ', quantity_sold: 1, unit_price: 75 }] });
      await detailA;
    });

    expect(screen.getByText('تفاصيل ب')).toBeInTheDocument();
    expect(screen.queryByText('تفاصيل أ')).not.toBeInTheDocument();
  });

  it('keeps the newest dashboard retry when same-tick retries resolve out of order', async () => {
    let resolveOlderSession!: (value: any) => void;
    let resolveNewerSession!: (value: any) => void;
    const olderSession = new Promise(resolve => { resolveOlderSession = resolve; });
    const newerSession = new Promise(resolve => { resolveNewerSession = resolve; });
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('initial session failure'))
      .mockImplementationOnce(() => olderSession)
      .mockImplementationOnce(() => newerSession);

    let countReads = 0;
    (dbGet as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*) as count FROM master_drugs')) {
        countReads += 1;
        return { count: countReads === 1 ? 222 : 111 };
      }
      if (sql.includes('SUM(total_amount)')) return { total: 100, total_cogs: 60 };
      if (sql.includes("category = 'cash_drawer'")) return { account_id: 6 };
      if (sql.includes('payment_method =')) return { total: 20 };
      if (sql.includes('stock_adjustments')) return { total_loss: 5 };
      return { balance: 0 };
    });

    render(<DashboardPage />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getClientSession).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveNewerSession({
        id: 'new-owner',
        username: 'new-owner',
        role: 'owner',
        pharmacy_id: 'pharmacy-new',
      });
      await newerSession;
    });
    expect(await screen.findByText('222')).toBeInTheDocument();

    await act(async () => {
      resolveOlderSession({
        id: 'old-owner',
        username: 'old-owner',
        role: 'owner',
        pharmacy_id: 'pharmacy-old',
      });
      await olderSession;
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(countReads).toBe(1);
    expect(screen.getByText('222')).toBeInTheDocument();
    expect(screen.queryByText('111')).not.toBeInTheDocument();
  });
});

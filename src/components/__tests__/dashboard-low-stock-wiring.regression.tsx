import React from 'react';
import Database from 'better-sqlite3';
import { render, screen, waitFor } from '@testing-library/react';
import DashboardPage from '@/app/(dashboard)/page';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { dbGet, dbSelect } from '@/lib/db/tauri';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

jest.mock('next/dynamic', () => () => function DynamicStub() { return null; });
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

describe('dashboard low-stock wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});

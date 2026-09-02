import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import DashboardPage from '@/app/(dashboard)/page';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { dbGet } from '@/lib/db/tauri';

jest.mock('next/dynamic', () => () => function DynamicStub() { return null; });
jest.mock('next/link', () => function LinkStub({ href, children }: any) {
  return <a href={href}>{children}</a>;
});
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/auth/local', () => ({
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
});

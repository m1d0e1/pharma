import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import DashboardPage from '@/app/(dashboard)/page';
import { getDashboardKPIsAction, getDashboardReadAction } from '@/app/actions-client/reports';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { dbGet, dbSelect } from '@/lib/db/tauri';

jest.mock('next/dynamic', () => () => function DynamicStub() { return null; });
jest.mock('next/link', () => function LinkStub({ href, children }: any) {
  return <a href={href}>{children}</a>;
});
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({
    id: 'owner-a', username: 'owner', role: 'owner', pharmacy_id: 'a',
    permissions: { rep_can_view_sales: true, can_view_audit: true },
  }),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.permissions?.[key] === true),
}));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn(), dbGet: jest.fn() }));
jest.mock('@/app/actions-client/reports', () => ({
  getDashboardKPIsAction: jest.fn().mockResolvedValue({ success: true, data: {
    sales_today: 100, liquidity: 90, pending_delivery_cash: 20,
    shrinkage_today: 5, stock_alerts_count: 1,
  } }),
  getDashboardReadAction: jest.fn(async (key: string) => ({
    success: true,
    data: key === 'dashboard.drug_count' ? [{ count: 12 }] : [],
  })),
}));
jest.mock('@/app/actions-client/inventory', () => ({
  getLowStockAction: jest.fn().mockResolvedValue({ success: true, data: [], totalCount: 1 }),
}));
jest.mock('@/app/actions-client/sales-reports', () => ({ getInvoiceDetailsAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn() } }));

describe('native dashboard read boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads desktop dashboard data only through fixed native actions', async () => {
    render(<DashboardPage />);
    expect(await screen.findByText('لوحة التحكم الرئيسية')).toBeInTheDocument();
    expect(screen.getByText(/الأدوية في الدليل:/)).toHaveTextContent('12');
    await waitFor(() => expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.audit_logs'));
    expect(getDashboardKPIsAction).toHaveBeenCalledTimes(1);
    for (const key of [
      'dashboard.drug_count', 'dashboard.trend', 'dashboard.top_items',
      'dashboard.recent_sales', 'dashboard.audit_logs',
    ]) {
      expect(getDashboardReadAction).toHaveBeenCalledWith(key);
    }
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('starts independent top-items, recent-sales, and authorized audit reads together', async () => {
    let releaseTopItems!: (value: { success: true; data: any[] }) => void;
    const topItemsPending = new Promise<{ success: true; data: any[] }>(resolve => {
      releaseTopItems = resolve;
    });
    (getDashboardReadAction as jest.Mock).mockImplementation((key: string) =>
      key === 'dashboard.top_items'
        ? topItemsPending
        : Promise.resolve({ success: true, data: key === 'dashboard.drug_count' ? [{ count: 12 }] : [] }),
    );

    render(<DashboardPage />);
    try {
      await waitFor(() => expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.top_items'));
      // These requests must not wait for a slow top-items query to finish.
      await waitFor(() => expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.recent_sales'));
      expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.audit_logs');
    } finally {
      releaseTopItems({ success: true, data: [] });
    }
    expect(await screen.findByText('لوحة التحكم الرئيسية')).toBeInTheDocument();
  });

  it('starts authorized KPI, trend, stock and secondary reads without waiting for drug count', async () => {
    let releaseCount!: (value: { success: true; data: Array<{ count: number }> }) => void;
    const pendingCount = new Promise<{ success: true; data: Array<{ count: number }> }>(resolve => {
      releaseCount = resolve;
    });
    (getDashboardReadAction as jest.Mock).mockImplementationOnce(() => pendingCount);

    render(<DashboardPage />);
    try {
      await waitFor(() => expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.drug_count'));
      await waitFor(() => expect(getDashboardKPIsAction).toHaveBeenCalledTimes(1));
      expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.trend');
      expect(getLowStockAction).toHaveBeenCalledWith(10);
      expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.top_items');
      expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.recent_sales');
      expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.audit_logs');
      expect(screen.queryByText('لوحة التحكم الرئيسية')).not.toBeInTheDocument();
    } finally {
      await act(async () => { releaseCount({ success: true, data: [{ count: 12 }] }); });
    }
    expect(await screen.findByText('لوحة التحكم الرئيسية')).toBeInTheDocument();
  });

  it('does not launch sales reads when the user lacks sales-report permission', async () => {
    const { getClientSession } = require('@/lib/auth/local');
    (getClientSession as jest.Mock).mockResolvedValueOnce({
      id: 'staff-a', username: 'staff', role: 'cashier', pharmacy_id: 'a', permissions: {},
    });
    render(<DashboardPage />);
    expect(await screen.findByText('لوحة التحكم الرئيسية')).toBeInTheDocument();
    expect(getDashboardReadAction).toHaveBeenCalledWith('dashboard.drug_count');
    expect(getDashboardReadAction).toHaveBeenCalledTimes(1);
    expect(getDashboardKPIsAction).not.toHaveBeenCalled();
    expect(getLowStockAction).not.toHaveBeenCalled();
  });

  it('shows a retryable error rather than a fabricated zero if the native count read fails', async () => {
    (getDashboardReadAction as jest.Mock).mockResolvedValueOnce({
      success: false, error: 'Native drug count unavailable',
    });
    render(<DashboardPage />);
    expect(await screen.findByText('تعذر تحميل لوحة التحكم')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
    expect(screen.queryByText(/الأدوية في الدليل:/)).not.toBeInTheDocument();
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it.each([
    { description: 'missing count row', data: [] },
    { description: 'NULL count', data: [{ count: null }] },
    { description: 'invalid negative count', data: [{ count: -1 }] },
  ])('fails closed on a success-shaped native $description response', async ({ data }) => {
    (getDashboardReadAction as jest.Mock).mockResolvedValueOnce({ success: true, data });
    render(<DashboardPage />);
    expect(await screen.findByText('تعذر تحميل لوحة التحكم')).toBeInTheDocument();
    expect(screen.queryByText(/الأدوية في الدليل:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeEnabled();
  });
});

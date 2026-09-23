import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ItemMovementsPage from '@/app/(dashboard)/inventory/item-movements/page';
import OpeningBalancesPage from '@/app/(dashboard)/inventory/opening-balances/page';
import LowStockPage from '@/app/(dashboard)/inventory/low-stock/page';
import InventorySettlementPage from '@/app/(dashboard)/inventory/settlement/page';
import RestockPage from '@/app/(dashboard)/restock/page';
import PurchaseOrdersPage from '@/app/(dashboard)/purchase-orders/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getLowStockAction, getMovementsAction, getOpeningBalancesAction, getRestockItemsAction } from '@/app/actions-client/inventory';
import { getPurchaseOrdersAction } from '@/app/actions-client/purchases';
import { getUnsettledSalesAction } from '@/app/actions-client/settlement';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  getLowStockAction: jest.fn(),
  getMovementsAction: jest.fn(),
  getOpeningBalancesAction: jest.fn(),
  getRestockItemsAction: jest.fn(),
}));

jest.mock('@/app/actions-client/purchases', () => ({
  getPurchaseOrdersAction: jest.fn(),
}));

jest.mock('@/app/actions-client/settlement', () => ({
  getUnsettledSalesAction: jest.fn(),
}));

jest.mock('@/components/AccessDenied', () => function AccessDeniedStub() {
  return <div>access-denied</div>;
});

jest.mock('@/components/inventory/PurchaseOrdersClient', () => function PurchaseOrdersClientStub({ initialOrders }: any) {
  return <div>purchase-orders:{initialOrders.map((order: any) => order.id).join(',')}</div>;
});

jest.mock('@/app/(dashboard)/inventory/low-stock/LowStockClient', () => function LowStockClientStub({ initialItems }: any) {
  return <div>low-stock:{initialItems.map((item: any) => item.id).join(',')}</div>;
});

jest.mock('@/components/sales/SettlementClient', () => function SettlementClientStub({ initialItems }: any) {
  return <div>settlement:{initialItems.map((item: any) => item.id).join(',')}</div>;
});

jest.mock('@/components/inventory/RestockHeader', () => function RestockHeaderStub() {
  return <div>restock-header</div>;
});

jest.mock('@/components/inventory/RestockClient', () => function RestockClientStub({ items }: any) {
  return <div>restock:{items.map((item: any) => item.id).join(',')}</div>;
});

describe('thin route loader ownership wave 3', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockReset();
    (getLowStockAction as jest.Mock).mockReset();
    (getMovementsAction as jest.Mock).mockReset();
    (getOpeningBalancesAction as jest.Mock).mockReset();
    (getRestockItemsAction as jest.Mock).mockReset();
    (getUnsettledSalesAction as jest.Mock).mockReset();
    (getPurchaseOrdersAction as jest.Mock).mockReset();
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => Boolean(user?.permissions?.[key]));
  });

  it('does not keep an authenticated item-movements owner when retry finds no current session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'user-1', role: 'pharmacist' })
      .mockResolvedValueOnce(null);
    (getMovementsAction as jest.Mock).mockRejectedValueOnce(new Error('movement bridge unavailable'));

    render(<ItemMovementsPage />);
    expect(await screen.findByText('تعذر تحميل حركات الأصناف')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText('حركات الأصناف')).not.toBeInTheDocument();
  });

  it('does not keep an earlier opening-balances permission when retry resolves to a denied user', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'admin-1', role: 'admin', permissions: { can_view_opening_balances: true } })
      .mockResolvedValueOnce({ id: 'pharmacist-1', role: 'pharmacist', permissions: {} });
    (getOpeningBalancesAction as jest.Mock).mockRejectedValueOnce(new Error('opening balances unavailable'));

    render(<OpeningBalancesPage />);
    expect(await screen.findByText('تعذر تحميل الأرصدة الإفتتاحية')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText('الأرصدة الإفتتاحية')).not.toBeInTheDocument();
    expect(getOpeningBalancesAction).toHaveBeenCalledTimes(1);
  });

  it('does not let an older purchase-orders retry re-authorize after a newer missing session', async () => {
    let resolveOlderSession!: (value: unknown) => void;
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'owner-initial', role: 'owner' })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlderSession = resolve; }))
      .mockResolvedValueOnce(null);
    (getPurchaseOrdersAction as jest.Mock)
      .mockRejectedValueOnce(new Error('initial purchase orders failure'))
      .mockResolvedValueOnce({ success: true, data: [{ id: 'PO-STALE' }] });

    render(<PurchaseOrdersPage />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    await act(async () => {
      resolveOlderSession({ id: 'owner-stale', role: 'owner' });
    });

    await waitFor(() => expect(screen.getByText('access-denied')).toBeInTheDocument());
    expect(screen.queryByText('purchase-orders:PO-STALE')).not.toBeInTheDocument();
  });

  it('does not keep an earlier low-stock authorization when retry finds no current session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'low-user', role: 'admin', permissions: { can_view_low_stock: true } })
      .mockResolvedValueOnce(null);
    (getLowStockAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'low stock unavailable' });

    render(<LowStockPage />);
    expect(await screen.findByText('تعذر تحميل بيانات النواقص')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText(/^low-stock:/)).not.toBeInTheDocument();
  });

  it('does not keep an earlier settlement authorization when retry finds no current session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'settlement-user', role: 'admin', permissions: { can_view_settlement: true } })
      .mockResolvedValueOnce(null);
    (getUnsettledSalesAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'settlement unavailable' });

    render(<InventorySettlementPage />);
    expect(await screen.findByText('تعذر تحميل بيانات التسوية')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText(/^settlement:/)).not.toBeInTheDocument();
  });

  it('does not keep an earlier restock authorization when retry finds no current session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'restock-user', role: 'admin', permissions: { can_view_restock: true } })
      .mockResolvedValueOnce(null);
    (getRestockItemsAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'restock unavailable' });

    render(<RestockPage />);
    expect(await screen.findByText('تعذر تحميل قائمة إعادة التموين')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText(/^restock:/)).not.toBeInTheDocument();
  });
});

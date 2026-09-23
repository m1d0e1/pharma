import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OpeningBalancesPage from '@/app/(dashboard)/inventory/opening-balances/page';
import ItemMovementsPage from '@/app/(dashboard)/inventory/item-movements/page';
import PurchaseReportsPage from '@/app/(dashboard)/purchases/reports/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getMovementsAction, getOpeningBalancesAction } from '@/app/actions-client/inventory';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  getMovementsAction: jest.fn(),
  getOpeningBalancesAction: jest.fn(),
}));

jest.mock('@/components/reports/PurchaseReportsClient', () => function MockPurchaseReportsClient() {
  return <div data-testid="purchase-reports-client">purchase reports</div>;
});

jest.mock('@/components/AccessDenied', () => function MockAccessDenied() {
  return <div>ACCESS DENIED</div>;
});

describe('coverage-gap: page-owned behavior in thin route wrappers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    Object.defineProperty(window, 'print', { configurable: true, value: jest.fn() });
  });

  it('filters opening-balance rows locally and does not load them for a denied viewer', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'u-1', role: 'admin', permissions: { can_view_opening_balances: true } });
    (getOpeningBalancesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { id: 1, trade_name: 'بانادول', trade_name_en: 'Panadol', quantity: 5, cost_price: 10, created_at: '2026-09-20' },
        { id: 2, trade_name: 'كتافلام', trade_name_en: 'Cataflam', quantity: 2, cost_price: 20, created_at: '2026-09-20' },
      ],
    });
    const allowed = render(<OpeningBalancesPage />);

    expect(await screen.findByText('بانادول')).toBeInTheDocument();
    expect(screen.getByText('كتافلام')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('بحث في الأرصدة...'), { target: { value: 'Pana' } });
    expect(screen.getByText('بانادول')).toBeInTheDocument();
    expect(screen.queryByText('كتافلام')).not.toBeInTheDocument();
    allowed.unmount();

    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'u-2', role: 'pharmacist', permissions: {} });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(false);
    render(<OpeningBalancesPage />);
    expect(await screen.findByText('ACCESS DENIED')).toBeInTheDocument();
    expect(getOpeningBalancesAction).not.toHaveBeenCalled();
  });

  it('filters item movements across parsed drug name, action, details, and responsible user', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'u-1', role: 'pharmacist' });
    (getMovementsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { id: 1, action: 'ADD_INVENTORY', details: 'إضافة 5 من Panadol', user_name: 'Ahmed', user_id: 'u-1', created_at: '2026-09-21' },
        { id: 2, action: 'DELETE_INVENTORY', details: 'حذف Cataflam من المخزون', user_name: 'Sara', user_id: 'u-2', created_at: '2026-09-21' },
      ],
    });
    render(<ItemMovementsPage />);

    expect(await screen.findByText('Panadol')).toBeInTheDocument();
    expect(screen.getByText('Cataflam')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('ابحث عن صنف أو عملية...'), { target: { value: 'Sara' } });
    expect(screen.queryByText('Panadol')).not.toBeInTheDocument();
    expect(screen.getByText('Cataflam')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /تصفية/ })).not.toBeInTheDocument();
  });

  it('prints the purchase-report route wrapper and blocks it when there is no session', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'u-1', role: 'admin' });
    const allowed = render(<PurchaseReportsPage />);
    expect(await screen.findByTestId('purchase-reports-client')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'طباعة التقارير' }));
    expect(window.print).toHaveBeenCalledTimes(1);
    allowed.unmount();

    (getClientSession as jest.Mock).mockResolvedValue(null);
    render(<PurchaseReportsPage />);
    expect(await screen.findByText('ACCESS DENIED')).toBeInTheDocument();
  });

  it('shows and retries an opening-balance load failure instead of rendering a false empty table', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'u-1', role: 'admin', permissions: { can_view_opening_balances: true } });
    (getOpeningBalancesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'opening balances unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 3, trade_name: 'Voltaren', quantity: 4, cost_price: 30, created_at: '2026-09-21' }],
      });

    render(<OpeningBalancesPage />);

    expect(await screen.findByText('تعذر تحميل الأرصدة الإفتتاحية')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد أرصدة إفتتاحية مسجلة.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('Voltaren')).toBeInTheDocument();
  });

  it('shows and retries an item-movement load failure instead of rendering a false empty table', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'u-1', role: 'pharmacist' });
    (getMovementsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('movement transport'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 9, action: 'DELETE_INVENTORY', details: 'حذف Aspirin من المخزون', user_name: 'Ahmed', user_id: 'u-1', created_at: '2026-09-21' }],
      });

    render(<ItemMovementsPage />);

    expect(await screen.findByText('تعذر تحميل حركات الأصناف')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد حركات مسجلة حالياً.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('Aspirin')).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesDashboardPage from '@/app/(dashboard)/sales/page';
import PurchasesPage from '@/app/(dashboard)/purchases/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getSalesDashboardStatsAction } from '@/app/actions-client/sales';

jest.mock('next/link', () => function LinkStub({ href, children }: any) {
  return <a href={href}>{children}</a>;
});
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/sales', () => ({
  getSalesDashboardStatsAction: jest.fn(),
}));
jest.mock('@/components/AccessDenied', () => function AccessDeniedStub() {
  return <div>ACCESS DENIED</div>;
});

const salesUser = {
  id: 'sales-user',
  role: 'pharmacist',
  permissions: {
    can_access_pos: true,
    can_view_returns: true,
    can_view_settlement: true,
    can_view_delivery: true,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => Boolean(user?.permissions?.[key]));
  (getSalesDashboardStatsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      todaySales: 0,
      salesChangeText: 'لا تغيير',
      deliveryCount: 0,
      pendingDeliveryCountText: 'لا توجد طلبات',
      averageInvoice: 0,
      averageInvoiceChangeText: 'لا تغيير',
    },
  });
});

it('shows a retryable sales-hub session error instead of silently hiding permitted modules', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session transport unavailable'))
    .mockResolvedValueOnce(salesUser);

  render(<SalesDashboardPage />);

  expect(await screen.findByText('تعذر تحميل صلاحيات المبيعات')).toBeInTheDocument();
  expect(screen.queryByText('فاتورة بيع جديدة')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

  expect(await screen.findByText('فاتورة بيع جديدة')).toBeInTheDocument();
});

it('shows a retryable purchases-hub session error instead of misreporting access denial', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session transport unavailable'))
    .mockResolvedValueOnce({
      id: 'purchase-user',
      role: 'admin',
      permissions: { can_view_purchases: true },
    });
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => Boolean(user?.permissions?.[key]));

  render(<PurchasesPage />);

  expect(await screen.findByText('تعذر تحميل صفحة المشتريات')).toBeInTheDocument();
  expect(screen.queryByText('ACCESS DENIED')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

  expect(await screen.findByText('إدارة المشتريات')).toBeInTheDocument();
});

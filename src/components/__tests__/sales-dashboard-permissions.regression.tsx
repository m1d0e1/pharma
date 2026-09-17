import { render, waitFor } from '@testing-library/react';
import SalesDashboardPage from '@/app/(dashboard)/sales/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('@/app/actions-client/sales', () => ({
  getSalesDashboardStatsAction: jest.fn().mockResolvedValue({
    success: true,
    data: {
      todaySales: 0,
      salesChangeText: '',
      deliveryCount: 0,
      pendingDeliveryCountText: '',
      averageInvoice: 0,
      averageInvoiceChangeText: '',
    },
  }),
}));

describe('sales dashboard target permissions', () => {
  it('hides POS cards when sales viewing is allowed but POS access is denied', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      role: 'pharmacist',
      permissions: {
        can_access_pos: false,
        can_view_returns: true,
        can_view_settlement: true,
        can_view_delivery: true,
      },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation(
      (user, permission) => Boolean(user?.permissions?.[permission])
    );

    render(<SalesDashboardPage />);

    await waitFor(() => expect(document.querySelector('a[href="/returns"]')).toBeTruthy());
    expect(document.querySelector('a[href="/pos"]')).toBeNull();
    expect(document.querySelector('a[href="/pos?tab=drafts"]')).toBeNull();
    expect(document.querySelector('a[href="/sales/settlement"]')).toBeTruthy();
    expect(document.querySelector('a[href="/sales/delivery"]')).toBeTruthy();
  });
});

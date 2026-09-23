import { act, render, screen, waitFor } from '@testing-library/react';
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
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockReset();
    (hasUserPermissionSync as jest.Mock).mockReset();
  });

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

  it('does not let an older owner retry re-authorize sales modules after a newer restricted session', async () => {
    let resolveOlder!: (value: unknown) => void;
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session unavailable'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({
        id: 'pharmacist-2',
        role: 'pharmacist',
        permissions: { can_view_returns: true, can_access_pos: false },
      });
    (hasUserPermissionSync as jest.Mock).mockImplementation(
      (user, permission) => user?.role === 'owner' || Boolean(user?.permissions?.[permission])
    );

    render(<SalesDashboardPage />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => expect(document.querySelector('a[href="/returns"]')).toBeTruthy());
    expect(document.querySelector('a[href="/pos"]')).toBeNull();

    await act(async () => {
      resolveOlder({ id: 'owner-2', role: 'owner', permissions: {} });
    });

    expect(document.querySelector('a[href="/pos"]')).toBeNull();
  });
});

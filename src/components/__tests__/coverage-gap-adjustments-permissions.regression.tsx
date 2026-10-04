import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdjustmentsPage from '@/app/(dashboard)/stores/adjustments/page';
import { getAdjustmentsAction } from '@/app/actions-client/inventory';
import { getClientSession } from '@/lib/auth/local';

const push = jest.fn();
const prefetch = jest.fn();
const router = { push, prefetch };

jest.mock('next/navigation', () => ({
  usePathname: () => '/stores/items',
  useRouter: () => router,
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn((user: any, key: string) => (
    user?.role === 'owner'
    || (Array.isArray(user?.permissions)
      ? user.permissions.includes(key)
      : user?.permissions?.[key] === true)
  )),
  logoutLocal: jest.fn(),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  getAdjustmentsAction: jest.fn(),
}));

jest.mock('@/app/(dashboard)/stores/adjustments/AdjustmentsClient', () => function MockAdjustmentsClient() {
  return <div>ADJUSTMENTS CLIENT</div>;
});

describe('stock-adjustment route permission boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAdjustmentsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('blocks a store viewer without inventory-manage permission before loading the adjustment screen', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-viewer',
      role: 'admin',
      permissions: { can_view_stores: true, can_manage_inventory: false },
    });

    render(<AdjustmentsPage />);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/inventory'));
    expect(getAdjustmentsAction).not.toHaveBeenCalled();
    expect(screen.queryByText('ADJUSTMENTS CLIENT')).not.toBeInTheDocument();
  });

  it('loads adjustment reasons for an inventory manager', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-manager',
      role: 'admin',
      permissions: { can_view_stores: true, can_manage_inventory: true },
    });

    render(<AdjustmentsPage />);

    expect(await screen.findByText('ADJUSTMENTS CLIENT')).toBeInTheDocument();
    expect(getAdjustmentsAction).toHaveBeenCalled();
  });

  it('shows a retryable route error instead of a healthy adjustment screen when reason loading fails', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-manager',
      role: 'admin',
      permissions: { can_view_stores: true, can_manage_inventory: true },
    });
    (getAdjustmentsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'adjustment reasons unavailable' })
      .mockResolvedValueOnce({ success: true, data: [{ id: 7, name_ar: 'جرد' }] });

    render(<AdjustmentsPage />);

    expect(await screen.findByText('تعذر تحميل بيانات شاشة التسوية')).toBeInTheDocument();
    expect(screen.queryByText('ADJUSTMENTS CLIENT')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('ADJUSTMENTS CLIENT')).toBeInTheDocument();
    expect(getAdjustmentsAction).toHaveBeenCalledTimes(2);
  });

  it('recovers from a thrown adjustment-route session load instead of leaving an authorization spinner', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockResolvedValueOnce({
        id: 'admin-manager',
        role: 'admin',
        permissions: { can_view_stores: true, can_manage_inventory: true },
      });
    (getAdjustmentsAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 7, name_ar: 'جرد' }] });

    render(<AdjustmentsPage />);

    expect(await screen.findByText('تعذر تحميل بيانات شاشة التسوية')).toBeInTheDocument();
    expect(screen.queryByText('ADJUSTMENTS CLIENT')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('ADJUSTMENTS CLIENT')).toBeInTheDocument();
    expect(getClientSession).toHaveBeenCalledTimes(2);
  });
});

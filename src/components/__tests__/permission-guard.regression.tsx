import { fireEvent, render, screen } from '@testing-library/react';
import PermissionGuard from '@/components/PermissionGuard';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

describe('PermissionGuard', () => {
  it('renders protected content when the current user has the permission', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);

    render(<PermissionGuard permissionKey="can_view_reports"><div>protected report</div></PermissionGuard>);

    expect(await screen.findByText('protected report')).toBeInTheDocument();
  });

  it('renders the configured fallback for missing sessions and denied permissions', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(null);
    render(<PermissionGuard permissionKey="can_view_reports" fallback={<div>blocked</div>}><div>protected report</div></PermissionGuard>);
    expect(await screen.findByText('blocked')).toBeInTheDocument();

    (getClientSession as jest.Mock).mockResolvedValue({ id: 'user-1', role: 'pharmacist' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(false);
    render(<PermissionGuard permissionKey="can_view_reports" fallback={<div>denied</div>}><div>another report</div></PermissionGuard>);
    expect(await screen.findByText('denied')).toBeInTheDocument();
  });

  it('distinguishes a session transport failure from a denied permission and retries', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockResolvedValueOnce({ id: 'owner-1', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);

    render(
      <PermissionGuard permissionKey="can_view_reports" fallback={<div>denied</div>}>
        <div>protected report</div>
      </PermissionGuard>
    );

    expect(await screen.findByText('تعذر التحقق من الصلاحيات')).toBeInTheDocument();
    expect(screen.queryByText('denied')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('protected report')).toBeInTheDocument();
    expect(getClientSession).toHaveBeenCalledTimes(2);
  });
});

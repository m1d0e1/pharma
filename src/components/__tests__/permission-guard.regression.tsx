import { render, screen } from '@testing-library/react';
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
});

import { fireEvent, render, screen } from '@testing-library/react';
import PermissionGuard from '@/components/PermissionGuard';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

let mockRoute = '/reports/sales';
jest.mock('next/navigation', () => ({ usePathname: () => mockRoute }));
import { getRoutePermission } from '@/lib/auth/roles';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

describe('PermissionGuard', () => {
  it('fail-closes on a new route even when both tabs require the same permission', async () => {
    mockRoute = '/reports/sales';
    (getClientSession as jest.Mock).mockReset()
      .mockResolvedValueOnce({ id: 'owner-1', role: 'owner' })
      .mockResolvedValueOnce(null);
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    const { rerender } = render(
      <PermissionGuard permissionKey="can_view_reports" fallback={<div>revoked</div>}>
        <div>protected report</div>
      </PermissionGuard>
    );
    expect(await screen.findByText('protected report')).toBeInTheDocument();
    mockRoute = '/reports/purchases';
    rerender(
      <PermissionGuard permissionKey="can_view_reports" fallback={<div>revoked</div>}>
        <div>protected report</div>
      </PermissionGuard>
    );
    expect(await screen.findByText('revoked')).toBeInTheDocument();
    expect(getClientSession).toHaveBeenCalledTimes(2);
  });
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

  it('allows a route guarded by alternative permissions when any one permission is granted', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'restock-user', role: 'pharmacist' });
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user: any, key: string) => key === 'can_view_restock');

    render(
      <PermissionGuard permissionKey={['can_view_purchases', 'can_view_restock'] as any} fallback={<div>blocked</div>}>
        <div>purchase orders</div>
      </PermissionGuard>
    );

    expect(await screen.findByText('purchase orders')).toBeInTheDocument();
    expect(screen.queryByText('blocked')).not.toBeInTheDocument();
  });

  it.each([
    { description: 'clinical-only', permissions: { can_view_interactions: true, can_view_patients: false }, allowed: true },
    { description: 'patient-only', permissions: { can_view_interactions: false, can_view_patients: true }, allowed: false },
    { description: 'legacy stored permission without clinical key', permissions: { can_view_patients: true }, allowed: false },
    { description: 'both explicit flags denied', permissions: { can_view_interactions: false, can_view_patients: false }, allowed: false },
  ])('guards interactions for $description without inheriting patient access', async ({ permissions, allowed }) => {
    const staff = { id: 'clinical-qa-staff', role: 'pharmacist', permissions };
    (getClientSession as jest.Mock).mockResolvedValue(staff);
    (hasUserPermissionSync as jest.Mock).mockImplementation((user, key) => user.permissions[key] === true);

    render(
      <PermissionGuard permissionKey={getRoutePermission('/interactions')} fallback={<div>clinical denied</div>}>
        <div>clinical protected</div>
      </PermissionGuard>,
    );

    expect(await screen.findByText(allowed ? 'clinical protected' : 'clinical denied')).toBeInTheDocument();
    expect(screen.queryByText(allowed ? 'clinical denied' : 'clinical protected')).not.toBeInTheDocument();
    expect(hasUserPermissionSync).toHaveBeenCalledWith(staff, 'can_view_interactions');
    expect(hasUserPermissionSync).not.toHaveBeenCalledWith(staff, 'can_view_patients');
  });
});

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AuthGuard from '@/components/AuthGuard';
import PermissionGuard from '@/components/PermissionGuard';
import SidebarNav from '@/components/SidebarNav';
import { getClientSession } from '@/lib/auth/local';
import { getRoutePermission } from '@/lib/auth/roles';

// These are synthetic JSDOM fixtures, never a browser/native login or session.
const mockPush = jest.fn();
const mockPrefetch = jest.fn();
const mockRouter = { push: mockPush, prefetch: mockPrefetch };
let mockPathname = '/inventory/item-movements';

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPathname,
}));

jest.mock('@/lib/auth/local', () => {
  const original = jest.requireActual('@/lib/auth/local');
  return { ...original, getClientSession: jest.fn() };
});

const syntheticUser = (role: string, permissions: Record<string, boolean>) => ({
  id: `synthetic-${role}`, username: `fixture-${role}`, role, permissions,
});

function GuardedRoute({ user }: { user: ReturnType<typeof syntheticUser> }) {
  return (
    <AuthGuard>
      <div dir="rtl">
        <SidebarNav userRole={user.role} userPermissions={user.permissions} />
        <PermissionGuard permissionKey={getRoutePermission(mockPathname)} fallback={<span>route denied</span>}>
          <div>route content</div>
        </PermissionGuard>
      </div>
    </AuthGuard>
  );
}

describe('synthetic cross-route authentication and navigation contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockReset();
    mockPathname = '/inventory/item-movements';
  });

  it('never treats a synthetic admin as the owner for an owner-required AuthGuard deep link', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(syntheticUser('admin', { can_view_settings: true }));
    render(<AuthGuard requiredRole="owner"><div>owner-only route</div></AuthGuard>);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('owner-only route')).not.toBeInTheDocument();
  });

  it('keeps owner-required content available to a verified synthetic owner', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(syntheticUser('owner', {}));
    render(<AuthGuard requiredRole="owner"><div>owner-only route</div></AuthGuard>);
    expect(await screen.findByText('owner-only route')).toBeInTheDocument();
  });

  it('enforces distinct inventory movement versus inventory overview grants in both navigation and deep links', async () => {
    const user = syntheticUser('pharmacist', {
      can_view_stores: true,
      preview_item_movements: false,
      can_view_patients: false,
    });
    (getClientSession as jest.Mock).mockResolvedValue(user);
    const { rerender } = render(<GuardedRoute user={user} />);

    const desktop = await screen.findByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(within(desktop).getByRole('link', { name: 'المخزون' })).toHaveAttribute('href', '/inventory');
    expect(within(desktop).queryByRole('link', { name: 'حركات الأصناف' })).not.toBeInTheDocument();
    expect(await screen.findByText('route denied')).toBeInTheDocument();
    expect(screen.queryByText('route content')).not.toBeInTheDocument();

    mockPathname = '/inventory';
    rerender(<GuardedRoute user={user} />);
    expect(await screen.findByText('route content')).toBeInTheDocument();
    expect(within(desktop).getByRole('link', { name: 'المخزون' })).toHaveAttribute('aria-current', 'page');
    expect(within(desktop).queryByRole('link', { name: 'المرضى' })).not.toBeInTheDocument();
  });

  it('does not keep dynamically fetched sidebar grants after a route transition finds no session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce(syntheticUser('pharmacist', { can_view_sales: true }))
      .mockResolvedValueOnce(null);
    mockPathname = '/sales';
    const { rerender } = render(<SidebarNav userRole="pharmacist" />);
    await waitFor(() => expect(screen.queryAllByRole('link', { name: 'المبيعات والتحصيل' }).length).toBeGreaterThan(0));

    mockPathname = '/inventory';
    rerender(<SidebarNav userRole="pharmacist" />);
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryAllByRole('link', { name: 'المبيعات والتحصيل' })).toHaveLength(0));
  });

  it('hides an old permission link while a newer-route session check remains pending', async () => {
    let resolveNext!: (value: unknown) => void;
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce(syntheticUser('pharmacist', { can_view_sales: true }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
    mockPathname = '/sales';
    const view = render(<SidebarNav userRole="pharmacist" />);
    await waitFor(() => expect(screen.queryAllByRole('link', { name: 'المبيعات والتحصيل' }).length).toBeGreaterThan(0));

    mockPathname = '/inventory';
    view.rerender(<SidebarNav userRole="pharmacist" />);
    expect(screen.queryAllByRole('link', { name: 'المبيعات والتحصيل' })).toHaveLength(0);
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(2));

    await act(async () => resolveNext(syntheticUser('pharmacist', { can_view_sales: false })));
    expect(screen.queryAllByRole('link', { name: 'المبيعات والتحصيل' })).toHaveLength(0);
  });

  it('never borrows another role\'s fetched sidebar grants for a synthetic pharmacist', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(
      syntheticUser('owner', { can_view_purchases: true }),
    );
    render(<SidebarNav userRole="pharmacist" />);
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(1));
    await act(async () => {});
    // The fallback session and the explicitly rendered role disagree; fail closed.
    expect(screen.queryAllByRole('link', { name: 'المشتريات' })).toHaveLength(0);
  });

  it('retains accessible RTL mobile More navigation and Escape recovery on an allowed route', async () => {
    const user = syntheticUser('pharmacist', {
      can_access_pos: true, can_view_sales: true, can_view_receipts: true,
      can_view_delivery: true, can_view_returns: true, can_view_stores: true,
      can_view_patients: true, can_view_interactions: true,
    });
    (getClientSession as jest.Mock).mockResolvedValue(user);
    mockPathname = '/sales/delivery';
    render(<GuardedRoute user={user} />);
    expect(await screen.findByText('route content')).toBeInTheDocument();

    const mobile = screen.getByRole('navigation', { name: 'التنقل الرئيسي للجوال' });
    const more = within(mobile).getByRole('button', { name: 'المزيد من الخيارات' });
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const current = within(mobile).getByRole('link', { name: 'توصيل منزلي' });
    expect(current).toHaveAttribute('href', '/sales/delivery');
    expect(current).toHaveAttribute('aria-current', 'page');
    const firstMoreLink = within(mobile).getAllByRole('link').find(link => link.closest('#pharma-mobile-more-menu'));
    expect(firstMoreLink).toHaveFocus();
    current.focus();
    fireEvent.keyDown(current, { key: 'Escape' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();
  });
});

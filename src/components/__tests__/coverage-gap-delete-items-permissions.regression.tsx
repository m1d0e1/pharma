import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeleteUnusedItemsPage from '@/app/(dashboard)/stores/delete-items/page';
import TopMenuBar from '@/components/TopMenuBar';
import { getClientSession } from '@/lib/auth/local';
import { deleteDrugAction, getUnusedDrugsAction } from '@/app/actions-client/inventory';
import { getRoutePermission } from '@/lib/auth/roles';

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
  getUnusedDrugsAction: jest.fn(),
  deleteDrugAction: jest.fn(),
}));

jest.mock('@/components/inventory/DeleteUnusedItemsClient', () => function MockDeleteUnusedItemsClient({ initialItems, onDelete }: any) {
  return <div>
    <div>DELETE ITEMS CLIENT</div>
    <div>DELETE ITEMS COUNT {initialItems.length}</div>
    <button onClick={() => void onDelete(1)}>delete item 1</button>
    <button onClick={() => void onDelete(2)}>delete item 2</button>
  </div>;
});

jest.mock('@/components/master-drugs/DrugReplacementDialog', () => function MockDrugReplacementDialog() {
  return <div>REPLACEMENT DIALOG</div>;
});

describe('delete-items permission boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getUnusedDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('blocks an admin who can view stores but cannot manage inventory before loading destructive data', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-viewer',
      role: 'admin',
      permissions: { can_view_stores: true, can_manage_inventory: false },
    });

    render(<DeleteUnusedItemsPage />);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/inventory'));
    expect(getUnusedDrugsAction).not.toHaveBeenCalled();
    expect(screen.queryByText('DELETE ITEMS CLIENT')).not.toBeInTheDocument();
  });

  it('loads the destructive utility for an admin with inventory-manage permission', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-manager',
      role: 'admin',
      permissions: { can_view_stores: true, can_manage_inventory: true },
    });

    render(<DeleteUnusedItemsPage />);

    expect(await screen.findByText('DELETE ITEMS CLIENT')).toBeInTheDocument();
    expect(getUnusedDrugsAction).toHaveBeenCalled();
  });

  it('uses inventory-manage permission for middleware resolution and hides the TopMenu link from view-only admins', async () => {
    expect(getRoutePermission('/stores/delete-items')).toBe('can_manage_inventory');

    render(<TopMenuBar userRole="admin" permissions={{ can_view_stores: true, can_manage_inventory: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'البيانات الأساسية' }));
    expect(screen.queryByRole('link', { name: 'حذف الأصناف' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'الأصناف' })).toBeInTheDocument();
  });

  it('keeps the newest post-delete refresh when concurrent item deletions finish out of order', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'owner-1',
      role: 'owner',
      permissions: {},
    });
    (deleteDrugAction as jest.Mock).mockResolvedValue({ success: true });
    (getUnusedDrugsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [
        { id: 1, trade_name: 'one' },
        { id: 2, trade_name: 'two' },
      ] })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    render(<DeleteUnusedItemsPage />);
    expect(await screen.findByText('DELETE ITEMS COUNT 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'delete item 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'delete item 2' }));
    await waitFor(() => expect(getUnusedDrugsAction).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveNewer({ success: true, data: [] });
      await Promise.resolve();
    });
    expect(await screen.findByText('DELETE ITEMS COUNT 0')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({ success: true, data: [{ id: 2, trade_name: 'two' }] });
      await Promise.resolve();
    });

    expect(screen.getByText('DELETE ITEMS COUNT 0')).toBeInTheDocument();
    expect(screen.queryByText('DELETE ITEMS COUNT 1')).not.toBeInTheDocument();
  });

  it('shows a retryable route error instead of a healthy empty delete-items screen when loading fails', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'owner-1',
      role: 'owner',
      permissions: {},
    });
    (getUnusedDrugsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'unused items unavailable' })
      .mockResolvedValueOnce({ success: true, data: [] });

    render(<DeleteUnusedItemsPage />);

    expect(await screen.findByText('تعذر تحميل قائمة الأصناف القابلة للحذف')).toBeInTheDocument();
    expect(screen.queryByText('DELETE ITEMS CLIENT')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('DELETE ITEMS CLIENT')).toBeInTheDocument();
  });

  it('recovers from a thrown delete-items session load instead of leaving the route spinner unresolved', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockResolvedValueOnce({ id: 'owner-1', role: 'owner', permissions: {} });
    (getUnusedDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });

    render(<DeleteUnusedItemsPage />);

    expect(await screen.findByText('تعذر تحميل قائمة الأصناف القابلة للحذف')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('DELETE ITEMS CLIENT')).toBeInTheDocument();
  });
});

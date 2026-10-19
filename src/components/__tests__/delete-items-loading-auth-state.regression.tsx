import { act, render, screen } from '@testing-library/react';
import DeleteUnusedItemsPage from '@/app/(dashboard)/stores/delete-items/page';
import { getClientSession } from '@/lib/auth/local';
import { getUnusedDrugsAction } from '@/app/actions-client/inventory';

const mockPush = jest.fn();
const mockRouter = { push: mockPush };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: (user: any, key: string) =>
    user?.role === 'owner' || user?.permissions?.[key] === true,
}));

jest.mock('@/app/actions-client/inventory', () => ({
  getUnusedDrugsAction: jest.fn(),
  deleteDrugAction: jest.fn(),
}));

jest.mock('@/components/inventory/DeleteUnusedItemsClient', () => function MockDeleteClient() {
  return <div>DESTRUCTIVE CLIENT READY</div>;
});

jest.mock('@/components/master-drugs/DrugReplacementDialog', () => function MockReplacementDialog() {
  return null;
});

describe('delete-items loading reflects the actual authorization stage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockReset();
    (getUnusedDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('does not claim to be loading delete candidates before the user is verified', async () => {
    let resolveSession!: (value: unknown) => void;
    (getClientSession as jest.Mock).mockImplementationOnce(
      () => new Promise(resolve => { resolveSession = resolve; }),
    );

    render(<DeleteUnusedItemsPage />);
    expect(screen.getByRole('status')).toHaveTextContent('جاري التحقق من الصلاحيات');
    expect(screen.queryByText('جاري تحميل الأصناف القابلة للحذف...')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'حذف الأصناف التي لم يتم عليها حركات' })).not.toBeInTheDocument();
    expect(getUnusedDrugsAction).not.toHaveBeenCalled();

    await act(async () => resolveSession({
      id: 'staff-no-delete',
      role: 'pharmacist',
      permissions: { can_manage_inventory: true },
    }));
    expect(mockPush).toHaveBeenCalledWith('/inventory');
    expect(getUnusedDrugsAction).not.toHaveBeenCalled();
    expect(screen.queryByText('DESTRUCTIVE CLIENT READY')).not.toBeInTheDocument();
  });

  it('distinguishes the authorized slow data read from the prior identity check', async () => {
    let resolveSession!: (value: unknown) => void;
    let resolveList!: (value: unknown) => void;
    (getClientSession as jest.Mock).mockImplementationOnce(
      () => new Promise(resolve => { resolveSession = resolve; }),
    );
    (getUnusedDrugsAction as jest.Mock).mockImplementationOnce(
      () => new Promise(resolve => { resolveList = resolve; }),
    );
    render(<DeleteUnusedItemsPage />);
    expect(screen.getByRole('status')).toHaveTextContent('جاري التحقق من الصلاحيات');
    await act(async () => resolveSession({
      id: 'manager', role: 'admin', permissions: { can_manage_inventory: true },
    }));
    expect(screen.getByRole('status')).toHaveTextContent('جاري تحميل الأصناف القابلة للحذف');
    expect(screen.getByRole('heading', { name: 'حذف الأصناف التي لم يتم عليها حركات' })).toBeInTheDocument();
    expect(screen.queryByText('DESTRUCTIVE CLIENT READY')).not.toBeInTheDocument();
    await act(async () => resolveList({ success: true, data: [] }));
    expect(screen.getByText('DESTRUCTIVE CLIENT READY')).toBeInTheDocument();
  });
});

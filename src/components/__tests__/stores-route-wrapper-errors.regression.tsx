import { fireEvent, render, screen } from '@testing-library/react';
import ItemsPage from '@/app/(dashboard)/stores/items/page';
import ShortagesPage from '@/app/(dashboard)/stores/shortages/page';
import StoresPage from '@/app/(dashboard)/stores/page';
import AlternativesPage from '@/app/(dashboard)/stores/alternatives/page';
import DrugIndicationsPage from '@/app/(dashboard)/stores/drug-indications/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getShortagesAction } from '@/app/actions-client/shortages';
import { dbGet, dbSelect } from '@/lib/db/tauri';

const push = jest.fn();
const mockRouter = { push };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/shortages', () => ({ getShortagesAction: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn(), dbSelect: jest.fn() }));
jest.mock('@/components/AccessDenied', () => function MockAccessDenied() { return <div>access-denied</div>; });
jest.mock('@/components/inventory/ItemsManagementClient', () => function MockItemsManagementClient({ initialItems, totalCount }: any) {
  return <div>items:{totalCount}:{initialItems.map((item: any) => item.id).join(',')}</div>;
});
jest.mock('@/app/(dashboard)/stores/shortages/ShortagesClient', () => function MockShortagesClient({ initialData }: any) {
  return <div>shortages:{initialData.map((item: any) => item.id).join(',')}</div>;
});
jest.mock('@/components/inventory/DrugAlternativesClient', () => function MockDrugAlternativesClient() { return <div>alternatives-client</div>; });
jest.mock('@/components/inventory/DrugIndicationsClient', () => function MockDrugIndicationsClient({ indications }: any) {
  return <div>drug-indications:{indications.map((item: any) => item.id).join(',')}</div>;
});

const owner = {
  id: 'owner-1',
  role: 'owner',
  permissions: { can_view_stores: true },
};

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue(owner);
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
  (dbSelect as jest.Mock).mockResolvedValue([]);
  (dbGet as jest.Mock).mockResolvedValue({ count: 0 });
  (getShortagesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
});

it('distinguishes a failed items catalog load from a legitimate empty catalog and retries', async () => {
  (dbSelect as jest.Mock)
    .mockRejectedValueOnce(new Error('catalog unavailable'))
    .mockResolvedValueOnce([{ id: 'drug-recovered' }]);
  (dbGet as jest.Mock).mockResolvedValue({ count: 1 });

  render(<ItemsPage />);

  expect(await screen.findByText('تعذر تحميل بيانات الأصناف')).toBeInTheDocument();
  expect(screen.queryByText(/^items:/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('items:1:drug-recovered')).toBeInTheDocument();
});

it('distinguishes a failed shortages load from a legitimate empty shortages notebook and retries', async () => {
  (getShortagesAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'shortages unavailable' })
    .mockResolvedValueOnce({ success: true, data: [{ id: 'shortage-recovered' }] });

  render(<ShortagesPage />);

  expect(await screen.findByText('تعذر تحميل كشكول النواقص')).toBeInTheDocument();
  expect(screen.queryByText('shortages:')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('shortages:shortage-recovered')).toBeInTheDocument();
});

it('shows a retryable stores-dashboard session error instead of false permission denial', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<StoresPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  expect(screen.queryByText('access-denied')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('إدارة المخازن والإعدادات')).toBeInTheDocument();
});

it('recovers the alternatives auth wrapper after a thrown session load', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<AlternativesPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('alternatives-client')).toBeInTheDocument();
});

it('distinguishes a failed drug-indications selector load from a legitimate empty indication list and retries', async () => {
  (dbSelect as jest.Mock)
    .mockRejectedValueOnce(new Error('indications unavailable'))
    .mockResolvedValueOnce([{ id: 'indication-recovered' }]);

  render(<DrugIndicationsPage />);

  expect(await screen.findByText('تعذر تحميل دواعي الاستخدام')).toBeInTheDocument();
  expect(screen.queryByText('drug-indications:')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('drug-indications:indication-recovered')).toBeInTheDocument();
});

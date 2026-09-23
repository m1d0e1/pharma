import { fireEvent, render, screen } from '@testing-library/react';
import SalesReportsPage from '@/app/(dashboard)/reports/sales/page';
import PurchasesReportsPage from '@/app/(dashboard)/reports/purchases/page';
import ReturnsPage from '@/app/(dashboard)/returns/page';
import NewSalesReturnPage from '@/app/(dashboard)/returns/new/page';
import ShiftReportPage from '@/app/(dashboard)/shifts/report/page';
import HandoverPage from '@/app/(dashboard)/finance/handover/page';
import InteractionsPage from '@/app/(dashboard)/interactions/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getOpenShiftHandoverAction } from '@/app/actions-client/handover';
import { dbGet, dbSelect } from '@/lib/db/tauri';

const push = jest.fn();
const mockRouter = { push };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams('id=shift-ctx'),
}));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/handover', () => ({ getOpenShiftHandoverAction: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn(), dbSelect: jest.fn() }));
jest.mock('@/components/AccessDenied', () => function MockAccessDenied() { return <div>access-denied</div>; });
jest.mock('@/components/reports/SalesReportsClient', () => function MockSalesReportsClient() { return <div>sales-report-client</div>; });
jest.mock('@/components/reports/PurchasesReportsClient', () => function MockPurchasesReportsClient() { return <div>purchases-report-client</div>; });
jest.mock('@/components/returns/ReturnsClient', () => function MockReturnsClient() { return <div>returns-client</div>; });
jest.mock('@/app/(dashboard)/returns/new/SalesReturnClient', () => function MockSalesReturnClient() { return <div>sales-return-client</div>; });
jest.mock('@/components/reports/ShiftReportClient', () => function MockShiftReportClient({ shiftId }: any) { return <div>shift-report:{shiftId}</div>; });
jest.mock('@/components/finance/DrawerHandoverClient', () => function MockDrawerHandoverClient({ shiftId }: any) { return <div>handover:{shiftId}</div>; });
jest.mock('@/components/interactions/InteractionsClient', () => function MockInteractionsClient({ totalCount }: any) { return <div>interactions:{totalCount}</div>; });

const owner = {
  id: 'owner-1',
  role: 'owner',
  permissions: {
    rep_can_view_sales: true,
    rep_can_view_purchases: true,
    rep_can_view_shifts: true,
    can_view_returns: true,
    acc_can_view_handover: true,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue(owner);
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
  (getOpenShiftHandoverAction as jest.Mock).mockResolvedValue({ success: true, data: { id: 'shift-open' } });
  (dbGet as jest.Mock).mockImplementation(async (sql: string) => ({ count: sql.includes('major') ? 3 : 10 }));
  (dbSelect as jest.Mock).mockResolvedValue([{ id: 1, ingredient_a: 'A', ingredient_b: 'B', severity: 'major' }]);
});

it('recovers the sales-report auth wrapper after a thrown session load', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<SalesReportsPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('sales-report-client')).toBeInTheDocument();
});

it('recovers the purchases-report auth wrapper after a thrown session load', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<PurchasesReportsPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('purchases-report-client')).toBeInTheDocument();
});

it('recovers the returns-list auth wrapper after a thrown session load', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<ReturnsPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('returns-client')).toBeInTheDocument();
});

it('recovers the new-return auth wrapper after a thrown session load', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<NewSalesReturnPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('sales-return-client')).toBeInTheDocument();
});

it('recovers the shift-report auth wrapper without losing the requested shift id', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<ShiftReportPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('shift-report:shift-ctx')).toBeInTheDocument();
});

it('allows the shift-report wrapper from the dedicated report permission instead of a role allowlist', async () => {
  (getClientSession as jest.Mock).mockResolvedValueOnce({
    id: 'shift-reporter',
    role: 'cashier',
    permissions: { rep_can_view_shifts: true },
  });

  render(<ShiftReportPage />);

  expect(await screen.findByText('shift-report:shift-ctx')).toBeInTheDocument();
  expect(screen.queryByText('access-denied')).not.toBeInTheDocument();
});

it('distinguishes a failed handover-state load from a legitimate no-open-shift state and retries', async () => {
  (getOpenShiftHandoverAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'handover unavailable' })
    .mockResolvedValueOnce({ success: true, data: { id: 'shift-recovered' } });

  render(<HandoverPage />);

  expect(await screen.findByText('تعذر تحميل حالة التسليم')).toBeInTheDocument();
  expect(screen.queryByText('لا توجد وردية مفتوحة حالياً')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('handover:shift-recovered')).toBeInTheDocument();
});

it('distinguishes a failed interactions load from a legitimate zero-interaction state and retries', async () => {
  (dbGet as jest.Mock)
    .mockRejectedValueOnce(new Error('db unavailable'))
    .mockImplementation(async (sql: string) => ({ count: sql.includes('major') ? 3 : 10 }));

  render(<InteractionsPage />);

  expect(await screen.findByText('تعذر تحميل بيانات التفاعلات')).toBeInTheDocument();
  expect(screen.queryByText('interactions:0')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('interactions:10')).toBeInTheDocument();
});

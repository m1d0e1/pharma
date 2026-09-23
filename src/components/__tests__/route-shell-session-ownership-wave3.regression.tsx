import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuditPage from '@/app/(dashboard)/audit/page';
import ExpensesPage from '@/app/(dashboard)/expenses/page';
import PurchasesPage from '@/app/(dashboard)/purchases/page';
import CategoriesPage from '@/app/(dashboard)/stores/categories/page';
import HandoverPage from '@/app/(dashboard)/finance/handover/page';
import InteractionsPage from '@/app/(dashboard)/interactions/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getAuditLogsAction } from '@/app/actions-client/audit';
import { getOpenShiftHandoverAction } from '@/app/actions-client/handover';
import { getProductCategoriesAction } from '@/app/actions-client/master-drugs';
import { dbGet, dbSelect } from '@/lib/db/tauri';

const push = jest.fn();
const mockRouter = { push };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('next/link', () => function LinkStub({ href, children }: any) {
  return <a href={href}>{children}</a>;
});

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('@/app/actions-client/audit', () => ({
  getAuditLogsAction: jest.fn(),
}));

jest.mock('@/app/actions-client/handover', () => ({
  getOpenShiftHandoverAction: jest.fn(),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  getProductCategoriesAction: jest.fn(),
  addProductCategoryAction: jest.fn(),
  updateProductCategoryAction: jest.fn(),
  deleteProductCategoryAction: jest.fn(),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbGet: jest.fn(),
  dbSelect: jest.fn(),
}));

jest.mock('@/components/AccessDenied', () => function AccessDeniedStub() {
  return <div>access-denied</div>;
});

jest.mock('@/components/admin/AuditLogClient', () => function AuditLogClientStub({ initialLogs }: any) {
  return <div>audit-client:{initialLogs.map((row: any) => row.id).join(',')}</div>;
});

jest.mock('@/components/expenses/ExpensesClient', () => function ExpensesClientStub() {
  return <div>expenses-client</div>;
});

jest.mock('@/components/inventory/ProductCategoriesManagement', () => function CategoriesClientStub({ initialData }: any) {
  return <div>categories-client:{initialData.map((row: any) => row.id).join(',')}</div>;
});

jest.mock('@/components/finance/DrawerHandoverClient', () => function DrawerHandoverClientStub({ shiftId }: any) {
  return <div>handover-client:{shiftId}</div>;
});

jest.mock('@/components/interactions/InteractionsClient', () => function InteractionsClientStub({ totalCount }: any) {
  return <div>interactions-client:{totalCount}</div>;
});

describe('route shell session ownership wave 3', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    push.mockReset();
    (getClientSession as jest.Mock).mockReset();
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => Boolean(user?.permissions?.[key]));
    (getAuditLogsAction as jest.Mock).mockReset();
    (getOpenShiftHandoverAction as jest.Mock).mockReset();
    (getProductCategoriesAction as jest.Mock).mockReset();
    (dbGet as jest.Mock).mockReset().mockResolvedValue({ count: 0 });
    (dbSelect as jest.Mock).mockReset().mockResolvedValue([]);
  });

  it('does not keep an earlier audit authorization when retry finds no current session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'audit-owner', role: 'owner', permissions: { can_view_audit: true } })
      .mockResolvedValueOnce(null);
    (getAuditLogsAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'audit unavailable' });

    render(<AuditPage />);
    expect(await screen.findByText('تعذر تحميل سجل التدقيق')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText(/^audit-client:/)).not.toBeInTheDocument();
  });

  it('does not keep an earlier handover authorization when retry finds no current session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'handover-user', role: 'admin', permissions: { acc_can_view_handover: true } })
      .mockResolvedValueOnce(null);
    (getOpenShiftHandoverAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'handover unavailable' });

    render(<HandoverPage />);
    expect(await screen.findByText('تعذر تحميل حالة التسليم')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد وردية مفتوحة حالياً')).not.toBeInTheDocument();
  });

  it('does not render stale interaction data when retry finds no current session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'interaction-user', role: 'pharmacist' })
      .mockResolvedValueOnce(null);
    (dbGet as jest.Mock).mockRejectedValueOnce(new Error('interaction db unavailable'));

    render(<InteractionsPage />);
    expect(await screen.findByText('تعذر تحميل بيانات التفاعلات')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    await waitFor(() => expect(screen.queryByText('فحص التفاعلات الدوائية')).not.toBeInTheDocument());
    expect(screen.queryByText(/^interactions-client:/)).not.toBeInTheDocument();
  });

  it('does not let an older purchases-hub retry re-authorize after a newer missing session', async () => {
    let resolveOlder!: (value: unknown) => void;
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('initial session failure'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockResolvedValueOnce(null);

    render(<PurchasesPage />);
    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    await act(async () => {
      resolveOlder({ id: 'purchase-owner', role: 'admin', permissions: { can_view_purchases: true } });
    });

    expect(screen.getByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText('إدارة المشتريات')).not.toBeInTheDocument();
  });

  it('surfaces and retries an expenses session transport failure instead of spinning forever', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockResolvedValueOnce({ id: 'expense-viewer', role: 'pharmacist', permissions: { can_view_expenses: true } });

    render(<ExpensesPage />);

    expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('expenses-client')).toBeInTheDocument();
  });

  it('surfaces and retries a categories session transport failure before loading category data', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockResolvedValueOnce({ id: 'category-viewer', role: 'pharmacist' });
    (getProductCategoriesAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 'category-recovered' }] });

    render(<CategoriesPage />);

    expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
    expect(getProductCategoriesAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('categories-client:category-recovered')).toBeInTheDocument();
  });
});

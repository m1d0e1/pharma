import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SuppliersPage from '@/app/(dashboard)/purchases/suppliers/page';
import SuppliersManagementClient from '@/components/purchases/SuppliersManagementClient';
import {
  addSupplierAction,
  addSupplierPaymentAction,
  deleteSupplierAction,
  getSuppliersAction,
  getSupplierTransactionsAction,
  updateSupplierAction,
} from '@/app/actions-client/purchases';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

jest.mock('@/lib/env', () => ({ isTauri: false }));

jest.mock('@/app/actions-client/purchases', () => ({
  getSuppliersAction: jest.fn(),
  addSupplierAction: jest.fn(),
  updateSupplierAction: jest.fn(),
  deleteSupplierAction: jest.fn(),
  addSupplierPaymentAction: jest.fn(),
  getSupplierTransactionsAction: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

const suppliers = [
  { id: 1, name_ar: 'مورد مدين', name_en: 'Debit Supplier', phone: '01010000000', address: 'Cairo', balance: 500 },
  { id: 2, name_ar: 'مورد خالص', name_en: 'Clear Supplier', phone: '01020000000', address: 'Giza', balance: 0 },
];

// Exercise pending-write safeguards at the component boundary. The web page
// deliberately cannot enable supplier CRUD or settlement anymore.
type DirectoryProps = Parameters<typeof SuppliersManagementClient>[0];
function renderIsolatedSupplierDirectory(overrides: Partial<DirectoryProps> = {}) {
  return render(<SuppliersManagementClient
    initialData={suppliers}
    onAdd={async () => ({ success: false })}
    onUpdate={async () => ({ success: false })}
    onDelete={async () => ({ success: false })}
    onRefresh={async () => {}}
    canMutate
    canPay
    {...overrides}
  />);
}

describe('coverage-gap: supplier management UI permissions and interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: suppliers });
    (getSupplierTransactionsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 9, type: 'invoice', amount: 200, notes: 'Invoice row', date: '2026-09-20', reference_id: 'invoice-123456' }],
    });
  });

  it('explains verified-ownership supplier denial, hides supplier actions, and offers a safe retry', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'qa-owner', role: 'owner', pharmacy_id: 'local_default', permissions: { can_view_suppliers: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    (getSuppliersAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Legacy purchasing ownership needs independent tenant verification' })
      .mockResolvedValueOnce({ success: true, data: suppliers });

    render(<SuppliersPage />);
    expect(await screen.findByText(/تعذر التحقق من ملكية بيانات الموردين/)).toBeInTheDocument();
    expect(screen.queryByText('مورد مدين')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /إضافة مورد جديد/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('مورد مدين')).toBeInTheDocument();
    expect(getSuppliersAction).toHaveBeenCalledTimes(2);
  });

  it('keeps delegated supplier viewers read-only while preserving search, filters, and statement access', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'viewer-1', role: 'manager', permissions: { can_view_suppliers: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);

    render(<SuppliersPage />);
    expect(await screen.findByText('مورد مدين')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /إضافة مورد جديد/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle('تعديل')).not.toBeInTheDocument();
    expect(screen.queryByTitle('حذف')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('البحث بالاسم، الهاتف، أو العنوان...'), { target: { value: 'Clear' } });
    expect(screen.queryByText('مورد مدين')).not.toBeInTheDocument();
    expect(screen.getByText('مورد خالص')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('البحث بالاسم، الهاتف، أو العنوان...'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /مديونيات/ }));
    expect(screen.getByText('مورد مدين')).toBeInTheDocument();
    expect(screen.queryByText('مورد خالص')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'كشف الحساب' }));
    await waitFor(() => expect(getSupplierTransactionsAction).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Invoice row')).toBeInTheDocument();
  });

  it('keeps web admin supplier actions hidden even with supplier and cash-flow permissions, while allowing statements', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      permissions: { can_view_suppliers: true, acc_can_process_cash_flow: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    (addSupplierAction as jest.Mock).mockResolvedValue({ success: true, id: 3 });
    (updateSupplierAction as jest.Mock).mockResolvedValue({ success: true });
    (deleteSupplierAction as jest.Mock).mockResolvedValue({ success: true });
    (addSupplierPaymentAction as jest.Mock).mockResolvedValue({ success: true });

    render(<SuppliersPage />);
    expect(await screen.findByText('مورد مدين')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /إضافة مورد جديد/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle('تعديل')).not.toBeInTheDocument();
    expect(screen.queryByTitle('حذف')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'كشف الحساب' })[0]);
    expect(await screen.findByText('Invoice row')).toBeInTheDocument();
    expect(addSupplierAction).not.toHaveBeenCalled();
    expect(updateSupplierAction).not.toHaveBeenCalled();
    expect(deleteSupplierAction).not.toHaveBeenCalled();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
  });

  it('treats ambiguous shared supplier balances as unknown and blocks settlement', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-1', role: 'admin',
      permissions: { can_view_suppliers: true, acc_can_process_cash_flow: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { id: 1, name_ar: 'مورد مدين', balance: 500 },
        { id: 2, name_ar: 'مورد غير متحقق', balance: null },
      ],
    });
    render(<SuppliersPage />);
    expect(await screen.findByText('مورد غير متحقق')).toBeInTheDocument();
    expect(screen.getByText('يتطلب تحقق ملكية الرصيد')).toBeInTheDocument();
    expect(screen.getByText(/لا يشمل 1 رصيد غير متحقق/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'خالصة (0)' })).toBeInTheDocument();
  });

  it('keeps a purchase-only admin supplier view read-only when can_view_suppliers is explicitly denied', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-purchase-only',
      role: 'admin',
      permissions: { can_view_purchases: true, can_view_suppliers: false, acc_can_process_cash_flow: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);

    render(<SuppliersPage />);
    expect(await screen.findByText('مورد مدين')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /إضافة مورد جديد/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle('تعديل')).not.toBeInTheDocument();
    expect(screen.queryByTitle('حذف')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
  });

  it('shows a retryable statement error instead of presenting a failed statement request as an empty account', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'viewer-1', role: 'manager', permissions: { can_view_suppliers: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    (getSupplierTransactionsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'statement unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 10, type: 'invoice', amount: 50, notes: 'Recovered statement row', date: '2026-09-21', reference_id: 'invoice-recovered' }],
      });

    render(<SuppliersPage />);
    await screen.findByText('مورد مدين');
    fireEvent.click(screen.getAllByRole('button', { name: 'كشف الحساب' })[0]);

    expect(await screen.findByText('تعذر تحميل كشف حساب المورد')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد حركات مسجلة لهذا المورد حتى الآن')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('Recovered statement row')).toBeInTheDocument();
  });

  it('keeps the newer supplier statement when an older statement request resolves afterwards', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'viewer-1', role: 'manager', permissions: { can_view_suppliers: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    let resolveFirst: (value: any) => void = () => {};
    let resolveSecond: (value: any) => void = () => {};
    (getSupplierTransactionsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    render(<SuppliersPage />);
    await screen.findByText('مورد مدين');
    fireEvent.click(screen.getAllByRole('button', { name: 'كشف الحساب' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'كشف الحساب' })[1]);

    await act(async () => resolveSecond({
      success: true,
      data: [{ id: 11, type: 'invoice', amount: 75, notes: 'Newest supplier row', date: '2026-09-21', reference_id: 'newest-row' }],
    }));
    expect(await screen.findByText('Newest supplier row')).toBeInTheDocument();

    await act(async () => resolveFirst({
      success: true,
      data: [{ id: 12, type: 'invoice', amount: 25, notes: 'Stale supplier row', date: '2026-09-20', reference_id: 'stale-row' }],
    }));

    expect(screen.getByText('Newest supplier row')).toBeInTheDocument();
    expect(screen.queryByText('Stale supplier row')).not.toBeInTheDocument();
  });

  it('blocks repeated supplier creates while the first write is pending', async () => {
    let resolveAdd: (value: { success: boolean; id?: number; error?: string }) => void = () => {};
    const onAdd = jest.fn(() => new Promise<{ success: boolean; id?: number; error?: string }>(resolve => { resolveAdd = resolve; }));

    renderIsolatedSupplierDirectory({ onAdd });
    fireEvent.click(screen.getByRole('button', { name: /إضافة مورد جديد/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: شركة ابن سينا فارما'), { target: { value: 'مورد اختبار' } });
    const saveButton = screen.getByRole('button', { name: 'حفظ البيانات' });

    act(() => {
      fireEvent.click(saveButton);
      fireEvent.click(saveButton);
    });

    expect(onAdd).toHaveBeenCalledTimes(1);
    await act(async () => resolveAdd({ success: false, error: 'supplier write rejected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeEnabled());
  });

  it('keeps the supplier form open until an in-flight write completes', async () => {
    let resolveAdd: (value: { success: boolean; error?: string }) => void = () => {};
    const onAdd = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => { resolveAdd = resolve; }));

    renderIsolatedSupplierDirectory({ onAdd });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مورد جديد' }));
    fireEvent.change(screen.getByPlaceholderText('مثال: شركة ابن سينا فارما'), { target: { value: 'مورد انتظار' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    const close = screen.getByRole('button', { name: 'إغلاق بيانات المورد' });
    const cancel = screen.getByRole('button', { name: 'إلغاء' });
    expect(close).toBeDisabled();
    expect(cancel).toBeDisabled();
    fireEvent.click(close);
    fireEvent.click(cancel);
    expect(screen.getByRole('dialog', { name: 'إضافة مورد جديد' })).toBeInTheDocument();

    await act(async () => resolveAdd({ success: false, error: 'supplier write rejected' }));
    expect(screen.getByRole('button', { name: 'إلغاء' })).toBeEnabled();
  });

  it('blocks repeated supplier payments while the first payment write is pending', async () => {
    let resolvePayment: (value: { success: boolean; error?: string }) => void = () => {};
    (addSupplierPaymentAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolvePayment = resolve; }));

    renderIsolatedSupplierDirectory();
    fireEvent.click(screen.getAllByRole('button', { name: 'سداد دفعة' })[0]);
    const paymentForm = screen.getByRole('button', { name: 'تأكيد السداد' }).closest('form') as HTMLFormElement;

    act(() => {
      fireEvent.submit(paymentForm);
      fireEvent.submit(paymentForm);
    });

    expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1);
    await act(async () => resolvePayment({ success: false, error: 'payment rejected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'تأكيد السداد' })).toBeEnabled());
  });

  it('blocks repeated supplier deletes while the first destructive write is pending', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    let resolveDelete: (value: { success: boolean; error?: string }) => void = () => {};
    const onDelete = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => { resolveDelete = resolve; }));

    renderIsolatedSupplierDirectory({ onDelete });
    const deleteButton = screen.getAllByTitle('حذف')[0];

    act(() => {
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    await act(async () => resolveDelete({ success: false, error: 'delete rejected' }));
    confirmSpy.mockRestore();
  });

  it('keeps the last supplier snapshot after a component create refresh fails and permits a later retry', async () => {
    const onAdd = jest.fn().mockResolvedValue({ success: true, id: 3 });
    const onRefresh = jest.fn()
      .mockRejectedValueOnce(new Error('refresh unavailable'))
      .mockResolvedValueOnce(undefined);
    renderIsolatedSupplierDirectory({ onAdd, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: /إضافة مورد جديد/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: شركة ابن سينا فارما'), { target: { value: 'مورد جديد' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByText('مورد مدين')).toBeInTheDocument();
    expect(screen.getByText('مورد خالص')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'إضافة مورد جديد' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /إضافة مورد جديد/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: شركة ابن سينا فارما'), { target: { value: 'مورد آخر' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(onAdd).toHaveBeenCalledTimes(2);
  });
});

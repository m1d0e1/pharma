import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SuppliersPage from '@/app/(dashboard)/purchases/suppliers/page';
import {
  addSupplierAction,
  addSupplierPaymentAction,
  deleteSupplierAction,
  getSuppliersAction,
  getSupplierTransactionsAction,
  updateSupplierAction,
} from '@/app/actions-client/purchases';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

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

describe('coverage-gap: supplier management UI permissions and interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: suppliers });
    (getSupplierTransactionsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 9, type: 'invoice', amount: 200, notes: 'Invoice row', date: '2026-09-20', reference_id: 'invoice-123456' }],
    });
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

  it('shows mutation and payment controls only when the corresponding action permissions are present', async () => {
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
    expect(screen.getByRole('button', { name: /إضافة مورد جديد/ })).toBeInTheDocument();
    expect(screen.getAllByTitle('تعديل')).toHaveLength(2);
    expect(screen.getAllByTitle('حذف')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'سداد دفعة' })).toHaveLength(2);
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
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-1', role: 'admin', permissions: { can_view_suppliers: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    let resolveAdd: (value: { success: boolean; id?: number; error?: string }) => void = () => {};
    (addSupplierAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveAdd = resolve; }));

    render(<SuppliersPage />);
    await screen.findByText('مورد مدين');
    fireEvent.click(screen.getByRole('button', { name: /إضافة مورد جديد/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: شركة ابن سينا فارما'), { target: { value: 'مورد اختبار' } });
    const saveButton = screen.getByRole('button', { name: 'حفظ البيانات' });

    act(() => {
      fireEvent.click(saveButton);
      fireEvent.click(saveButton);
    });

    expect(addSupplierAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveAdd({ success: false, error: 'supplier write rejected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeEnabled());
  });

  it('blocks repeated supplier payments while the first payment write is pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      permissions: { can_view_suppliers: true, acc_can_process_cash_flow: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    let resolvePayment: (value: { success: boolean; error?: string }) => void = () => {};
    (addSupplierPaymentAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolvePayment = resolve; }));

    render(<SuppliersPage />);
    await screen.findByText('مورد مدين');
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
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-1', role: 'admin', permissions: { can_view_suppliers: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    let resolveDelete: (value: { success: boolean; error?: string }) => void = () => {};
    (deleteSupplierAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveDelete = resolve; }));

    render(<SuppliersPage />);
    await screen.findByText('مورد مدين');
    const deleteButton = screen.getAllByTitle('حذف')[0];

    act(() => {
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
    });

    expect(deleteSupplierAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveDelete({ success: false, error: 'delete rejected' }));
    confirmSpy.mockRestore();
  });

  it('keeps the last valid supplier view after a committed create when the post-save refresh fails, and allows retry', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-1', role: 'admin', permissions: { can_view_suppliers: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
    (addSupplierAction as jest.Mock).mockResolvedValue({ success: true, id: 3 });
    (getSuppliersAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: suppliers })
      .mockResolvedValueOnce({ success: false, error: 'refresh unavailable' })
      .mockResolvedValueOnce({ success: true, data: [...suppliers, { id: 3, name_ar: 'مورد جديد', balance: 0 }] });

    render(<SuppliersPage />);
    expect(await screen.findByText('مورد مدين')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /إضافة مورد جديد/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: شركة ابن سينا فارما'), { target: { value: 'مورد جديد' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    await waitFor(() => expect(addSupplierAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('تعذر تحديث قائمة الموردين')).toBeInTheDocument();
    expect(screen.getByText('مورد مدين')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إعادة تحميل الموردين' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل الموردين' }));
    expect(await screen.findByText('مورد جديد')).toBeInTheDocument();
    expect(getSuppliersAction).toHaveBeenCalledTimes(3);
  });
});

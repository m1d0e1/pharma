import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SuppliersPage from '@/app/(dashboard)/purchases/suppliers/page';
import { addSupplierAction, getSuppliersAction, updateSupplierAction, deleteSupplierAction } from '@/app/actions-client/purchases';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { generateId } from '@/lib/db/tauri';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/db/tauri', () => ({ generateId: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  getSuppliersAction: jest.fn(), addSupplierAction: jest.fn(), updateSupplierAction: jest.fn(),
  deleteSupplierAction: jest.fn(), addSupplierPaymentAction: jest.fn(), getSupplierTransactionsAction: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn(), hasUserPermissionSync: jest.fn() }));
jest.mock('react-hot-toast', () => ({ __esModule: true, toast: { success: jest.fn(), error: jest.fn() } }));

const FIRST = '1c90c45b-911e-4455-9b8a-f796358e7051';
const SECOND = 'a7908262-56de-4dab-a118-a50f32a57d42';
const owner = { id: 'owner-1', role: 'owner', pharmacy_id: 'tenant-a', permissions: { can_view_suppliers: true } };

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue(owner);
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
  (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (generateId as jest.Mock).mockReturnValueOnce(FIRST).mockReturnValueOnce(SECOND);
});

it('shows create only for eligible native owners; edit and delete stay hidden', async () => {
  render(<SuppliersPage />);
  expect(await screen.findByRole('button', { name: 'إضافة مورد جديد' })).toBeEnabled();
  expect(screen.queryByTitle('تعديل')).not.toBeInTheDocument();
  expect(screen.queryByTitle('حذف')).not.toBeInTheDocument();
  expect(updateSupplierAction).not.toHaveBeenCalled();
  expect(deleteSupplierAction).not.toHaveBeenCalled();
});

it('retains the same UUIDv4 for an ambiguous reply and exact UI retry, including after modal close/reopen', async () => {
  (addSupplierAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'Native response unavailable' })
    .mockResolvedValueOnce({ success: true, id: 77 });
  render(<SuppliersPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'إضافة مورد جديد' }));
  fireEvent.change(screen.getByLabelText('اسم المورد (بالعربي) *'), { target: { value: 'مورد تجريبي' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
  await waitFor(() => expect(addSupplierAction).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'إلغاء' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
  fireEvent.click(screen.getByRole('button', { name: 'إضافة مورد جديد' }));
  expect((screen.getByLabelText('اسم المورد (بالعربي) *') as HTMLInputElement).value).toBe('مورد تجريبي');
  fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
  await waitFor(() => expect(addSupplierAction).toHaveBeenCalledTimes(2));
  expect((addSupplierAction as jest.Mock).mock.calls.map(([payload]) => payload.request_id)).toEqual([FIRST, FIRST]);
  expect(generateId).toHaveBeenCalledTimes(1);
});

it('does not silently allocate a new UUID for edited details after ambiguous result', async () => {
  (addSupplierAction as jest.Mock).mockResolvedValue({ success: false, error: 'Native response unavailable' });
  render(<SuppliersPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'إضافة مورد جديد' }));
  fireEvent.change(screen.getByLabelText('اسم المورد (بالعربي) *'), { target: { value: 'مورد أول' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
  await waitFor(() => expect(addSupplierAction).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('اسم المورد (بالعربي) *'), { target: { value: 'مورد ثان' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
  expect(addSupplierAction).toHaveBeenCalledTimes(1);
  expect(generateId).toHaveBeenCalledTimes(1);
});

it.each([
  { role: 'manager', pharmacy_id: 'tenant-a', permissions: { can_view_suppliers: true } },
  { role: 'owner', pharmacy_id: 'local_default', permissions: { can_view_suppliers: true } },
  { role: 'owner', pharmacy_id: 'tenant-a', permissions: { can_view_suppliers: false } },
])('does not display create for unauthorized or unresolved owner scope: %j', async session => {
  (getClientSession as jest.Mock).mockResolvedValue({ ...owner, ...session });
  render(<SuppliersPage />);
  expect(await screen.findByText('لم يتم العثور على موردين مطابقة للبحث')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'إضافة مورد جديد' })).not.toBeInTheDocument();
  expect(addSupplierAction).not.toHaveBeenCalled();
});

it('hides native supplier settlement even with cash-flow permission when tenant is unresolved', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({
    ...owner, pharmacy_id: 'local_default',
    permissions: { can_view_suppliers: true, acc_can_process_cash_flow: true },
  });
  (getSuppliersAction as jest.Mock).mockResolvedValue({
    success: true,
    data: [{ id: 7, name_ar: 'Unattributed shared supplier', balance: null }],
  });
  render(<SuppliersPage />);
  expect(await screen.findByText('Unattributed shared supplier')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'إضافة مورد جديد' })).not.toBeInTheDocument();
});

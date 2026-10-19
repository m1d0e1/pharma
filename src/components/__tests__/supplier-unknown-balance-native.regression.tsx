import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SuppliersPage from '@/app/(dashboard)/purchases/suppliers/page';
import SuppliersManagementClient from '@/components/purchases/SuppliersManagementClient';
import { addSupplierPaymentAction, getSuppliersAction, getSupplierTransactionsAction } from '@/app/actions-client/purchases';
import { getClientSession, getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { createHash } from 'node:crypto';
import { TextEncoder } from 'node:util';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/db/tauri', () => ({ generateId: () => '54f98447-9ab7-4b40-a70c-588de8395f62' }));
jest.mock('@/app/actions-client/purchases', () => ({
  addSupplierPaymentAction: jest.fn(),
  getSuppliersAction: jest.fn(),
  getSupplierTransactionsAction: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  getLocalSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  // The installed native WebView supplies SHA-256; jsdom does not.
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    value: { digest: jest.fn(async (_algorithm: string, bytes: Uint8Array) => {
      const digest = createHash('sha256').update(Buffer.from(bytes)).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
    }) },
  });
});

it('keeps native receipt-backed payments/statements and allows create only; edit/delete stay unavailable', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({
    id: 'native-admin', role: 'admin', pharmacy_id: 'tenant-a',
    permissions: { can_view_suppliers: true, acc_can_process_cash_flow: true },
  });
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user.permissions[key] === true);
  (getSuppliersAction as jest.Mock).mockResolvedValue({
    success: true, data: [{ id: 7, name_ar: 'مورد أصلي', balance: null }],
  });
  (getSupplierTransactionsAction as jest.Mock).mockResolvedValue({
    success: true, data: [{ id: 3, type: 'invoice', amount: 20, notes: 'Native tenant statement', reference_id: 'inv-7', date: '2026-10-16' }],
  });

  render(<SuppliersPage />);
  expect(await screen.findByText('مورد أصلي')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'سداد دفعة' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'إضافة مورد جديد' })).toBeInTheDocument();
  expect(screen.queryByTitle('تعديل')).not.toBeInTheDocument();
  expect(screen.queryByTitle('حذف')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'كشف الحساب' }));
  expect(await screen.findByText('Native tenant statement')).toBeInTheDocument();
  expect(getSupplierTransactionsAction).toHaveBeenCalledWith(7);
});

it('does not offer native supplier payment without cash-flow permission', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({
    id: 'native-viewer', role: 'manager', pharmacy_id: 'tenant-a',
    permissions: { can_view_suppliers: true, acc_can_process_cash_flow: false },
  });
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user.permissions[key] === true);
  (getSuppliersAction as jest.Mock).mockResolvedValue({
    success: true, data: [{ id: 7, name_ar: 'مورد أصلي', balance: null }],
  });

  render(<SuppliersPage />);
  expect(await screen.findByText('مورد أصلي')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'كشف الحساب' })).toBeInTheDocument();
});

it('offers a manual amount for a native supplier with uncertified directory balance, letting the native writer reject unverified money', async () => {
  // Only an independently authorized synthetic actor may reach the writer,
  // which must still reject this source with unverifiable supplier balance.
  (getLocalSession as jest.Mock).mockResolvedValue({
    id: 'native-owner', role: 'owner', pharmacy_id: 'tenant-a',
    permissions: { can_view_suppliers: true, acc_can_process_cash_flow: true },
  });
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) =>
    user?.permissions?.[key] === true);
  (addSupplierPaymentAction as jest.Mock).mockResolvedValue({ success: false, error: 'Supplier ownership is unverifiable' });
  render(<SuppliersManagementClient
    initialData={[{ id: 7, name_ar: 'مورد مستحقات غير متحققة', balance: null }]}
    onAdd={async () => ({ success: false })}
    onUpdate={async () => ({ success: false })}
    onDelete={async () => ({ success: false })}
    onRefresh={async () => {}}
    canPay
  />);

  expect(screen.getByText('يتطلب تحقق ملكية الرصيد')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'سداد دفعة' }));
  const amount = screen.getByLabelText('مبلغ السداد (ج.م) *') as HTMLInputElement;
  expect(amount.value).toBe('');
  expect(screen.getByText('الرصيد غير متحقق لدى المصدر الأصلي')).toBeInTheDocument();
  fireEvent.change(amount, { target: { value: '20' } });
  fireEvent.click(screen.getByRole('button', { name: 'تأكيد السداد' }));
  await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledWith(expect.objectContaining({
    supplier_id: 7, amount: 20, request_id: '54f98447-9ab7-4b40-a70c-588de8395f62',
  })));
});

it('does not offer native supplier directory writes that the action layer always refuses', () => {
  render(<SuppliersManagementClient
    initialData={[{ id: 7, name_ar: 'مورد مسجل', balance: null }]}
    onAdd={jest.fn(async () => ({ success: false }))}
    onUpdate={jest.fn(async () => ({ success: false }))}
    onDelete={jest.fn(async () => ({ success: false }))}
    onRefresh={async () => {}}
    canMutate
    canPay
  />);

  expect(screen.getByText('مورد مسجل')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'إضافة مورد جديد' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'تعديل المورد مورد مسجل' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'حذف المورد مورد مسجل' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'كشف الحساب' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'سداد دفعة' })).toBeInTheDocument();
});

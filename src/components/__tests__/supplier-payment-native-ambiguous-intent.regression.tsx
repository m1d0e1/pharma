import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SuppliersManagementClient from '@/components/purchases/SuppliersManagementClient';
import { addSupplierPaymentAction } from '@/app/actions-client/purchases';
import { generateId } from '@/lib/db/tauri';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';
import { createHash } from 'node:crypto';
import { TextEncoder } from 'node:util';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/db/tauri', () => ({ generateId: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(),
  hasUserPermissionSync: jest.fn((session, permission) =>
    session?.role === 'owner' || session?.permissions?.[permission] === true),
}));
jest.mock('@/app/actions-client/purchases', () => ({
  addSupplierPaymentAction: jest.fn(), getSupplierTransactionsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const firstNonce = 'a7f74c6a-9d89-4d55-9833-9a15492ce017';
const secondNonce = 'f52fa61a-1dc5-43f0-8651-0ed9ba3c538f';

function openSource(source: string) {
  const card = screen.getByText(source).closest('.group') as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: 'سداد دفعة' }));
}

function submit(dialog: HTMLElement) {
  fireEvent.submit(within(dialog).getByRole('button', { name: 'تأكيد السداد' }).closest('form')!);
}

it('pins the exact native supplier intent across uncertain acknowledgement, closure and retry', async () => {
  jest.resetAllMocks();
  (hasUserPermissionSync as jest.Mock).mockImplementation((session, permission) =>
    session?.role === 'owner' || session?.permissions?.[permission] === true);
  (getLocalSession as jest.Mock).mockResolvedValue({
    id: 'owner-a', pharmacy_id: 'tenant-a', role: 'owner',
  });
  // Native runs in a secure WebView with Web Crypto. jsdom does not provide
  // subtle.digest or TextEncoder, so exercise real SHA-256 for this mock-only UI.
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    value: { digest: jest.fn(async (_algorithm: string, bytes: Uint8Array) => {
      const digest = createHash('sha256').update(Buffer.from(bytes)).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
    }) },
  });
  (generateId as jest.Mock).mockReturnValueOnce(firstNonce).mockReturnValueOnce(secondNonce);
  (addSupplierPaymentAction as jest.Mock).mockRejectedValueOnce(new Error('IPC reply unknown'))
    .mockResolvedValue({ success: true });
  render(<SuppliersManagementClient
    initialData={[
      { id: 21, name_ar: 'مورد أ', name_en: 'Supplier Intent A', balance: null },
      { id: 22, name_ar: 'مورد ب', name_en: 'Supplier Intent B', balance: null },
    ]}
    onAdd={jest.fn()} onUpdate={jest.fn()} onDelete={jest.fn()}
    onRefresh={jest.fn().mockResolvedValue(undefined)} canPay
  />);

  openSource('Supplier Intent A');
  let dialog = screen.getByRole('dialog', { name: 'سداد دفعة للمورد' });
  const amount = within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' });
  fireEvent.change(amount, { target: { value: '17.35' } });
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'طريقة الدفع' }), {
    target: { value: 'bank' },
  });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'ملاحظات / البيان' }), {
    target: { value: 'Provenance-backed isolated remittance' },
  });
  submit(dialog);
  await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(/نفس الطلب فقط/));
  expect(amount).toBeDisabled();
  expect(within(dialog).getByRole('combobox', { name: 'طريقة الدفع' })).toBeDisabled();
  expect(within(dialog).getByRole('textbox', { name: 'ملاحظات / البيان' })).toBeDisabled();
  expect((addSupplierPaymentAction as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({
    supplier_id: 21, amount: 17.35, payment_method: 'bank', request_id: firstNonce,
  }));

  fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
  expect(screen.queryByRole('dialog', { name: 'سداد دفعة للمورد' })).not.toBeInTheDocument();
  openSource('Supplier Intent B');
  expect(screen.queryByRole('dialog', { name: 'سداد دفعة للمورد' })).not.toBeInTheDocument();
  expect(toast.error).toHaveBeenCalledWith('يجب مراجعة إيصال سداد المورد السابق قبل بدء طلب مالي آخر');
  expect(generateId).toHaveBeenCalledTimes(1);

  openSource('Supplier Intent A');
  dialog = screen.getByRole('dialog', { name: 'سداد دفعة للمورد' });
  expect(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' })).toHaveValue(17.35);
  expect(within(dialog).getByRole('combobox', { name: 'طريقة الدفع' })).toHaveValue('bank');
  expect(within(dialog).getByRole('textbox', { name: 'ملاحظات / البيان' }))
    .toHaveValue('Provenance-backed isolated remittance');
  await act(async () => { submit(dialog); });
  await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledTimes(2));
  expect((addSupplierPaymentAction as jest.Mock).mock.calls[1]).toEqual(
    (addSupplierPaymentAction as jest.Mock).mock.calls[0]);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'سداد دفعة للمورد' })).not.toBeInTheDocument());

  openSource('Supplier Intent B');
  expect(screen.getByRole('dialog', { name: 'سداد دفعة للمورد' })).toBeInTheDocument();
  expect(generateId).toHaveBeenCalledTimes(2);
});

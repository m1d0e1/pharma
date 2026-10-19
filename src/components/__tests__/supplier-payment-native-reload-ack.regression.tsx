import { createHash } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SuppliersManagementClient from '@/components/purchases/SuppliersManagementClient';
import { addSupplierPaymentAction } from '@/app/actions-client/purchases';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { generateId } from '@/lib/db/tauri';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-hot-toast';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/db/tauri', () => ({ generateId: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(),
  hasUserPermissionSync: jest.fn((session, permission) =>
    session?.role === 'owner' || session?.permissions?.[permission] === true),
}));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  addSupplierPaymentAction: jest.fn(), getSupplierTransactionsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const RECOVERY_KEY = 'pharma:supplier-payment-recovery:v1';
const FIRST_NONCE = 'a7f74c6a-9d89-4d55-9833-9a15492ce017';
const SECOND_NONCE = 'f52fa61a-1dc5-43f0-8651-0ed9ba3c538f';
const INVOICE_UUID = 'b3e11a19-8083-410f-9ce5-6c8ff262c0ce';
const RECEIPT_UUID = '733a0028-4130-4dc5-8b50-6ef2bc9cad38';
const notesDigest = (notes = '') => createHash('sha256').update(notes.trim(), 'utf8').digest('hex');

const suppliers = [
  { id: 21, name_ar: 'المورد الأول', name_en: 'Supplier One', balance: null },
  { id: 22, name_ar: 'المورد الثاني', name_en: 'Supplier Two', balance: null },
];
const onRefresh = jest.fn<Promise<void>, []>();
const props = { initialData: suppliers, onAdd: jest.fn(), onUpdate: jest.fn(), onDelete: jest.fn(), onRefresh, canPay: true };

function openPayment(supplier: 'Supplier One' | 'Supplier Two' = 'Supplier One') {
  const card = screen.getByText(supplier).closest('.group') as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: 'سداد دفعة' }));
  return screen.getByRole('dialog', { name: 'سداد دفعة للمورد' });
}

function submitPayment(dialog: HTMLElement) {
  fireEvent.submit(within(dialog).getByRole('button', { name: 'تأكيد السداد' }).closest('form')!);
}

function persistedHint(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, requestId: FIRST_NONCE, supplierId: 21, invoiceId: null,
    amountCents: 1735, paymentMethod: 'bank', paymentDate: '2026-10-17',
    notesSha256: notesDigest(), ...overrides,
  };
}

function nativeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_UUID, supplierId: 21, invoiceId: INVOICE_UUID, actorId: 'owner-a',
    pharmacyId: 'tenant-a', amountCents: 1735, remainingBalance: 82.65,
    ...overrides,
  };
}

describe('native supplier payment reload acknowledgement', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (hasUserPermissionSync as jest.Mock).mockImplementation((session, permission) =>
      session?.role === 'owner' || session?.permissions?.[permission] === true);
    window.localStorage.clear();
    (generateId as jest.Mock).mockReturnValueOnce(FIRST_NONCE).mockReturnValueOnce(SECOND_NONCE);
    (getLocalSession as jest.Mock).mockResolvedValue({
      id: 'owner-a', pharmacy_id: 'tenant-a', role: 'owner',
    });
    onRefresh.mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      value: { digest: jest.fn(async (_algorithm: string, bytes: Uint8Array) => {
        const digest = createHash('sha256').update(Buffer.from(bytes)).digest();
        return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
      }) },
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: undefined });
  });

  it('durably records a privacy-limited exact-cent hint before the native write, then only confirms on reload', async () => {
    const secretNotes = 'Sensitive supplier memo: do not save locally';
    (addSupplierPaymentAction as jest.Mock).mockImplementationOnce(async () => {
      const raw = window.localStorage.getItem(RECOVERY_KEY)!;
      expect(raw).not.toContain(secretNotes);
      expect(JSON.parse(raw)).toEqual(persistedHint({ notesSha256: notesDigest(secretNotes) }));
      throw new Error('native commit acknowledgement lost');
    });
    (invoke as jest.Mock).mockResolvedValueOnce(nativeReceipt());
    const view = render(<SuppliersManagementClient {...props} />);
    const dialog = openPayment();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' }), {
      target: { value: '17.35' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'طريقة الدفع' }), {
      target: { value: 'bank' },
    });
    fireEvent.change(within(dialog).getByLabelText('تاريخ السداد'), {
      target: { value: '2026-10-17' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'ملاحظات / البيان' }), {
      target: { value: secretNotes },
    });
    submitPayment(dialog);
    await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1));
    expect((addSupplierPaymentAction as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({
      supplier_id: 21, amount: 17.35, request_id: FIRST_NONCE, notes: secretNotes,
    }));
    expect(generateId).toHaveBeenCalledTimes(1);
    view.unmount();

    // Backend read accepts the original immutable note digest. The frontend
    // must not reconstruct the note or dispatch a second financial write.
    const reopened = render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('confirm_supplier_payment_native', {
      payload: {
        supplierId: 21, amount: 17.35, paymentMethod: 'bank',
        date: '2026-10-17', requestId: FIRST_NONCE,
        notesSha256: notesDigest(secretNotes),
      },
    }));
    await waitFor(() => expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull());
    expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('تم تأكيد إيصال سداد المورد السابق من المصدر الأصلي');
    openPayment('Supplier Two');
    expect(generateId).toHaveBeenCalledTimes(2);
    reopened.unmount();
  });

  it('blocks another financial intent when the original receipt is not yet found', async () => {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint()));
    (invoke as jest.Mock).mockResolvedValueOnce(null);
    render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد'));
    const button = within(screen.getByText('Supplier Two').closest('.group') as HTMLElement)
      .getByRole('button', { name: 'سداد دفعة' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog', { name: 'سداد دفعة للمورد' })).not.toBeInTheDocument();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
  });

  it.each([
    ['foreign actor', nativeReceipt({ actorId: 'owner-b' })],
    ['foreign pharmacy', nativeReceipt({ pharmacyId: 'tenant-b' })],
    ['changed supplier', nativeReceipt({ supplierId: 22 })],
    ['amount mismatch', nativeReceipt({ amountCents: 1736 })],
    ['fee added', nativeReceipt({ feeCents: 50 })],
    ['unverified invoice', nativeReceipt({ invoiceId: 'invoice-without-uuid' })],
    ['unverified receipt', nativeReceipt({ id: 'corrupt' })],
  ])('does not unlock or re-post on %s receipt', async (_description, receipt) => {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint()));
    (invoke as jest.Mock).mockResolvedValueOnce(receipt);
    render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد'));
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{broken'],
    ['foreign supplier/nonce', JSON.stringify(persistedHint({ requestId: 'not-a-uuid' }))],
    ['subcent amount', JSON.stringify(persistedHint({ amountCents: 17.35 }))],
    ['unexpected field', JSON.stringify(persistedHint({ supplierName: 'private data' }))],
    ['missing note digest', JSON.stringify(persistedHint({ notesSha256: null }))],
  ])('treats %s recovery storage as untrusted and blocks all new payments', async (_case, raw) => {
    window.localStorage.setItem(RECOVERY_KEY, raw);
    render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد'));
    expect(invoke).not.toHaveBeenCalled();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
  });

  it('refuses to post if Web Crypto is unavailable before durable storage', async () => {
    Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: undefined });
    render(<SuppliersManagementClient {...props} />);
    const dialog = openPayment();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' }), {
      target: { value: '17.35' },
    });
    submitPayment(dialog);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'تعذر تأمين بيانات استرداد السداد؛ لم يُرسل أي طلب مالي',
    ));
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد');
  });

  it('refuses the native write when local storage cannot persist the original nonce', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    try {
      render(<SuppliersManagementClient {...props} />);
      const dialog = openPayment();
      fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' }), {
        target: { value: '17.35' },
      });
      submitPayment(dialog);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
        'تعذر حفظ بيانات استرداد السداد؛ لم يُرسل أي طلب مالي',
      ));
      expect(addSupplierPaymentAction).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد');
    } finally {
      setItem.mockRestore();
    }
  });

  it('cannot clear a recovery marker without actor and tenant session evidence', async () => {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint()));
    (getLocalSession as jest.Mock).mockResolvedValueOnce({
      id: 'owner-a', pharmacy_id: 'local_default',
    });
    render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد'));
    expect(invoke).not.toHaveBeenCalled();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
  });

  it('keeps another nonce blocked while confirmation is unresolved, including interrupted reads', async () => {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint()));
    let failRead!: (error: Error) => void;
    (invoke as jest.Mock).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failRead = reject;
    }));
    render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent('جارٍ التحقق');
    expect(screen.queryByRole('dialog', { name: 'سداد دفعة للمورد' })).not.toBeInTheDocument();
    await act(async () => failRead(new Error('read unavailable')));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد'));
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
  });

  it('does not clear a changed untrusted hint when an older receipt confirmation resolves', async () => {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint()));
    let finishRead!: (receipt: unknown) => void;
    (invoke as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      finishRead = resolve;
    }));
    render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint({
      requestId: SECOND_NONCE, amountCents: 500,
    })));
    await act(async () => finishRead(nativeReceipt()));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد'));
    expect(JSON.parse(window.localStorage.getItem(RECOVERY_KEY)!)).toEqual(persistedHint({
      requestId: SECOND_NONCE, amountCents: 500,
    }));
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
  });

  it('retains the old nonce when login actor or pharmacy changes while the native receipt read is in flight', async () => {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint()));
    let finishRead!: (receipt: unknown) => void;
    (invoke as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      finishRead = resolve;
    }));
    (getLocalSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'owner-a', pharmacy_id: 'tenant-a', role: 'owner' })
      .mockResolvedValue({ id: 'owner-b', pharmacy_id: 'tenant-b', role: 'owner' });
    render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await act(async () => finishRead(nativeReceipt()));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد'));
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
  });

  it('does not consume a receipted nonce after supplier cash-flow permission is revoked for the same actor', async () => {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint()));
    let finishRead!: (receipt: unknown) => void;
    (invoke as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      finishRead = resolve;
    }));
    (getLocalSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'owner-a', pharmacy_id: 'tenant-a', role: 'owner' })
      .mockResolvedValue({
        id: 'owner-a', pharmacy_id: 'tenant-a', role: 'manager',
        permissions: { can_view_suppliers: true, acc_can_process_cash_flow: false },
      });
    render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await act(async () => finishRead(nativeReceipt()));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('تعذر تأكيد'));
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps a successful writer ACK quarantined if the financial actor changes before it returns', async () => {
    let finishWrite!: (result: unknown) => void;
    (addSupplierPaymentAction as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      finishWrite = resolve;
    }));
    const view = render(<SuppliersManagementClient {...props} />);
    const dialog = openPayment();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' }), {
      target: { value: '17.35' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'طريقة الدفع' }), {
      target: { value: 'bank' },
    });
    submitPayment(dialog);
    await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
    (getLocalSession as jest.Mock).mockResolvedValue({
      id: 'owner-b', pharmacy_id: 'tenant-b', role: 'owner',
    });
    await act(async () => finishWrite({ success: true, remainingBalance: 82.65 }));
    await waitFor(() => expect(screen.getAllByRole('alert').some(node =>
      node.textContent?.includes('تعذر تأكيد'))).toBe(true));
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(generateId).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('never invokes a new supplier payment when the native actor changes during durable-intent preparation', async () => {
    (getLocalSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'owner-a', pharmacy_id: 'tenant-a', role: 'owner' })
      .mockResolvedValue({ id: 'owner-b', pharmacy_id: 'tenant-b', role: 'owner' });
    render(<SuppliersManagementClient {...props} />);
    const dialog = openPayment();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' }), {
      target: { value: '17.35' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'طريقة الدفع' }), {
      target: { value: 'bank' },
    });
    submitPayment(dialog);
    await waitFor(() => expect(screen.getAllByRole('alert').some(node =>
      node.textContent?.includes('تعذر تأكيد'))).toBe(true));
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
    expect(generateId).toHaveBeenCalledTimes(1);
  });

  it('leaves the original marker intact when an unmounted recovery view receives a late receipt', async () => {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(persistedHint()));
    let finishRead!: (receipt: unknown) => void;
    (invoke as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      finishRead = resolve;
    }));
    const view = render(<SuppliersManagementClient {...props} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => finishRead(nativeReceipt()));
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
  });
});

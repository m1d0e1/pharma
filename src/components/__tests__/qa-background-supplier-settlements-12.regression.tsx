import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SuppliersManagementClient, { type SupplierItem } from '@/components/purchases/SuppliersManagementClient';
import { addSupplierPaymentAction, getSupplierTransactionsAction } from '@/app/actions-client/purchases';
import { generateId } from '@/lib/db/tauri';
import { toast } from 'react-hot-toast';

// React renders the real supplier directory, settlement dialog and statement.
// Both source readers and the financial writer are mocked; no IPC is executed.
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/db/tauri', () => ({ generateId: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  addSupplierPaymentAction: jest.fn(),
  getSupplierTransactionsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const suppliers: SupplierItem[] = [
  { id: 911, name_ar: 'مورد المصدر الأول', name_en: 'Source Supplier Eleven', phone: '01111111111', balance: 80.25 },
  { id: 912, name_ar: 'مورد المصدر الثاني', name_en: 'Source Supplier Twelve', phone: '01222222222', balance: 50.01 },
  { id: 913, name_ar: 'مورد مجهول الرصيد', name_en: 'Unknown Source', balance: null },
];

const onAdd = jest.fn();
const onUpdate = jest.fn();
const onDelete = jest.fn();
const onRefresh = jest.fn();

function renderSuppliers(canPay = true, canMutate = false) {
  return render(<SuppliersManagementClient
    initialData={suppliers}
    onAdd={onAdd}
    onUpdate={onUpdate}
    onDelete={onDelete}
    onRefresh={onRefresh}
    canPay={canPay}
    canMutate={canMutate}
  />);
}

function supplierCard(id: number) {
  return screen.getByText(suppliers.find(s => s.id === id)!.name_en!).closest('.group') as HTMLElement;
}

function openPayment(id: number) {
  fireEvent.click(within(supplierCard(id)).getByRole('button', { name: 'سداد دفعة' }));
  return screen.getByRole('dialog', { name: 'سداد دفعة للمورد' });
}

function submitPayment(dialog: HTMLElement) {
  fireEvent.submit(within(dialog).getByRole('button', { name: 'تأكيد السداد' }).closest('form')!);
}

describe('QA background supplier settlements: rendered source ownership and retry (mocked actions)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (generateId as jest.Mock)
      .mockReturnValueOnce('qa-supplier-source-911-request')
      .mockReturnValueOnce('qa-supplier-source-912-request');
    (addSupplierPaymentAction as jest.Mock).mockResolvedValue({ success: true });
    (getSupplierTransactionsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    onAdd.mockResolvedValue({ success: true });
    onUpdate.mockResolvedValue({ success: true });
    onDelete.mockResolvedValue({ success: true });
    onRefresh.mockResolvedValue(undefined);
  });

  it('calculates 50% of the chosen supplier balance with cent precision and sends its dated bank settlement to that exact source', async () => {
    renderSuppliers();
    const first = openPayment(911);
    const amount = within(first).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' });
    expect(amount).toHaveValue(80.25);
    fireEvent.click(within(first).getByRole('button', { name: '50%' }));
    expect(amount).toHaveValue(40.13);
    expect(within(first).getByText('40.12 ج.م')).toBeInTheDocument();
    fireEvent.change(within(first).getByRole('combobox', { name: 'طريقة الدفع' }), {
      target: { value: 'bank' },
    });
    fireEvent.change(within(first).getByLabelText('تاريخ السداد'), { target: { value: '2026-10-12' } });
    fireEvent.change(within(first).getByRole('textbox', { name: 'ملاحظات / البيان' }), {
      target: { value: 'Synthetic source bank remittance 911' },
    });
    submitPayment(first);
    await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledWith({
      supplier_id: 911, amount: 40.13, payment_method: 'bank', check_number: '',
      notes: 'Synthetic source bank remittance 911', date: '2026-10-12',
      request_id: 'qa-supplier-source-911-request',
    }));
    expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'سداد دفعة للمورد' })).not.toBeInTheDocument();
  });

  it('preserves exact source and request ID across denied payment then retries, allocating another ID for a different supplier', async () => {
    (addSupplierPaymentAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'synthetic treasury owner denied' })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true });
    renderSuppliers();
    const first = openPayment(911);
    fireEvent.click(within(first).getByRole('button', { name: '25%' }));
    expect(within(first).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' })).toHaveValue(20.06);
    submitPayment(first);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('synthetic treasury owner denied'));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(within(first).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' })).toHaveValue(20.06);
    expect(within(first).getByRole('button', { name: 'تأكيد السداد' })).toBeEnabled();
    submitPayment(first);
    await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledTimes(2));
    expect((addSupplierPaymentAction as jest.Mock).mock.calls[0]).toEqual(
      (addSupplierPaymentAction as jest.Mock).mock.calls[1],
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));

    const second = openPayment(912);
    fireEvent.click(within(second).getByRole('button', { name: 'كامل المبلغ (50.01)' }));
    expect(within(second).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' })).toHaveValue(50.01);
    submitPayment(second);
    await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledTimes(3));
    expect((addSupplierPaymentAction as jest.Mock).mock.calls[2][0]).toEqual(expect.objectContaining({
      supplier_id: 912, amount: 50.01, payment_method: 'cash',
      request_id: 'qa-supplier-source-912-request',
    }));
    expect(generateId).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
  });

  it('retains an unresolved supplier settlement dialog when Cancel or Close are clicked during its financial write', async () => {
    let settlePayment!: (value: { success: boolean; error?: string }) => void;
    (addSupplierPaymentAction as jest.Mock).mockImplementationOnce(() =>
      new Promise(resolve => { settlePayment = resolve; }));
    renderSuppliers();
    const dialog = openPayment(911);
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' }), {
      target: { value: '31.75' },
    });
    submitPayment(dialog);
    await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole('button', { name: 'جاري السداد...' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByRole('dialog', { name: 'سداد دفعة للمورد' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق سداد المورد' }));
    expect(screen.getByRole('dialog', { name: 'سداد دفعة للمورد' })).toBeInTheDocument();
    expect(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' })).toHaveValue(31.75);

    await act(async () => settlePayment({ success: false, error: 'synthetic supplier receipt timeout' }));
    expect(toast.error).toHaveBeenCalledWith('synthetic supplier receipt timeout');
    expect(screen.getByRole('button', { name: 'تأكيد السداد' })).toBeEnabled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('blocks missing, zero and negative settlement amounts and hides unknown or unauthorized money actions', async () => {
    const view = renderSuppliers(false);
    expect(screen.queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إضافة مورد جديد' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /تعديل المورد/ })).not.toBeInTheDocument();
    expect(screen.getByText('يتطلب تحقق ملكية الرصيد')).toBeInTheDocument();
    view.rerender(<SuppliersManagementClient
      initialData={suppliers} onAdd={onAdd} onUpdate={onUpdate}
      onDelete={onDelete} onRefresh={onRefresh} canPay
    />);
    expect(within(supplierCard(913)).queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'سداد دفعة' })).toHaveLength(2);

    const dialog = openPayment(911);
    const amount = within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' });
    fireEvent.change(amount, { target: { value: '0' } });
    submitPayment(dialog);
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال مبلغ دفع صحيح أكبر من الصفر');
    fireEvent.change(amount, { target: { value: '-10' } });
    submitPayment(dialog);
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('surfaces denied statement source reads then retries the same supplier, showing purchase, payment and return references', async () => {
    (getSupplierTransactionsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'synthetic journal source denied' })
      .mockResolvedValueOnce({ success: true, data: [
        { id: 'j-inv-911', type: 'invoice', amount: 150.25, date: '2026-09-20', reference_id: 'receipt-911-invoice-888', notes: 'Supplier 911 receipt' },
        { id: 'j-pay-911', type: 'payment', amount: 40.13, date: '2026-09-21', reference_id: 'payment-911-ref-777', notes: 'Supplier 911 settlement' },
        { id: 'j-ret-911', type: 'return', amount: 20.12, date: '2026-09-22', reference_id: 'return-911-ref-666', notes: 'Supplier 911 return' },
      ] });
    renderSuppliers(false);
    fireEvent.click(within(supplierCard(911)).getByRole('button', { name: 'كشف الحساب' }));
    const statement = await screen.findByRole('dialog', { name: 'كشف حساب المورد' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('synthetic journal source denied'));
    expect(within(statement).getByText('تعذر تحميل كشف حساب المورد')).toBeInTheDocument();
    expect(within(statement).queryByText('Supplier 911 receipt')).not.toBeInTheDocument();
    fireEvent.click(within(statement).getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await within(statement).findByText('Supplier 911 receipt')).toBeInTheDocument();
    expect(within(statement).getByText('Supplier 911 settlement')).toBeInTheDocument();
    expect(within(statement).getByText('Supplier 911 return')).toBeInTheDocument();
    expect(within(statement).getByText('فاتورة شراء')).toBeInTheDocument();
    expect(within(statement).getByText('سداد دفعة')).toBeInTheDocument();
    expect(within(statement).getByText('مرتجع شراء')).toBeInTheDocument();
    expect(within(statement).getByText('receipt-91')).toBeInTheDocument();
    expect(within(statement).getByText('payment-91')).toBeInTheDocument();
    expect(within(statement).getByText('return-911')).toBeInTheDocument();
    expect(getSupplierTransactionsAction).toHaveBeenNthCalledWith(1, 911);
    expect(getSupplierTransactionsAction).toHaveBeenNthCalledWith(2, 911);
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();
  });

  it('keeps supplier B statement when a delayed source A statement resolves after source selection changed', async () => {
    let settleOld!: (value: unknown) => void;
    (getSupplierTransactionsAction as jest.Mock).mockImplementation((id: number) => id === 911
      ? new Promise(resolve => { settleOld = resolve; })
      : Promise.resolve({ success: true, data: [
        { id: 'supplier-B-journal', type: 'payment', amount: 50.01, date: '2026-10-10', notes: 'Only supplier B payment', reference_id: 'source-B-payment' },
      ] }));
    renderSuppliers(false);
    fireEvent.click(within(supplierCard(911)).getByRole('button', { name: 'كشف الحساب' }));
    await waitFor(() => expect(getSupplierTransactionsAction).toHaveBeenCalledWith(911));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'كشف حساب المورد' })).getByRole('button', {
      name: 'إغلاق كشف حساب المورد',
    }));
    fireEvent.click(within(supplierCard(912)).getByRole('button', { name: 'كشف الحساب' }));
    expect(await screen.findByText('Only supplier B payment')).toBeInTheDocument();
    await act(async () => settleOld({ success: true, data: [
      { id: 'supplier-A-journal', type: 'invoice', amount: 500, notes: 'Stale supplier A invoice', reference_id: 'source-A-invoice' },
    ] }));
    const statement = screen.getByRole('dialog', { name: 'كشف حساب المورد' });
    expect(within(statement).getByText('Only supplier B payment')).toBeInTheDocument();
    expect(within(statement).queryByText('Stale supplier A invoice')).not.toBeInTheDocument();
    expect(within(statement).getByText('مورد المصدر الثاني (الرصيد: 50.01 ج.م)')).toBeInTheDocument();
    expect(getSupplierTransactionsAction).toHaveBeenNthCalledWith(1, 911);
    expect(getSupplierTransactionsAction).toHaveBeenNthCalledWith(2, 912);
  });
});

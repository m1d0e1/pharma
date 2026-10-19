import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SuppliersManagementClient, { type SupplierItem } from '@/components/purchases/SuppliersManagementClient';
import { addSupplierPaymentAction, getSupplierTransactionsAction } from '@/app/actions-client/purchases';
import { generateId } from '@/lib/db/tauri';
import { toast } from 'react-hot-toast';

// Render the actual supplier settlement controls. The financial writer and
// source reader are mocked; these tests never open a native database or IPC.
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/db/tauri', () => ({ generateId: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  addSupplierPaymentAction: jest.fn(),
  getSupplierTransactionsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const suppliers: SupplierItem[] = [
  { id: 741, name_ar: 'مورد المستحقات', name_en: 'Payable Supplier', balance: 175.25 },
  { id: 742, name_ar: 'مورد برصيد غير مثبت', name_en: 'Unknown Supplier', balance: null },
];
const onRefresh = jest.fn<Promise<void>, []>();
const onAdd = jest.fn();
const onUpdate = jest.fn();
const onDelete = jest.fn();

function renderDirectory(canPay = true) {
  return render(<SuppliersManagementClient
    initialData={suppliers}
    onAdd={onAdd}
    onUpdate={onUpdate}
    onDelete={onDelete}
    onRefresh={onRefresh}
    canPay={canPay}
  />);
}

function paymentDialog() {
  return screen.getByRole('dialog', { name: 'سداد دفعة للمورد' });
}

function openPayment() {
  const card = screen.getByText('Payable Supplier').closest('.group') as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: 'سداد دفعة' }));
  return paymentDialog();
}

function submitPayment() {
  fireEvent.submit(within(paymentDialog()).getByRole('button', { name: 'تأكيد السداد' }).closest('form')!);
}

describe('purchase-return QA: supplier settlement acknowledgement boundaries', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (generateId as jest.Mock).mockReturnValue('fe9c84b1-a39d-4d54-95d7-d2104d154741');
    (addSupplierPaymentAction as jest.Mock).mockResolvedValue({ success: true });
    (getSupplierTransactionsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    onRefresh.mockResolvedValue(undefined);
  });

  it('acknowledges the posted payment even if the subsequent supplier refresh throws', async () => {
    onRefresh.mockRejectedValueOnce(new Error('supplier directory refresh unavailable'));
    renderDirectory();
    const dialog = openPayment();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' }), {
      target: { value: '25.75' },
    });
    submitPayment();

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1);
    expect(addSupplierPaymentAction).toHaveBeenCalledWith(expect.objectContaining({
      supplier_id: 741,
      amount: 25.75,
      request_id: 'fe9c84b1-a39d-4d54-95d7-d2104d154741',
    }));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('تم سداد 25.75 ج.م'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تم تسجيل الدفعة، لكن تعذر تحديث قائمة الموردين'));
    expect(toast.error).not.toHaveBeenCalledWith('حدث خطأ أثناء تنفيذ عملية السداد');
    expect(screen.queryByRole('dialog', { name: 'سداد دفعة للمورد' })).not.toBeInTheDocument();
  });

  it('keeps an uncertain financial acknowledgement retryable with exactly the same supplier and request ID', async () => {
    let rejectFirst!: (error: Error) => void;
    (addSupplierPaymentAction as jest.Mock)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ success: true });
    renderDirectory();
    const dialog = openPayment();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' }), {
      target: { value: '22.50' },
    });

    const form = within(dialog).getByRole('button', { name: 'تأكيد السداد' }).closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(addSupplierPaymentAction).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'جاري السداد...' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(paymentDialog()).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => rejectFirst(new Error('IPC acknowledgement lost')));
    expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء تنفيذ عملية السداد');
    expect(within(dialog).getByRole('spinbutton', { name: 'مبلغ السداد (ج.م) *' })).toHaveValue(22.5);
    expect(within(dialog).getByRole('button', { name: 'تأكيد السداد' })).toBeEnabled();

    submitPayment();
    await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledTimes(2));
    expect((addSupplierPaymentAction as jest.Mock).mock.calls[1]).toEqual(
      (addSupplierPaymentAction as jest.Mock).mock.calls[0],
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'سداد دفعة للمورد' })).not.toBeInTheDocument();
  });

  it('hides payment actions without permission or a verified balance, and validates check details before writing', async () => {
    const view = renderDirectory(false);
    expect(screen.queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();

    view.rerender(<SuppliersManagementClient
      initialData={suppliers}
      onAdd={onAdd}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onRefresh={onRefresh}
      canPay
    />);
    const unknown = screen.getByText('Unknown Supplier').closest('.group') as HTMLElement;
    expect(within(unknown).queryByRole('button', { name: 'سداد دفعة' })).not.toBeInTheDocument();
    const dialog = openPayment();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'طريقة الدفع' }), {
      target: { value: 'check' },
    });
    expect(within(dialog).getByRole('textbox', { name: 'رقم الشيك *' })).toHaveValue('');
    submitPayment();
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال رقم الشيك');
    expect(addSupplierPaymentAction).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'رقم الشيك *' }), {
      target: { value: 'CHK-741' },
    });
    submitPayment();
    await waitFor(() => expect(addSupplierPaymentAction).toHaveBeenCalledWith(expect.objectContaining({
      supplier_id: 741, payment_method: 'check', check_number: 'CHK-741', amount: 175.25,
    })));
  });
});

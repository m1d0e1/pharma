import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PurchaseOrderModal from '@/components/inventory/PurchaseOrderModal';
import PosDrawerHandoverModal from '@/components/pos/PosDrawerHandoverModal';
import {
  createPurchaseOrderAction,
  getDrugInventoryQuantityAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';
import { getHandoverDetailsAction, processHandoverAction } from '@/app/actions-client/handover';
import { getBanksAction } from '@/app/actions-client/finance';
import { getStaffAction } from '@/app/actions-client/users';
import { toast } from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseOrderAction: jest.fn(),
  getDrugInventoryQuantityAction: jest.fn(),
  getSuppliersAction: jest.fn(),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({ searchMasterDrugsAction: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({ getCurrentShiftAction: jest.fn() }));
jest.mock('@/app/actions-client/handover', () => ({
  getHandoverDetailsAction: jest.fn(),
  getOpenShiftHandoverAction: jest.fn(),
  getShiftCreditSalesAction: jest.fn(),
  processHandoverAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({ getBanksAction: jest.fn() }));
jest.mock('@/app/actions-client/users', () => ({ getStaffAction: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => ({ id: 'synthetic-user', username: 'operator', full_name: 'Synthetic Operator', role: 'owner' })),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  ...(() => { const shared = { success: jest.fn(), error: jest.fn() }; return { default: shared, toast: shared }; })(),
}));

const item = {
  drug_id: 42,
  trade_name: 'Initial Purchase Item',
  requested_quantity: 2,
  current_stock: 6,
  last_cost_price: 10,
};

function purchaseForm() {
  return screen.getByRole('button', { name: 'حفظ وإرسال الأمر' }).closest('form') as HTMLFormElement;
}

describe('QA background: rendered purchasing order actions and guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 10, name_ar: 'Synthetic Supplier' }],
    });
    (getDrugInventoryQuantityAction as jest.Mock).mockResolvedValue({ success: true, data: 9 });
    (createPurchaseOrderAction as jest.Mock).mockResolvedValue({ success: true, po_id: 'PO-synthetic-1' });
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 88, trade_name_en: 'New Catalog Medicine', trade_name: 'دواء جديد', base_price: 8 }],
    });
  });

  it('uses supplier suggestions, active-ingredient search, and edited line amounts in the saved order', async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    render(<PurchaseOrderModal initialItems={[item]} onClose={onClose} onSuccess={onSuccess} />);

    expect(screen.getByLabelText('المورد / الشركة')).toHaveAttribute('list', 'suppliers-datalist');
    await waitFor(() => expect(document.querySelector('#suppliers-datalist option')).toHaveAttribute('value', 'Synthetic Supplier'));
    fireEvent.change(screen.getByLabelText('المورد / الشركة'), { target: { value: 'Synthetic Supplier' } });
    fireEvent.change(screen.getByLabelText('ملاحظات إضافية'), { target: { value: 'Synthetic delivery request' } });

    const search = screen.getByLabelText('إضافة صنف جديد للطلب');
    fireEvent.change(search, { target: { value: 'N' } });
    // A single character is deliberately not a catalog lookup.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 330)); });
    expect(searchMasterDrugsAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'البحث بالمادة الفعالة' }));
    fireEvent.change(search, { target: { value: 'New' } });
    fireEvent.click(await screen.findByRole('button', { name: /New Catalog Medicine/ }));

    await waitFor(() => expect(getDrugInventoryQuantityAction).toHaveBeenCalledWith(88));
    expect(searchMasterDrugsAction).toHaveBeenCalledWith({ query: 'New', searchByActiveIngredient: true });
    await waitFor(() => expect(screen.getAllByText('New Catalog Medicine').some(node => node.closest('tr'))).toBe(true));
    const newRow = screen.getAllByText('New Catalog Medicine').find(node => node.closest('tr'))!.closest('tr')!;
    expect(newRow).toHaveTextContent('9.00');
    const [quantity, expectedPrice] = within(newRow).getAllByRole('spinbutton');
    fireEvent.change(quantity, { target: { value: '3' } });
    fireEvent.change(expectedPrice, { target: { value: '8.25' } });
    expect(newRow).toHaveTextContent('24.75');

    fireEvent.submit(purchaseForm());
    await waitFor(() => expect(createPurchaseOrderAction).toHaveBeenCalledWith({
      supplier_name: 'Synthetic Supplier',
      notes: 'Synthetic delivery request',
      items: [
        { drug_id: 42, quantity: 2, expected_price: 10 },
        { drug_id: 88, quantity: 3, expected_price: 8.25 },
      ],
    }));
    expect(toast.success).toHaveBeenCalledWith('تم إنشاء أمر الشراء بنجاح: PO-synthetic-1');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects missing supplier and zero requested quantity, then allows a corrected order', async () => {
    render(<PurchaseOrderModal initialItems={[item]} onClose={jest.fn()} />);
    fireEvent.submit(purchaseForm());
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال اسم المورد');
    expect(createPurchaseOrderAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('المورد / الشركة'), { target: { value: 'Synthetic Supplier' } });
    const initialRow = screen.getByText('Initial Purchase Item').closest('tr')!;
    fireEvent.change(within(initialRow).getAllByRole('spinbutton')[0], { target: { value: '0' } });
    fireEvent.submit(purchaseForm());
    expect(toast.error).toHaveBeenCalledWith('لا يمكن طلب أصناف بكمية صفر');
    expect(createPurchaseOrderAction).not.toHaveBeenCalled();

    fireEvent.change(within(initialRow).getAllByRole('spinbutton')[0], { target: { value: '4' } });
    fireEvent.submit(purchaseForm());
    await waitFor(() => expect(createPurchaseOrderAction).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ drug_id: 42, quantity: 4, expected_price: 10 }],
    })));
    expect(createPurchaseOrderAction).toHaveBeenCalledTimes(1);
  });

  it('removes the selected purchasing line and forbids sending an empty order', () => {
    render(<PurchaseOrderModal initialItems={[item]} onClose={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('المورد / الشركة'), { target: { value: 'Synthetic Supplier' } });
    fireEvent.click(screen.getByRole('button', { name: 'إزالة Initial Purchase Item من أمر الشراء' }));
    expect(screen.queryByText('Initial Purchase Item')).not.toBeInTheDocument();
    expect(screen.getByText('0', { selector: 'span.text-3xl' })).toBeInTheDocument();
    fireEvent.submit(purchaseForm());
    expect(toast.error).toHaveBeenCalledWith('لا يوجد أصناف في الطلب');
    expect(createPurchaseOrderAction).not.toHaveBeenCalled();
  });

  it('does not send a negative estimated item price to the purchasing writer', () => {
    // Security regression: this is intentionally RED against an unguarded form.
    // Preserve the failure as a baseline; the typed action must independently validate price too.
    render(<PurchaseOrderModal initialItems={[item]} onClose={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('المورد / الشركة'), { target: { value: 'Synthetic Supplier' } });
    const initialRow = screen.getByText('Initial Purchase Item').closest('tr')!;
    fireEvent.change(within(initialRow).getAllByRole('spinbutton')[1], { target: { value: '-5' } });
    fireEvent.submit(purchaseForm());
    expect(createPurchaseOrderAction).not.toHaveBeenCalled();
  });
});

describe('QA background: rendered POS cash-drawer destination and confirmation guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({ success: true, data: { id: 'bg-shift-1' } });
    (getHandoverDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { id: 'bg-shift-1', starting_cash: 100, expected_cash: 200, credit_sales: 0 },
    });
    (getBanksAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 'bank-2', name_ar: 'Test Bank' }] });
    (getStaffAction as jest.Mock).mockResolvedValue({ success: true, data: [
      { id: 'staff-1', username: 'receiver-1', full_name: 'Receiver One' },
      { id: 'staff-2', username: 'receiver-2', full_name: 'Receiver Two' },
    ] });
    (processHandoverAction as jest.Mock).mockResolvedValue({ success: true, remainingCash: 125 });
  });

  it('requires an actual counted amount even when expected drawer cash is available', async () => {
    render(<PosDrawerHandoverModal isOpen onClose={jest.fn()} />);
    const cash = await screen.findByLabelText('النقدية المعدودة فعليًا في درج الوردية');
    expect(cash).toHaveValue(null);
    // HTML required fields prevent normal click submission; synthetic submit
    // also checks the JS handler cannot be bypassed by scripted dispatch.
    const form=screen.getByRole('button', {name:'حفظ S'}).closest('form')!;
    fireEvent.submit(form);
    expect(processHandoverAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يجب إدخال النقدية المعدودة فعليًا بدقة القرش قبل تسليم الدرج');
    fireEvent.change(cash, {target:{value:'4.001'}});
    fireEvent.submit(form);
    expect(processHandoverAction).not.toHaveBeenCalled();
  });

  it('offers treasury/next-shift/bank routes and posts the chosen bank, receiver and credentials', async () => {
    const onClose = jest.fn();
    render(<PosDrawerHandoverModal isOpen onClose={onClose} />);
    const destination = await screen.findByRole('combobox', { name: 'وجهة تحويل مبلغ التسليم' });
    expect(within(destination).getByRole('option', { name: 'الخزينة الرئيسية' })).toHaveValue('treasury');
    expect(within(destination).getByRole('option', { name: 'درج المستخدم المستلم' })).toHaveValue('next_shift');
    expect(within(destination).getByRole('option', { name: 'بنك: Test Bank' })).toHaveValue('bank-2');

    fireEvent.change(screen.getByLabelText('النقدية المعدودة فعليًا في درج الوردية'), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('تحويل مبلغ'), { target: { value: '75' } });
    fireEvent.change(destination, { target: { value: 'bank-2' } });
    expect(screen.getByLabelText('النقدية المرحلة إلى درج الوردية التالية')).toHaveValue('125.00');
    expect(screen.getByText('0.00', { selector: 'div.col-span-2' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('اسم المستلم'), { target: { value: 'receiver-2' } });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'synthetic-only-password' } });
    fireEvent.change(screen.getByLabelText('ملاحظات'), { target: { value: 'Transfer confirmed in synthetic test' } });
    fireEvent.submit(screen.getByRole('button', { name: 'حفظ S' }).closest('form')!);

    await waitFor(() => expect(processHandoverAction).toHaveBeenCalledWith({
      shiftId: 'bg-shift-1',
      actualCash: 200,
      transferAmount: 75,
      transferTargetType: 'bank',
      transferTargetId: 'bank-2',
      receiverUsername: 'receiver-2',
      receiverPasswordHash: 'synthetic-only-password',
      notes: 'Transfer confirmed in synthetic test',
      autoOpenNewShift: true,
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honors the visibly selected sole receiver even if a native select sends an empty value', async () => {
    (getStaffAction as jest.Mock).mockResolvedValue({success: true, data: [
      { id: 'admin', username: 'admin', full_name: 'System Administrator' },
    ]});
    render(<PosDrawerHandoverModal isOpen onClose={jest.fn()} />);
    const receiver = await screen.findByRole('combobox', { name: 'اسم المستلم' });
    await waitFor(() => expect(receiver).toHaveValue('admin'));
    // With one native <option>, Windows can emit the empty selection even
    // while the field still visibly displays that sole receiver.
    fireEvent.change(receiver, {target: {value: ''}});
    fireEvent.change(screen.getByLabelText('النقدية المعدودة فعليًا في درج الوردية'), {target: {value: '200'}});
    fireEvent.change(screen.getByLabelText('تحويل مبلغ'), {target: {value: '200'}});
    fireEvent.change(screen.getByLabelText('كلمة المرور'), {target: {value: 'synthetic-only-receiver-secret'}});
    fireEvent.click(screen.getByRole('button', {name: 'حفظ S'}));
    await waitFor(() => expect(processHandoverAction).toHaveBeenCalledWith(expect.objectContaining({
      receiverUsername: 'admin', actualCash: 200, transferAmount: 200,
    })));
  });

  it('shows next-shift carryover and treasury remainder before submitting the chosen destination', async () => {
    render(<PosDrawerHandoverModal isOpen onClose={jest.fn()} />);
    const destination = await screen.findByRole('combobox', { name: 'وجهة تحويل مبلغ التسليم' });
    fireEvent.change(screen.getByLabelText('النقدية المعدودة فعليًا في درج الوردية'), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('تحويل مبلغ'), { target: { value: '60' } });
    fireEvent.change(destination, { target: { value: 'next_shift' } });
    expect(screen.getByLabelText('النقدية المرحلة إلى درج الوردية التالية')).toHaveValue('60.00');
    expect(screen.getByText('140.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ S' }));
    await waitFor(() => expect(processHandoverAction).toHaveBeenCalledWith(expect.objectContaining({
      transferTargetType: 'next_shift', transferTargetId: '', transferAmount: 60, actualCash: 200,
    })));
  });

  it('blocks a transfer exceeding cash, then submits exactly once after correcting the amount', async () => {
    render(<PosDrawerHandoverModal isOpen onClose={jest.fn()} />);
    await screen.findByRole('button', { name: 'حفظ S' });
    fireEvent.change(screen.getByLabelText('النقدية المعدودة فعليًا في درج الوردية'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('تحويل مبلغ'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ S' }));
    expect(toast.error).toHaveBeenCalledWith('مبلغ التحويل أكبر من النقدية الفعلية في الدرج');
    expect(processHandoverAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('تحويل مبلغ'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ S' }));
    await waitFor(() => expect(processHandoverAction).toHaveBeenCalledTimes(1));
    expect(processHandoverAction).toHaveBeenCalledWith(expect.objectContaining({
      actualCash: 100, transferAmount: 40, transferTargetType: 'treasury',
    }));
  });
});

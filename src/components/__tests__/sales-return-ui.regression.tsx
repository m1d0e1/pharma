import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesReturnClient from '@/app/(dashboard)/returns/new/SalesReturnClient';
import {
  createReturnAction,
  getInvoiceForReturnAction,
  getSalesInvoicesByDateAction,
  searchRecentReturnInvoicesAction,
} from '@/app/actions-client/returns';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/app/actions-client/returns', () => ({
  createReturnAction: jest.fn(),
  getInvoiceForReturnAction: jest.fn(),
  getSalesInvoicesByDateAction: jest.fn(),
  searchRecentReturnInvoicesAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('rendered customer-return flow', () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: jest.fn(),
    });
  });

  beforeEach(() => {
    mockPush.mockReset();
    (getSalesInvoicesByDateAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'invoice-12345678',
        total_amount: 100,
        payment_method: 'credit',
        patient_name: 'Test Patient',
        user_name: 'Cashier',
        created_at: '2026-08-25T10:00:00.000Z',
      }],
    });
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'invoice-12345678',
        patient_id: 'patient-1',
        patient_name: 'Test Patient',
        user_name: 'Cashier',
        created_at: '2026-08-25T10:00:00.000Z',
        total_amount: 30,
        discount_amount: 0,
        payment_method: 'credit',
        status: 'completed',
        already_refunded: 0,
        items: [{
          id: 'sale-item-1',
          inventory_id: 'batch-1',
          drug_name: 'Return Drug',
          quantity_sold: 3,
          returned_quantity: 1,
          unit_price: 10,
          unit: 'large',
          large_to_medium: 2,
          medium_to_small: 5,
        }],
      },
    });
    (createReturnAction as jest.Mock).mockResolvedValue({ success: true, data: { id: 'return-1' } });
  });

  it('searches the original invoice, clamps cumulative quantity, and posts its original batch', async () => {
    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'Return Drug' },
    });

    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
    const quantity = screen.getByRole('spinbutton');
    fireEvent.change(quantity, { target: { value: '99' } });
    expect(quantity).toHaveValue(2);
    fireEvent.change(screen.getByPlaceholderText('اختياري...'), { target: { value: 'Damaged pack' } });
    fireEvent.change(screen.getAllByRole('combobox').at(-1)!, { target: { value: 'patient_account' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith({
      invoice_id: 'invoice-12345678',
      refund_method: 'patient_account',
      reason: 'Damaged pack',
      patient_id: 'patient-1',
      items: [{
        sale_item_id: 'sale-item-1',
        inventory_id: 'batch-1',
        drug_name: 'Return Drug',
        quantity: 2,
        unit_price: 10,
        unit: 'large',
      }],
    }));
    expect(mockPush).toHaveBeenCalledWith('/returns');
  });

  it('resets a stale patient-account refund when switching to a patient cash invoice', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockImplementation(async (term: string) => ({
      success: true,
      data: term.includes('cash')
        ? [{ id: 'cash-invoice', total_amount: 20, payment_method: 'cash', patient_name: 'Cash Patient', created_at: '2026-08-26T10:00:00.000Z' }]
        : [{ id: 'credit-invoice', total_amount: 20, payment_method: 'credit', patient_name: 'Credit Patient', created_at: '2026-08-25T10:00:00.000Z' }],
    }));
    (getInvoiceForReturnAction as jest.Mock).mockImplementation(async (id: string) => ({
      success: true,
      data: {
        id,
        patient_id: id === 'cash-invoice' ? 'patient-cash' : 'patient-credit',
        patient_name: id === 'cash-invoice' ? 'Cash Patient' : 'Credit Patient',
        total_amount: 20,
        discount_amount: 0,
        payment_method: id === 'cash-invoice' ? 'cash' : 'credit',
        status: 'completed',
        already_refunded: 0,
        items: [{
          id: id === 'cash-invoice' ? 'cash-item' : 'credit-item',
          inventory_id: id === 'cash-invoice' ? 'cash-batch' : 'credit-batch',
          drug_name: id === 'cash-invoice' ? 'Cash Drug' : 'Credit Drug',
          quantity_sold: 1,
          returned_quantity: 0,
          unit_price: 20,
          unit: 'large',
          large_to_medium: 1,
          medium_to_small: 1,
        }],
      },
    }));

    render(<SalesReturnClient />);
    const search = screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...');
    fireEvent.change(search, { target: { value: 'credit' } });
    expect(await screen.findByText('Credit Drug')).toBeInTheDocument();

    const refundMethod = screen.getAllByRole('combobox').at(-1)!;
    fireEvent.change(refundMethod, { target: { value: 'patient_account' } });
    expect(refundMethod).toHaveValue('patient_account');

    fireEvent.change(search, { target: { value: 'cash' } });
    expect(await screen.findByText('Cash Drug')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox').at(-1)).toHaveValue('cash');
  });

  it('can refund a wallet-funded patient sale back to the patient wallet', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'wallet-invoice',
        total_amount: 30,
        payment_method: 'wallet',
        patient_name: 'Wallet Patient',
        created_at: '2026-08-25T10:00:00.000Z',
      }],
    });
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'wallet-invoice',
        patient_id: 'patient-wallet',
        patient_name: 'Wallet Patient',
        total_amount: 30,
        discount_amount: 0,
        payment_method: 'wallet',
        status: 'completed',
        already_refunded: 0,
        items: [{
          id: 'wallet-sale-item',
          inventory_id: 'wallet-batch',
          drug_name: 'Wallet Return Drug',
          quantity_sold: 1,
          returned_quantity: 0,
          unit_price: 30,
          unit: 'large',
          large_to_medium: 1,
          medium_to_small: 1,
        }],
      },
    });

    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'wallet' },
    });

    expect(await screen.findByText('Wallet Return Drug')).toBeInTheDocument();
    const refundMethod = screen.getAllByRole('combobox').at(-1)!;
    expect(screen.getByRole('option', { name: 'إرجاع الرصيد إلى محفظة المريض' })).toBeInTheDocument();
    fireEvent.change(refundMethod, { target: { value: 'wallet' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 'wallet-invoice',
      patient_id: 'patient-wallet',
      refund_method: 'wallet',
    })));
  });

  it('can route a card-funded sale refund through the native bank-clearing path', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'visa-invoice',
        total_amount: 30,
        payment_method: 'visa',
        created_at: '2026-08-25T10:00:00.000Z',
      }],
    });
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'visa-invoice',
        patient_id: null,
        total_amount: 30,
        discount_amount: 0,
        payment_method: 'visa',
        status: 'completed',
        already_refunded: 0,
        items: [{
          id: 'visa-sale-item',
          inventory_id: 'visa-batch',
          drug_name: 'Visa Return Drug',
          quantity_sold: 1,
          returned_quantity: 0,
          unit_price: 30,
          unit: 'large',
          large_to_medium: 1,
          medium_to_small: 1,
        }],
      },
    });

    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'visa' },
    });

    expect(await screen.findByText('Visa Return Drug')).toBeInTheDocument();
    const refundMethod = screen.getAllByRole('combobox').at(-1)!;
    expect(screen.getByRole('option', { name: 'استرداد بنكي / بطاقة' })).toBeInTheDocument();
    expect(refundMethod).toHaveValue('bank');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 'visa-invoice',
      refund_method: 'bank',
    })));
  });

  it('preserves the prepared base quantity when return units round-trip small to medium to large', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 'unit-roundtrip', total_amount: 11, payment_method: 'visa', created_at: '2026-10-01T08:17:57.000Z' }],
    });
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'unit-roundtrip',
        patient_id: null,
        total_amount: 11,
        discount_amount: 0,
        payment_method: 'visa',
        status: 'completed',
        already_refunded: 0,
        items: [{
          id: 'unit-roundtrip-item',
          inventory_id: 'unit-roundtrip-batch',
          drug_name: 'Unit Roundtrip Drug',
          quantity_sold: 1,
          returned_quantity: 0,
          unit_price: 11,
          unit: 'small',
          large_to_medium: 3,
          medium_to_small: 4,
          large_unit: 'كرتونة',
          medium_unit: 'شريط مخصص',
          small_unit: 'قرص مخصص',
        }],
      },
    });

    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'roundtrip' },
    });
    expect(await screen.findByText('Unit Roundtrip Drug')).toBeInTheDocument();

    const quantity = screen.getByRole('spinbutton');
    const unit = screen.getAllByRole('combobox')[0];
    fireEvent.change(quantity, { target: { value: '1' } });
    expect(quantity).toHaveValue(1);

    expect(screen.getByRole('option', { name: 'كرتونة' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'شريط مخصص' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'قرص مخصص' })).toBeInTheDocument();

    fireEvent.change(unit, { target: { value: 'large' } });
    expect(quantity).toHaveValue(1 / 12);
    fireEvent.change(unit, { target: { value: 'medium' } });
    expect(quantity).toHaveValue(0.25);
    fireEvent.change(unit, { target: { value: 'small' } });
    expect(quantity).toHaveValue(1);
    fireEvent.change(unit, { target: { value: 'medium' } });
    expect(quantity).toHaveValue(0.25);
    fireEvent.change(unit, { target: { value: 'large' } });
    expect(quantity).toHaveValue(1 / 12);
    fireEvent.change(unit, { target: { value: 'small' } });
    expect(quantity).toHaveValue(1);
    expect(screen.getAllByText('11.00 ج.م').length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));
    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 'unit-roundtrip',
      refund_method: 'bank',
      items: [expect.objectContaining({
        sale_item_id: 'unit-roundtrip-item',
        quantity: 1,
        unit: 'small',
        unit_price: 11,
      })],
    })));
  });

  it('scans barcode and presses Enter to select receipt and return item', async () => {
    render(<SalesReturnClient />);
    const searchInput = screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...');
    
    // Simulate barcode scan with Enter key
    fireEvent.change(searchInput, { target: { value: '6221000123456' } });
    fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(searchRecentReturnInvoicesAction).toHaveBeenCalledWith('6221000123456'));
    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
  });

  it('previews the discounted refundable amount and reports the saved refund', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 'discounted-1234', total_amount: 90, payment_method: 'cash', created_at: '2026-08-25T12:00:00.000Z' }],
    });
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'discounted-1234',
        total_amount: 90,
        discount_amount: 10,
        payment_method: 'cash',
        status: 'completed',
        already_refunded: 0,
        items: [{
          id: 'discounted-item',
          inventory_id: 'batch-discounted',
          drug_name: 'Discounted Return Drug',
          quantity_sold: 1,
          returned_quantity: 0,
          unit_price: 100,
          unit: 'large',
          large_to_medium: 1,
          medium_to_small: 1,
        }],
      },
    });
    (createReturnAction as jest.Mock).mockResolvedValue({ success: true, returnId: 'return-discounted', totalRefund: 90 });

    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'discounted' },
    });
    expect(await screen.findByText('Discounted Return Drug')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });

    expect(screen.getAllByText('90.00 ج.م').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));
    await waitFor(() => expect(createReturnAction).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('تم تسجيل المرتجع بنجاح: 90.00 ج.م');
  });

  it('keeps the chosen receipt when lists refresh and older detail requests finish late', async () => {
    const receipts = [
      { id: 'first-111111', total_amount: 10, payment_method: 'cash', created_at: '2026-08-25T10:00:00.000Z' },
      { id: 'second-22222', total_amount: 20, payment_method: 'cash', created_at: '2026-08-25T11:00:00.000Z' },
    ];
    let resolveFirstDetails!: (value: any) => void;
    let resolveRefresh!: (value: any) => void;
    (searchRecentReturnInvoicesAction as jest.Mock).mockImplementation((term: string) => {
      if (term === 'refresh') return new Promise(resolve => { resolveRefresh = resolve; });
      return Promise.resolve({ success: true, data: receipts });
    });
    (getInvoiceForReturnAction as jest.Mock).mockImplementation((id: string) => {
      if (id === 'first-111111') return new Promise(resolve => { resolveFirstDetails = resolve; });
      return Promise.resolve({
        success: true,
        data: {
          id,
          items: [{ id: 'second-item', drug_name: 'Second Receipt Drug', quantity_sold: 1, returned_quantity: 0, unit_price: 20, unit: 'large' }],
        },
      });
    });

    render(<SalesReturnClient />);
    const searchInput = screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...');
    fireEvent.change(searchInput, { target: { value: 'initial' } });

    const secondReceipt = await screen.findByRole('button', { name: /رقم الفاتورة: second-2/i });
    await waitFor(() => expect(getInvoiceForReturnAction).toHaveBeenCalledWith('first-111111'));
    fireEvent.click(secondReceipt);
    expect(await screen.findByText('Second Receipt Drug')).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'refresh' } });
    await waitFor(() => expect(searchRecentReturnInvoicesAction).toHaveBeenCalledWith('refresh'));
    await act(async () => resolveRefresh({ success: true, data: receipts }));
    await act(async () => resolveFirstDetails({
      success: true,
      data: {
        id: 'first-111111',
        items: [{ id: 'first-item', drug_name: 'Wrong First Receipt Drug', quantity_sold: 1, returned_quantity: 0, unit_price: 10, unit: 'large' }],
      },
    }));

    expect(await screen.findByText('Second Receipt Drug')).toBeInTheDocument();
    expect(screen.queryByText('Wrong First Receipt Drug')).not.toBeInTheDocument();
  });

  it('cannot submit the previously prepared return after the invoice search source changes', async () => {
    render(<SalesReturnClient />);
    const searchInput = screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...');
    fireEvent.change(searchInput, { target: { value: 'Return Drug' } });
    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'تنفيذ المرتجع' })).toBeEnabled();

    fireEvent.change(searchInput, { target: { value: 'different invoice' } });

    expect(screen.queryByRole('button', { name: 'تنفيذ المرتجع' })).not.toBeInTheDocument();
    expect(createReturnAction).not.toHaveBeenCalled();
  });

  it('preserves the prepared sales return and restores submit controls when creation throws', async () => {
    (createReturnAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'Return Drug' },
    });

    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء حفظ المرتجع'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'تنفيذ المرتجع' })).toBeEnabled();
    expect(screen.getByRole('spinbutton')).toHaveValue(1);
  });

  it('keeps a committed sales return acknowledged and locked when post-save navigation throws', async () => {
    mockPush.mockImplementationOnce(() => { throw new Error('navigation unavailable'); });
    (createReturnAction as jest.Mock).mockResolvedValueOnce({ success: true, returnId: 'return-committed', totalRefund: 10 });
    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'Return Drug' },
    });

    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createReturnAction).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('تم تسجيل المرتجع بنجاح: 10.00 ج.م');
    expect(toast.error).toHaveBeenCalledWith('تم تسجيل المرتجع بنجاح لكن تعذر فتح قائمة المرتجعات');
    expect(toast.error).not.toHaveBeenCalledWith('حدث خطأ أثناء حفظ المرتجع');
    expect(screen.getByRole('button', { name: 'تم حفظ المرتجع' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'تم حفظ المرتجع' }));
    expect(createReturnAction).toHaveBeenCalledTimes(1);
  });

  it('blocks repeated sales-return submission while the first financial write is pending', async () => {
    let resolveCreate: (value: { success: boolean; error?: string }) => void = () => {};
    (createReturnAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveCreate = resolve;
    }));
    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'Return Drug' },
    });

    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    const submit = screen.getByRole('button', { name: 'تنفيذ المرتجع' });

    act(() => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(createReturnAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveCreate({ success: false, error: 'تعذر الحفظ مؤقتاً' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'تنفيذ المرتجع' })).toBeEnabled());
  });

  it('surfaces a thrown invoice search and remains usable for a later search', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
    render(<SalesReturnClient />);
    const searchInput = screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...');

    fireEvent.change(searchInput, { target: { value: 'first-fails' } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل فواتير المبيعات'));

    fireEvent.change(searchInput, { target: { value: 'Return Drug' } });
    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
    expect(searchRecentReturnInvoicesAction).toHaveBeenLastCalledWith('Return Drug');
  });

  it('shows a perceivable search state and distinguishes search-no-results from date-no-results', async () => {
    let resolveSearch!: (value: any) => void;
    (searchRecentReturnInvoicesAction as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      resolveSearch = resolve;
    }));
    render(<SalesReturnClient />);
    const searchInput = screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...');

    fireEvent.change(searchInput, { target: { value: 'missing drug' } });
    expect(await screen.findByText('جاري البحث عن الفواتير...')).toBeInTheDocument();
    await waitFor(() => expect(searchRecentReturnInvoicesAction).toHaveBeenCalledWith('missing drug'));

    await act(async () => resolveSearch({ success: true, data: [] }));
    expect(await screen.findByText('لا توجد فواتير مطابقة لعبارة البحث.')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد فواتير مكتملة في هذا التاريخ.')).not.toBeInTheDocument();
  });

  it('does not reveal stale invoice rows after a newer invoice search fails', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockImplementation(async (term: string) => {
      if (term === 'stale-source') {
        return {
          success: true,
          data: [{
            id: 'stale-invoice-1',
            total_amount: 25,
            payment_method: 'cash',
            patient_name: 'Stale Search Patient',
            user_name: 'Cashier',
            created_at: '2026-08-25T10:00:00.000Z',
          }],
        };
      }
      if (term === 'new-source-fails') return { success: false, error: 'search unavailable' };
      return { success: true, data: [] };
    });

    render(<SalesReturnClient />);
    const searchInput = screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...');
    fireEvent.change(searchInput, { target: { value: 'stale-source' } });
    expect(await screen.findByText(/Stale Search Patient/)).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'new-source-fails' } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('search unavailable'));
    await waitFor(() => expect(screen.queryByText(/Stale Search Patient/)).not.toBeInTheDocument());
  });
});

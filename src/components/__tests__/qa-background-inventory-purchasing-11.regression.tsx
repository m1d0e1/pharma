import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PurchaseReturnClient from '@/app/(dashboard)/purchases/returns/new/PurchaseReturnClient';
import {
  createPurchaseReturnAction,
  getPurchaseInvoiceDetailsAction,
  getSuppliersAction,
  searchPurchaseInvoicesForReturnAction,
} from '@/app/actions-client/purchases';
import { toast } from 'react-hot-toast';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('next/link', () => function MockLink({ href, children }: React.PropsWithChildren<{ href: string }>) {
  return <a href={href}>{children}</a>;
});
jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseReturnAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
  searchPurchaseInvoicesForReturnAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const sourceA = {
  id: 'purchase-lot-source-11-A', invoice_number: 'SRC-11-A', supplier_id: 11,
  supplier_name: 'Supplier Eleven', status: 'completed', total_amount: 180,
};
const sourceB = {
  id: 'purchase-lot-source-11-B', invoice_number: 'SRC-11-B', supplier_id: 12,
  supplier_name: 'Supplier Twelve', status: 'completed', total_amount: 55,
};
const sourceLots = [
  {
    id: 'receipt-line-11-one', inventory_id: 'stock-lot-11-one', drug_id: 911,
    trade_name: 'Repeat Receipt Drug', barcode: 'SOURCE-BARCODE-11-ONE',
    quantity: 4, remaining_large_quantity: 1.5, returned_large_quantity: 2.5,
    refundable_large_unit_price: 80, large_unit: 'صندوق', medium_unit: 'شريط',
    small_unit: 'قرص', strips_per_box: 4, medium_to_small: 5,
    inventory_expiry_date: '2027-11-30', batch_number: 'LOT-11-1',
  },
  {
    id: 'receipt-line-11-two', inventory_id: 'stock-lot-11-two', drug_id: 911,
    trade_name: 'Repeat Receipt Drug', barcode: 'SOURCE-BARCODE-11-TWO',
    quantity: 3, remaining_large_quantity: 0.5, returned_large_quantity: 2.5,
    refundable_large_unit_price: 60, large_unit: 'صندوق', medium_unit: 'شريط',
    small_unit: 'قرص', strips_per_box: 4, medium_to_small: 5,
    inventory_expiry_date: '2028-03-31', batch_number: 'LOT-11-2',
  },
];

const searchInput = () => screen.getByLabelText(/البحث بالباركود أو اسم الصنف أو رقم الفاتورة/);
const invoiceButton = (number: string) => screen.getByRole('button', { name: new RegExp(`رقم الفاتورة: ${number}`) });
const sourceRow = (barcode: string) => screen.getByText(barcode).closest('tr') as HTMLTableRowElement;
const submit = () => screen.getByRole('button', { name: 'تنفيذ المرتجع' });

async function selectSourceA() {
  fireEvent.change(searchInput(), { target: { value: 'SRC-11-A' } });
  expect(await screen.findByText('SOURCE-BARCODE-11-ONE')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'أو اختر المورد' })).toHaveValue('11'));
}

describe('QA purchasing 11: source-linked return lots and rendered refund controls (mock actions only)', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: jest.fn() });
  });

  beforeEach(() => {
    jest.resetAllMocks();
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true, value: jest.fn(() => 'synthetic-return-request-11'),
    });
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ id: 11, name_ar: 'Supplier Eleven' }, { id: 12, name_ar: 'Supplier Twelve' }],
    });
    (searchPurchaseInvoicesForReturnAction as jest.Mock).mockResolvedValue({ success: true, data: [sourceA] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: sourceLots });
    (createPurchaseReturnAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('keeps same-drug receipt lots separate under barcode filtering and sends their exact stock quantities and refund arithmetic', async () => {
    render(<PurchaseReturnClient />);
    await selectSourceA();
    expect(getPurchaseInvoiceDetailsAction).toHaveBeenCalledWith(sourceA.id);
    // Each owned receipt has its own refundable remainder, not a pooled drug/lot amount.
    expect(within(sourceRow('SOURCE-BARCODE-11-ONE'))
      .getByText(/المتبقي القابل للإرجاع من فاتورة الشراء: 1\.50 صندوق/)).toBeInTheDocument();
    expect(within(sourceRow('SOURCE-BARCODE-11-TWO'))
      .getByText(/المتبقي القابل للإرجاع من فاتورة الشراء: 0\.50 صندوق/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'البحث داخل أصناف فاتورة الشراء المحددة' }), {
      target: { value: 'SOURCE-BARCODE-11-TWO' },
    });
    expect(screen.queryByText('SOURCE-BARCODE-11-ONE')).not.toBeInTheDocument();
    const second = sourceRow('SOURCE-BARCODE-11-TWO');
    fireEvent.change(within(second).getByRole('combobox', { name: 'وحدة مرتجع Repeat Receipt Drug' }), {
      target: { value: 'medium' },
    });
    fireEvent.change(within(second).getByRole('spinbutton', { name: 'كمية مرتجع Repeat Receipt Drug' }), {
      target: { value: '99' },
    });
    expect(within(second).getByRole('spinbutton', { name: 'كمية مرتجع Repeat Receipt Drug' })).toHaveValue(2);
    expect(within(second).getByText('30.00 ج.م')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'البحث داخل أصناف فاتورة الشراء المحددة' }), {
      target: { value: '' },
    });
    const first = sourceRow('SOURCE-BARCODE-11-ONE');
    fireEvent.change(within(first).getByRole('combobox', { name: 'وحدة مرتجع Repeat Receipt Drug' }), {
      target: { value: 'medium' },
    });
    fireEvent.change(within(first).getByRole('spinbutton', { name: 'كمية مرتجع Repeat Receipt Drug' }), {
      target: { value: '3' },
    });
    expect(within(first).getByText('60.00 ج.م')).toBeInTheDocument();
    expect(screen.getByText('90.00 ج.م', { selector: 'span.text-3xl' })).toBeInTheDocument();

    fireEvent.click(submit());
    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledTimes(1));
    const payload = (createPurchaseReturnAction as jest.Mock).mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      request_id: 'synthetic-return-request-11', purchase_invoice_id: sourceA.id,
      supplier_id: 11, refund_method: 'credit',
    }));
    expect(payload.items).toHaveLength(2);
    expect(payload.items).toEqual([
      expect.objectContaining({
        purchase_invoice_item_id: 'receipt-line-11-one', inventory_id: 'stock-lot-11-one',
        drug_id: 911, barcode: 'SOURCE-BARCODE-11-ONE', quantity: 3,
        unit: 'medium', unit_price: 20, remaining_large_quantity: 1.5,
        expiry_date: '2027-11-30',
      }),
      expect.objectContaining({
        purchase_invoice_item_id: 'receipt-line-11-two', inventory_id: 'stock-lot-11-two',
        drug_id: 911, barcode: 'SOURCE-BARCODE-11-TWO', quantity: 2,
        unit: 'medium', unit_price: 15, remaining_large_quantity: 0.5,
        expiry_date: '2028-03-31',
      }),
    ]);
    expect(push).toHaveBeenCalledWith('/purchases/returns');
  });

  it('retries a denied selected source detail read by choosing its same invoice again', async () => {
    (getPurchaseInvoiceDetailsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'synthetic scoped receipt denied' })
      .mockResolvedValue({ success: true, data: sourceLots });
    render(<PurchaseReturnClient />);
    await screen.findByRole('option', { name: 'Supplier Eleven' });
    fireEvent.change(screen.getByRole('combobox', { name: 'أو اختر المورد' }), {
      target: { value: '11' },
    });
    await waitFor(() => expect(searchPurchaseInvoicesForReturnAction).toHaveBeenCalledWith('', 11));
    await waitFor(() => expect(getPurchaseInvoiceDetailsAction).toHaveBeenCalledWith(sourceA.id));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('لم يتم العثور على تفاصيل الفاتورة'));
    expect(screen.queryByText('SOURCE-BARCODE-11-ONE')).not.toBeInTheDocument();
    expect(submit()).toBeDisabled();

    fireEvent.click(invoiceButton('SRC-11-A'));
    await waitFor(() => expect(getPurchaseInvoiceDetailsAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('SOURCE-BARCODE-11-ONE')).toBeInTheDocument();
    expect(createPurchaseReturnAction).not.toHaveBeenCalled();
  });

  it('keeps the chosen source and identical writer request after denied financial return and successful retry', async () => {
    (createPurchaseReturnAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'synthetic source lot stock denied' })
      .mockResolvedValueOnce({ success: true });
    render(<PurchaseReturnClient />);
    await selectSourceA();
    fireEvent.change(within(sourceRow('SOURCE-BARCODE-11-ONE')).getByRole('spinbutton'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'طريقة الاسترداد *' }), {
      target: { value: 'cash' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'سبب المرتجع / ملاحظات' }), {
      target: { value: 'Synthetic expired stock lot' },
    });
    expect(screen.getByText('80.00 ج.م', { selector: 'span.text-3xl' })).toBeInTheDocument();

    fireEvent.click(submit());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ: synthetic source lot stock denied'));
    expect(push).not.toHaveBeenCalled();
    expect(submit()).toBeEnabled();
    fireEvent.click(submit());
    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledTimes(2));
    expect((createPurchaseReturnAction as jest.Mock).mock.calls[0]).toEqual(
      (createPurchaseReturnAction as jest.Mock).mock.calls[1],
    );
    expect((createPurchaseReturnAction as jest.Mock).mock.calls[1][0]).toEqual(expect.objectContaining({
      purchase_invoice_id: sourceA.id, supplier_id: 11, refund_method: 'cash',
      reason: 'Synthetic expired stock lot', items: [expect.objectContaining({
        purchase_invoice_item_id: 'receipt-line-11-one', quantity: 1, unit_price: 80,
      })],
    }));
    expect(screen.getByRole('button', { name: 'تم حفظ المرتجع' })).toBeDisabled();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('discards an older supplier source search response after a newer invoice search selects a different source', async () => {
    let completeOldSearch!: (value: unknown) => void;
    (searchPurchaseInvoicesForReturnAction as jest.Mock).mockImplementation((term: string, supplierId?: number) => {
      if (term === 'OLD') return new Promise(resolve => { completeOldSearch = resolve; });
      if (term === 'NEW' || supplierId === 12) return Promise.resolve({ success: true, data: [sourceB] });
      return Promise.resolve({ success: true, data: [] });
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockImplementation((id: string) => Promise.resolve({
      success: true, data: id === sourceB.id ? [{
        ...sourceLots[1], id: 'receipt-line-source-B', inventory_id: 'stock-source-B',
        trade_name: 'Only Source B Drug', refundable_large_unit_price: 55,
      }] : sourceLots,
    }));
    render(<PurchaseReturnClient />);
    fireEvent.change(searchInput(), { target: { value: 'OLD' } });
    await waitFor(() => expect(searchPurchaseInvoicesForReturnAction).toHaveBeenCalledWith('OLD'));
    fireEvent.change(searchInput(), { target: { value: 'NEW' } });
    expect(await screen.findByText('Only Source B Drug')).toBeInTheDocument();
    expect(invoiceButton('SRC-11-B')).toHaveAttribute('aria-pressed', 'true');
    await act(async () => completeOldSearch({ success: true, data: [sourceA] }));
    expect(screen.queryByRole('button', { name: /SRC-11-A/ })).not.toBeInTheDocument();
    expect(screen.getByText('Only Source B Drug')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'كمية مرتجع Only Source B Drug' }), {
      target: { value: '0.5' },
    });
    fireEvent.click(submit());
    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      purchase_invoice_id: sourceB.id, supplier_id: 12,
      items: [expect.objectContaining({ purchase_invoice_item_id: 'receipt-line-source-B', inventory_id: 'stock-source-B', quantity: 0.5 })],
    })));
    expect(getPurchaseInvoiceDetailsAction).not.toHaveBeenCalledWith(sourceA.id);
  });
});

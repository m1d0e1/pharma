import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PurchaseReturnClient from '@/app/(dashboard)/purchases/returns/new/PurchaseReturnClient';
import AdjustmentsClient from '@/app/(dashboard)/stores/adjustments/AdjustmentsClient';
import {
  createPurchaseReturnAction,
  getPurchaseInvoiceDetailsAction,
  getSuppliersAction,
  searchPurchaseInvoicesForReturnAction,
} from '@/app/actions-client/purchases';
import { createStockAdjustmentAction } from '@/app/actions-client/master-drugs';
import { dbSelect } from '@/lib/db/tauri';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseReturnAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
  searchPurchaseInvoicesForReturnAction: jest.fn(),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({ createStockAdjustmentAction: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const invoice = {
  id: 'bg-return-invoice-2', invoice_number: 'BG-PINV-2', supplier_id: 7,
  supplier_name: 'Synthetic Supplier', status: 'completed', payment_method: 'credit',
  total_amount: 95, created_at: '2026-10-14T09:00:00Z',
};
const alpha = {
  id: 'purchase-item-alpha', inventory_id: 'batch-alpha', drug_id: 101,
  trade_name: 'Return Stock Alpha', barcode: 'ALPHA-001', quantity: 7,
  remaining_large_quantity: 2, returned_large_quantity: 5,
  refundable_large_unit_price: 25, large_to_medium: 2, medium_to_small: 5,
};
const beta = {
  id: 'purchase-item-beta', inventory_id: 'batch-beta', drug_id: 202,
  trade_name: 'Return Stock Beta', barcode: 'BETA-002', quantity: 5,
  remaining_large_quantity: 3, returned_large_quantity: 2,
  refundable_large_unit_price: 15, large_to_medium: 1, medium_to_small: 1,
};

const stockAlpha = {
  id: 'stock-inventory-alpha', drug_id: 101, quantity: 8,
  trade_name_en: 'Stock Count Alpha', barcode: 'STOCK-A',
};
const stockBeta = {
  id: 'stock-inventory-beta', drug_id: 202, quantity: 3.5,
  trade_name_en: 'Stock Count Beta', barcode: 'STOCK-B',
};

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true, value: jest.fn(),
  });
});

async function selectReturnInvoice() {
  fireEvent.change(screen.getByLabelText('البحث بالباركود أو اسم الصنف أو رقم الفاتورة (جميع فواتير المشتريات)'), {
    target: { value: 'BG-PINV-2' },
  });
  expect(await screen.findByText('Return Stock Alpha')).toBeInTheDocument();
  expect(screen.getByText('Return Stock Beta')).toBeInTheDocument();
  await waitFor(() => expect(getPurchaseInvoiceDetailsAction).toHaveBeenCalledWith(invoice.id));
}

describe('QA background: real purchase-return options, line provenance and validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockReset();
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ id: 7, name_ar: 'Synthetic Supplier' }],
    });
    (searchPurchaseInvoicesForReturnAction as jest.Mock).mockResolvedValue({ success: true, data: [invoice] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: [alpha, beta] });
    (createPurchaseReturnAction as jest.Mock).mockResolvedValue({ success: true, id: 'synthetic-return-2' });
  });

  it('selects cash instead of supplier credit, posts only the chosen source line and navigates after native success', async () => {
    render(<PurchaseReturnClient />);
    await selectReturnInvoice();

    const method = screen.getByRole('combobox', { name: 'طريقة الاسترداد *' });
    expect(method).toHaveValue('credit');
    expect(within(method).getByRole('option', { name: 'استرداد نقدي (كاش)' })).toHaveValue('cash');
    fireEvent.change(method, { target: { value: 'cash' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'سبب المرتجع / ملاحظات' }), {
      target: { value: 'Synthetic damaged lot return' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'كمية مرتجع Return Stock Beta' }), {
      target: { value: '2' },
    });
    expect(screen.getByText('30.00 ج.م', { selector: 'span.text-3xl' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      request_id: expect.any(String), purchase_invoice_id: invoice.id, supplier_id: 7,
      refund_method: 'cash', reason: 'Synthetic damaged lot return',
      items: [expect.objectContaining({
        purchase_invoice_item_id: beta.id, inventory_id: beta.inventory_id,
        drug_id: beta.drug_id, quantity: 2, unit: 'large', unit_price: 15,
      })],
    })));
    expect(createPurchaseReturnAction).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/purchases/returns');
  });

  it('clamps over-return and negative quantities, refuses a zero return, then submits the corrected source limit', async () => {
    render(<PurchaseReturnClient />);
    await selectReturnInvoice();
    const qty = screen.getByRole('spinbutton', { name: 'كمية مرتجع Return Stock Alpha' });
    const submit = screen.getByRole('button', { name: 'تنفيذ المرتجع' });
    expect(submit).toBeDisabled();
    fireEvent.change(qty, { target: { value: '500' } });
    expect(qty).toHaveValue(2);
    expect(qty).toHaveAttribute('max', '2');
    fireEvent.change(qty, { target: { value: '-3' } });
    expect(qty).toHaveValue(0);
    expect(submit).toBeDisabled();
    expect(createPurchaseReturnAction).not.toHaveBeenCalled();

    fireEvent.change(qty, { target: { value: '2' } });
    expect(submit).toBeEnabled();
    expect(screen.getByText('50.00 ج.م', { selector: 'span.text-3xl' })).toBeInTheDocument();
    fireEvent.click(submit);
    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      refund_method: 'credit',
      items: [expect.objectContaining({ purchase_invoice_item_id: alpha.id, quantity: 2, unit_price: 25 })],
    })));
  });

  it('filters visible receipt lines by barcode without dropping earlier prepared quantities or posting unrelated items', async () => {
    render(<PurchaseReturnClient />);
    await selectReturnInvoice();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'كمية مرتجع Return Stock Alpha' }), {
      target: { value: '1' },
    });

    const filter = screen.getByRole('searchbox', { name: 'البحث داخل أصناف فاتورة الشراء المحددة' });
    fireEvent.change(filter, { target: { value: 'BETA-002' } });
    expect(screen.queryByText('Return Stock Alpha')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'كمية مرتجع Return Stock Beta' }), {
      target: { value: '2' },
    });
    expect(screen.getByText('55.00 ج.م', { selector: 'span.text-3xl' })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'MISSING-BARCODE' } });
    expect(screen.getByText('لا يوجد صنف يطابق الاسم أو الباركود')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledTimes(1));
    const payload = (createPurchaseReturnAction as jest.Mock).mock.calls[0][0];
    expect(payload.items).toHaveLength(2);
    expect(payload.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ purchase_invoice_item_id: alpha.id, inventory_id: alpha.inventory_id, quantity: 1 }),
      expect.objectContaining({ purchase_invoice_item_id: beta.id, inventory_id: beta.inventory_id, quantity: 2 }),
    ]));
  });

  it('refuses source lines with zero refundable price, even if quantity is entered', async () => {
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ ...alpha, refundable_large_unit_price: 0 }],
    });
    render(<PurchaseReturnClient />);
    fireEvent.change(screen.getByLabelText('البحث بالباركود أو اسم الصنف أو رقم الفاتورة (جميع فواتير المشتريات)'), {
      target: { value: 'BG-PINV-2' },
    });
    expect(await screen.findByText('Return Stock Alpha')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'كمية مرتجع Return Stock Alpha' }), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));
    expect(toast.error).toHaveBeenCalledWith('تأكد من صحة الأسعار');
    expect(createPurchaseReturnAction).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('invalidates a prepared return when a new source search fails, then recovers on a valid source', async () => {
    (searchPurchaseInvoicesForReturnAction as jest.Mock).mockImplementation(async (term: string) =>
      term === 'BROKEN-SOURCE'
        ? { success: false, error: 'Native invoice lookup denied' }
        : { success: true, data: [invoice] });
    render(<PurchaseReturnClient />);
    await selectReturnInvoice();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'كمية مرتجع Return Stock Alpha' }), {
      target: { value: '1' },
    });
    expect(screen.getByRole('button', { name: 'تنفيذ المرتجع' })).toBeEnabled();

    const search = screen.getByLabelText('البحث بالباركود أو اسم الصنف أو رقم الفاتورة (جميع فواتير المشتريات)');
    fireEvent.change(search, { target: { value: 'BROKEN-SOURCE' } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Native invoice lookup denied'));
    expect(screen.queryByRole('button', { name: 'تنفيذ المرتجع' })).not.toBeInTheDocument();
    expect(createPurchaseReturnAction).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'BG-PINV-2' } });
    expect(await screen.findByRole('spinbutton', { name: 'كمية مرتجع Return Stock Alpha' })).toHaveValue(0);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'كمية مرتجع Return Stock Alpha' }), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));
    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      purchase_invoice_id: invoice.id,
      items: [expect.objectContaining({ purchase_invoice_item_id: alpha.id, quantity: 1 })],
    })));
  });
});

describe('QA background: stock count source selection and posting recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'synthetic-counter', pharmacy_id: 'tenant-bg-2' });
    (dbSelect as jest.Mock).mockResolvedValue([stockAlpha, stockBeta]);
    (createStockAdjustmentAction as jest.Mock).mockResolvedValue({ success: true });
  });

  async function searchStock() {
    fireEvent.change(screen.getByRole('textbox', { name: 'البحث عن صنف لتسوية المخزون' }), {
      target: { value: 'STOCK' },
    });
    expect(await screen.findByRole('button', { name: /Stock Count Alpha/ })).toBeInTheDocument();
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('i.pharmacy_id = ?'),
      ['%STOCK%', '%STOCK%', '%STOCK%', 'tenant-bg-2', 'tenant-bg-2']));
  }

  it('switches from one stock result to another and posts only the second item original balance and fractional recount', async () => {
    render(<AdjustmentsClient reasons={[{ id: 9, name_ar: 'Synthetic physical count' }]} />);
    await searchStock();
    fireEvent.click(screen.getByRole('button', { name: /Stock Count Beta/ }));
    expect(screen.getByText('الرصيد الحالي: 3.5')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'الكمية الجديدة' }), { target: { value: '2.25' } });
    expect(screen.getByText(/تقليل الرصيد بمقدار 1\.25 وحدة/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'سبب التسوية' }), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));
    await waitFor(() => expect(createStockAdjustmentAction).toHaveBeenCalledWith(stockBeta.id, {
      reason_id: 9, old_quantity: 3.5, new_quantity: 2.25,
    }));
    expect(createStockAdjustmentAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('الرصيد الحالي: 3.5')).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith('تمت تسوية الكمية بنجاح');
  });

  it('keeps a failed adjustment available for corrected retry without changing the inventory source identity', async () => {
    (createStockAdjustmentAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Source balance changed before posting' })
      .mockResolvedValueOnce({ success: true });
    render(<AdjustmentsClient reasons={[{ id: 9, name_ar: 'Synthetic physical count' }]} />);
    await searchStock();
    fireEvent.click(screen.getByRole('button', { name: /Stock Count Alpha/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'سبب التسوية' }), { target: { value: '9' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'الكمية الجديدة' }), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Source balance changed before posting'));
    expect(screen.getByText('الرصيد الحالي: 8')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'الكمية الجديدة' }), { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));
    await waitFor(() => expect(createStockAdjustmentAction).toHaveBeenCalledTimes(2));
    expect((createStockAdjustmentAction as jest.Mock).mock.calls).toEqual([
      [stockAlpha.id, { reason_id: 9, old_quantity: 8, new_quantity: 6 }],
      [stockAlpha.id, { reason_id: 9, old_quantity: 8, new_quantity: 7.5 }],
    ]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تمت تسوية الكمية بنجاح'));
  });

  it('keeps search queries too short out of the DB and never submits without an item and reason', async () => {
    render(<AdjustmentsClient reasons={[{ id: 9, name_ar: 'Synthetic physical count' }]} />);
    const search = screen.getByRole('textbox', { name: 'البحث عن صنف لتسوية المخزون' });
    fireEvent.change(search, { target: { value: 'ST' } });
    expect(dbSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));
    expect(toast.error).toHaveBeenCalledWith('يرجى اختيار الصنف وسبب التسوية');
    expect(createStockAdjustmentAction).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'STOCK' } });
    fireEvent.click(await screen.findByRole('button', { name: /Stock Count Alpha/ }));
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));
    expect(toast.error).toHaveBeenCalledWith('يرجى اختيار الصنف وسبب التسوية');
    expect(createStockAdjustmentAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'سبب التسوية' }), { target: { value: '9' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'الكمية الجديدة' }), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));
    await waitFor(() => expect(createStockAdjustmentAction).toHaveBeenCalledWith(stockAlpha.id, {
      reason_id: 9, old_quantity: 8, new_quantity: 6,
    }));
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PurchaseInvoiceClient from '@/app/(dashboard)/purchases/new/PurchaseInvoiceClient';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import {
  checkSupplierPendingInvoiceAction,
  createPurchaseInvoiceAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';

const mockPush = jest.fn();
const draftKey = 'pharma_purchase_draft_v2:["local_default","buyer-1"]';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/components/purchases/BarcodePrinter', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/master-drugs/QuickAddDrugModal', () => () => null);
jest.mock('@/app/actions-client/master-drugs', () => ({ searchMasterDrugsAction: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  getSuppliersAction: jest.fn(),
  createPurchaseInvoiceAction: jest.fn(),
  addPurchaseInvoiceItemAction: jest.fn(),
  completePurchaseInvoiceAction: jest.fn(),
  checkSupplierPendingInvoiceAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getPurchaseInvoiceAction: jest.fn(),
  updateCompletedPurchaseInvoiceAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: Object.assign(jest.fn(), {
    error: jest.fn(),
    success: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  }),
}));

describe('rendered purchase-invoice flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'buyer-1' }));
    mockPush.mockReset();
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 7, name_ar: 'مورد اختبار', balance: 125 }],
    });
    (checkSupplierPendingInvoiceAction as jest.Mock).mockResolvedValue({ success: true, hasPending: false });
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 101,
        trade_name: 'دواء شراء',
        trade_name_en: 'Purchase Drug',
        barcode: '123456',
        official_price: 20,
        base_price: 12,
        large_to_medium: 2,
      }],
    });
    (createPurchaseInvoiceAction as jest.Mock).mockResolvedValue({ success: true, id: 'purchase-1' });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([false, true])('submits the full invoice and clears the local draft (print barcodes: %s)', async printBarcodes => {
    jest.mocked(window.confirm).mockReturnValue(printBarcodes);
    const view = render(<PurchaseInvoiceClient />);

    const save = screen.getByRole('button', { name: /حفظ نهائي/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));

    expect(save).toBeEnabled();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'INV-TEST-1' } });
    const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
    expect(dateInputs).toHaveLength(2);
    fireEvent.change(dateInputs[1], { target: { value: '2028-12-31' } });
    fireEvent.click(save);

    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      supplier_id: 7,
      invoice_number: 'INV-TEST-1',
      payment_method: 'credit',
      status: 'completed',
      cart: [expect.objectContaining({
        id: 101,
        quantity: 1,
        cost_price: 12,
        selling_price: 20,
        expiry_date: '2028-12-31',
      })],
    })));
    if (!printBarcodes) expect(mockPush).toHaveBeenCalledWith('/purchases');
    expect(sessionStorage.getItem(draftKey)).toBeNull();
    view.unmount();
    render(<PurchaseInvoiceClient />);
    await screen.findByRole('option', { name: 'مورد اختبار' });
    expect(screen.queryByText('Purchase Drug')).not.toBeInTheDocument();
  });

  it('keeps the full order across navigation and appends shortage items without replacing it', async () => {
    const first = render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'KEEP-ORDER' } });
    fireEvent.change(screen.getByPlaceholderText('ملاحظات اختيارية عن فاتورة الشراء...'), { target: { value: 'keep these notes' } });
    const row = screen.getByText('Purchase Drug').closest('tr')!;
    fireEvent.change(within(row).getByDisplayValue('1'), { target: { value: '3' } });
    const before = JSON.parse(sessionStorage.getItem(draftKey)!);
    expect(before.cart).toHaveLength(1);
    expect(before.cart[0].quantity).toBe('3');
    first.unmount();

    const second = render(<PurchaseInvoiceClient />);
    expect(await screen.findByText('Purchase Drug')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).toHaveValue('KEEP-ORDER');
    expect(screen.getByPlaceholderText('ملاحظات اختيارية عن فاتورة الشراء...')).toHaveValue('keep these notes');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('7'));
    expect(JSON.parse(sessionStorage.getItem(draftKey)!)).toEqual(before);
    expect(createPurchaseInvoiceAction).not.toHaveBeenCalled();
    second.unmount();

    sessionStorage.setItem('shortages_to_purchase', JSON.stringify([{ drug_id: 202, trade_name: 'Shortage Drug', requested_quantity: 4, official_price: 30 }]));
    render(<PurchaseInvoiceClient />);
    expect(await screen.findByText('Purchase Drug')).toBeInTheDocument();
    expect(screen.getAllByText('Shortage Drug')).toHaveLength(2);
    const combined = JSON.parse(sessionStorage.getItem(draftKey)!);
    expect(combined.cart[0]).toEqual(before.cart[0]);
    expect(combined.cart[1]).toMatchObject({ id: 202, quantity: 4 });
    expect(combined.invoiceHeader).toEqual(before.invoiceHeader);
    expect(sessionStorage.getItem('shortages_to_purchase')).toBeNull();
  });

  it('isolates users and clears the order only after confirmed cancellation', async () => {
    const first = render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    first.unmount();
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'buyer-2' }));
    const other = render(<PurchaseInvoiceClient />);
    await screen.findByRole('option', { name: 'مورد اختبار' });
    expect(screen.queryByText('Purchase Drug')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(draftKey)).not.toBeNull();
    other.unmount();
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'buyer-1' }));
    const restored = render(<PurchaseInvoiceClient />);
    expect(await screen.findByText('Purchase Drug')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الفاتورة' }));
    expect(screen.getByText('Purchase Drug')).toBeInTheDocument();
    jest.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الفاتورة' }));
    expect(sessionStorage.getItem(draftKey)).toBeNull();
    restored.unmount();
    render(<PurchaseInvoiceClient />);
    await screen.findByRole('option', { name: 'مورد اختبار' });
    expect(screen.queryByText('Purchase Drug')).not.toBeInTheDocument();
  });

  it('keeps a failed submission, but clears a saved draft even when leaving to another module', async () => {
    (createPurchaseInvoiceAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'Temporary failure' });
    const first = render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ كمسودة/ }));
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /حفظ كمسودة/ })).toBeEnabled());
    expect(sessionStorage.getItem(draftKey)).not.toBeNull();
    first.unmount();
    render(<PurchaseInvoiceClient />);
    expect(await screen.findByText('Purchase Drug')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /حفظ كمسودة/ }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/purchases'));
    expect(sessionStorage.getItem(draftKey)).toBeNull();
  });
});

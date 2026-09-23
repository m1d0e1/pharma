import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PurchaseInvoiceClient from '@/app/(dashboard)/purchases/new/PurchaseInvoiceClient';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { findDrugBarcodeConflict, getReplacementDrug, replaceDrugAction } from '@/app/actions-client/drug-replacement';
import {
  checkSupplierPendingInvoiceAction,
  createPurchaseInvoiceAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';
import { dbGet } from '@/lib/db/tauri';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();
const draftKey = 'pharma_purchase_draft_v2:["local_default","buyer-1"]';
const shortageHandoffKey = 'pharma_shortages_to_purchase_v2:["local_default","buyer-1"]';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/components/purchases/BarcodePrinter', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/master-drugs/QuickAddDrugModal', () => () => null);
jest.mock('@/app/actions-client/drug-replacement', () => ({
  findDrugBarcodeConflict: jest.fn().mockResolvedValue(null),
  replaceDrugAction: jest.fn(),
  getReplacementDrug: jest.fn(async (id: number) => ({ id, trade_name: id === 99 ? 'Old medicine' : 'Test Drug', barcode: '123456', official_price: 20, large_to_medium: 1 })),
}));
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
    (findDrugBarcodeConflict as jest.Mock).mockResolvedValue(null);
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

  it('warns before a conflicting purchase, allows cancellation or replacement, then saves only after review', async () => {
    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'CONFLICT-ORDER' } });
    fireEvent.change(document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1], { target: { value: '2030-01-01' } });
    (findDrugBarcodeConflict as jest.Mock).mockResolvedValue({ id: 99, trade_name: 'Old drug', barcode: '123456' });
    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    const first = await screen.findByRole('dialog');
    expect(within(first).getByText(/Old drug/)).toBeInTheDocument();
    expect(createPurchaseInvoiceAction).not.toHaveBeenCalled();
    fireEvent.click(within(first).getByRole('button', { name: /إلغاء — بدون تغيير/ }));
    expect(replaceDrugAction).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).toHaveValue('CONFLICT-ORDER');
    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'نقل الروابط وحذف القديم' });
    expect(confirm).toBeDisabled();
    fireEvent.change(await within(dialog).findByLabelText('البيانات النهائية: الاسم التجاري'), { target: { value: 'Reviewed Drug' } });
    fireEvent.change(within(dialog).getByLabelText('البيانات النهائية: سعر البيع'), { target: { value: '45' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.change(within(dialog).getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'test-password' } });
    (replaceDrugAction as jest.Mock).mockResolvedValue({ success: true, id: 101 });
    (getReplacementDrug as jest.Mock).mockResolvedValueOnce({ id: 101, trade_name: 'Reviewed Drug', barcode: '123456', official_price: 45 });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(replaceDrugAction).toHaveBeenCalledWith(99, 101, null, 'test-password', { trade_name: 'Reviewed Drug', official_price: 45 });
    expect(createPurchaseInvoiceAction).not.toHaveBeenCalled();
    (findDrugBarcodeConflict as jest.Mock).mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({ invoice_number: 'CONFLICT-ORDER', cart: [expect.objectContaining({ id: 101, trade_name: 'Reviewed Drug', selling_price: 45, barcode: '123456' })] }));
  });

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

  it('keeps a committed purchase invoice visible and locked when post-save navigation throws', async () => {
    mockPush.mockImplementationOnce(() => { throw new Error('navigation unavailable'); });
    render(<PurchaseInvoiceClient />);

    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'NAV-FAIL-1' } });
    const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
    fireEvent.change(dateInputs[1], { target: { value: '2028-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));

    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('تم تسجيل فاتورة الشراء بنجاح');
    expect(toast.error).toHaveBeenCalledWith('تم تسجيل فاتورة الشراء بنجاح لكن تعذر فتح قائمة المشتريات');
    expect(toast.error).not.toHaveBeenCalledWith('navigation unavailable');
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).toHaveValue('NAV-FAIL-1');
    expect(screen.getByText('Purchase Drug')).toBeInTheDocument();
    const committedSave = screen.getByRole('button', { name: 'تم حفظ الفاتورة' });
    expect(committedSave).toBeDisabled();
    fireEvent.click(committedSave);
    expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1);
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

    sessionStorage.setItem(shortageHandoffKey, JSON.stringify([{ drug_id: 202, trade_name: 'Shortage Drug', requested_quantity: 4, official_price: 30 }]));
    render(<PurchaseInvoiceClient />);
    expect(await screen.findByText('Purchase Drug')).toBeInTheDocument();
    expect(screen.getAllByText('Shortage Drug')).toHaveLength(2);
    const combined = JSON.parse(sessionStorage.getItem(draftKey)!);
    expect(combined.cart[0]).toEqual(before.cart[0]);
    expect(combined.cart[1]).toMatchObject({ id: 202, quantity: 4 });
    expect(combined.invoiceHeader).toEqual(before.invoiceHeader);
    expect(sessionStorage.getItem(shortageHandoffKey)).toBeNull();
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

  it('does not import a shortage handoff created by another pharmacy user', async () => {
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'buyer-1', pharmacy_id: 'ph-1' }));
    sessionStorage.setItem(
      'pharma_shortages_to_purchase_v2:["ph-1","buyer-1"]',
      JSON.stringify([{ drug_id: 202, trade_name: 'Foreign Shortage Drug', requested_quantity: 4, official_price: 30 }])
    );
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'buyer-2', pharmacy_id: 'ph-2' }));

    render(<PurchaseInvoiceClient />);
    await screen.findByRole('option', { name: 'مورد اختبار' });

    expect(screen.queryByText('Foreign Shortage Drug')).not.toBeInTheDocument();
  });

  it('scopes historical unit-conversion fallback to the signed-in pharmacy', async () => {
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'buyer-1', pharmacy_id: 'ph-1' }));
    (searchMasterDrugsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{
        id: 303,
        trade_name: 'Fallback Drug',
        trade_name_en: 'Fallback Drug',
        official_price: 20,
        base_price: 12,
        large_to_medium: null,
      }],
    });
    (dbGet as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ strips_per_box: 4 });

    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: 'Fallback' } });
    fireEvent.click(await screen.findByRole('button', { name: /Fallback Drug/ }));

    await waitFor(() => {
      expect(dbGet).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('pharmacy_id = ?'),
        [303, 'ph-1', 'ph-1']
      );
      expect(dbGet).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('JOIN purchase_invoices pi'),
        [303, 'ph-1', 'ph-1']
      );
    });
  });

  it('keeps the newest purchase drug search when an older request resolves afterwards', async () => {
    let resolveOlder!: (value: any) => void;
    let resolveNewer!: (value: any) => void;
    const older = new Promise(resolve => { resolveOlder = resolve; });
    const newer = new Promise(resolve => { resolveNewer = resolve; });
    (searchMasterDrugsAction as jest.Mock)
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);

    render(<PurchaseInvoiceClient />);
    const search = screen.getByPlaceholderText('اسم الصنف أو الباركود...');
    fireEvent.change(search, { target: { value: 'Older' } });
    fireEvent.change(search, { target: { value: 'Newer' } });
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewer({ success: true, data: [{ id: 202, trade_name_en: 'Newest Purchase Drug', official_price: 25 }] });
      await newer;
    });
    expect(await screen.findByRole('button', { name: /Newest Purchase Drug/ })).toBeInTheDocument();

    await act(async () => {
      resolveOlder({ success: true, data: [{ id: 201, trade_name_en: 'Stale Purchase Drug', official_price: 20 }] });
      await older;
    });
    expect(screen.getByRole('button', { name: /Newest Purchase Drug/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stale Purchase Drug/ })).not.toBeInTheDocument();
  });

  it('clears stale purchase drug suggestions and reports a thrown catalog search', async () => {
    (searchMasterDrugsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [{ id: 301, trade_name_en: 'Visible Purchase Drug', official_price: 20 }] })
      .mockRejectedValueOnce(new Error('catalog bridge unavailable'));

    render(<PurchaseInvoiceClient />);
    const search = screen.getByPlaceholderText('اسم الصنف أو الباركود...');
    fireEvent.change(search, { target: { value: 'Visible' } });
    expect(await screen.findByRole('button', { name: /Visible Purchase Drug/ })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'Broken' } });

    await waitFor(() => expect(screen.queryByRole('button', { name: /Visible Purchase Drug/ })).not.toBeInTheDocument());
    expect(toast.error).toHaveBeenCalledWith('فشل البحث في كتالوج الأدوية');
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

  it('distinguishes a returned supplier-load failure from an empty supplier list and retries without clearing invoice fields', async () => {
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: false, error: 'supplier list unavailable' });

    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'KEEP-ME' } });

    expect(await screen.findByText('تعذر تحميل قائمة الموردين')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).toHaveValue('KEEP-ME');
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 9, name_ar: 'مورد مستعاد', balance: 0 }] });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل الموردين' }));

    expect(await screen.findByRole('option', { name: 'مورد مستعاد' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).toHaveValue('KEEP-ME');
    expect(getSuppliersAction).toHaveBeenCalledTimes(2);
  });

  it('recovers from a thrown supplier loader instead of silently showing an empty selector', async () => {
    (getSuppliersAction as jest.Mock).mockRejectedValue(new Error('supplier bridge unavailable'));

    render(<PurchaseInvoiceClient />);

    expect(await screen.findByText('تعذر تحميل قائمة الموردين')).toBeInTheDocument();
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 10, name_ar: 'مورد بعد استثناء', balance: 0 }] });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل الموردين' }));
    expect(await screen.findByRole('option', { name: 'مورد بعد استثناء' })).toBeInTheDocument();
  });
});

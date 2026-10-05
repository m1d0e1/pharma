import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PurchaseInvoiceClient from '@/app/(dashboard)/purchases/new/PurchaseInvoiceClient';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { findDrugBarcodeConflict, findDrugBarcodeOwners, getReplacementDrug, reconcileDrugBarcodeOwnersAction, replaceDrugAction } from '@/app/actions-client/drug-replacement';
import {
  checkSupplierPendingInvoiceAction,
  createPurchaseInvoiceAction,
  getSuppliersAction,
  getDraftPurchaseInvoicesAction,
  getPurchaseInvoiceAction,
  getPurchaseInvoiceDetailsAction,
  updateCompletedPurchaseInvoiceAction,
} from '@/app/actions-client/purchases';
import { dbGet } from '@/lib/db/tauri';
import { toast } from 'react-hot-toast';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

const mockPush = jest.fn();
const draftKey = 'pharma_purchase_draft_v2:["local_default","buyer-1"]';
const shortageHandoffKey = 'pharma_shortages_to_purchase_v2:["local_default","buyer-1"]';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/components/purchases/BarcodePrinter', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => function MockDrugDetailsModal(props: any) {
  return (
    <div data-testid="purchase-drug-details-mock">
      <button
        type="button"
        onClick={() => props.onDrugUpdated?.({
          id: props.drugId,
          trade_name: 'Catalog renamed drug',
          trade_name_en: 'Catalog Renamed Drug',
          barcode: 'CATALOG-CHANGED',
          official_price: 99,
          stop_dealing: 0,
        })}
      >
        mock catalog update
      </button>
      <button
        type="button"
        onClick={() => props.onDrugUpdated?.({ id: props.drugId, stop_dealing: 1 })}
      >
        mock archive
      </button>
      <button type="button" onClick={() => props.onDrugDeleted?.(props.drugId)}>
        mock delete
      </button>
    </div>
  );
});
jest.mock('@/components/master-drugs/QuickAddDrugModal', () => () => null);
jest.mock('@/app/actions-client/drug-replacement', () => ({
  findDrugBarcodeConflict: jest.fn().mockResolvedValue(null),
  findDrugBarcodeOwners: jest.fn().mockResolvedValue([]),
  reconcileDrugBarcodeOwnersAction: jest.fn(),
  replaceDrugAction: jest.fn(),
  getReplacementDrug: jest.fn(async (id: number) => ({ id, trade_name: id === 99 ? 'Old medicine' : 'Test Drug', barcode: '123456', official_price: 20, large_to_medium: 1 })),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({ searchMasterDrugsAction: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  getSuppliersAction: jest.fn(),
  getDraftPurchaseInvoicesAction: jest.fn(),
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
    (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([]);
    sessionStorage.clear();
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'buyer-1' }));
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'buyer-1',
      role: 'admin',
      permissions: { can_view_purchases: true, can_manage_inventory: true },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true);
    mockPush.mockReset();
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 7, name_ar: 'مورد اختبار', balance: 125 }],
    });
    (getDraftPurchaseInvoicesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
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
    (updateCompletedPurchaseInvoiceAction as jest.Mock).mockResolvedValue({ success: true });
  });

  afterEach(() => jest.restoreAllMocks());

  it('exposes labeled header controls and explicit payment selection state', async () => {
    render(<PurchaseInvoiceClient />);

    expect(await screen.findByLabelText('المورد')).toBeInTheDocument();
    expect(screen.getByLabelText('رقم الفاتورة')).toBeInTheDocument();
    expect(screen.getByLabelText('تاريخ الفاتورة')).toBeInTheDocument();
    expect(screen.getByLabelText('البحث عن صنف للشراء')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إضافة دواء جديد' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'طباعة فاتورة الشراء' })).toBeInTheDocument();

    const cash = screen.getByRole('button', { name: 'نقدي' });
    const credit = screen.getByRole('button', { name: 'آجل' });
    const check = screen.getByRole('button', { name: 'شيك' });
    expect(credit).toHaveAttribute('aria-pressed', 'true');
    expect(cash).toHaveAttribute('aria-pressed', 'false');
    expect(check).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(check);
    expect(check).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('رقم الشيك')).toBeInTheDocument();
  });

  it('warns on completed receipt edits, keeps the original line ID, and asks before saving', async () => {
    window.history.replaceState({}, '', '/purchases/new?edit_invoice_id=purchase-1');
    (getPurchaseInvoiceAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'purchase-1', status: 'completed', supplier_id: 7,
        invoice_number: 'INV-ORIGINAL', invoice_date: '2026-08-30', payment_method: 'cash',
      },
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 44, drug_id: 101, trade_name: 'دواء شراء', trade_name_en: 'Purchase Drug',
        unit_id: 6,
        quantity: 5, bonus_quantity: 0, cost_price: 12, selling_price: 20,
        discount_percent: 40, discount_value: 48,
        expiry_date: '2029-12-31', strips_per_box: 2, barcode: '123456',
      }],
    });

    const view = render(<PurchaseInvoiceClient />);
    expect(await screen.findByRole('note')).toHaveTextContent(/تكلفة البضاعة المباعة سابقاً/);
    expect(screen.getByRole('note')).toHaveTextContent(/الرصيد غير المستهلك/);
    expect(screen.getByRole('note')).toHaveTextContent(/زيادة الكمية تسجل توريداً إضافياً/);
    expect(screen.getByRole('heading', { name: 'تعديل فاتورة شراء مكتملة' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeEnabled();
    expect(screen.getByDisplayValue('2026-08-30')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'نقدي' })).toBeEnabled();

    const itemRow = screen.getAllByText('Purchase Drug')[1].closest('tr')!;
    fireEvent.change(within(itemRow).getByDisplayValue('20'), { target: { value: '25' } });
    expect(within(itemRow).getByDisplayValue('25')).toBeInTheDocument();
    expect(within(itemRow).getByDisplayValue('12')).toBeInTheDocument();
    expect(within(itemRow).getByDisplayValue('40')).toBeInTheDocument();

    const save = screen.getByRole('button', { name: /حفظ التعديلات/ });
    jest.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(save);
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('الوردية الحالية')));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('إذا استُهلك جزء من الفاتورة'));
    expect(updateCompletedPurchaseInvoiceAction).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('INV-ORIGINAL')).toBeInTheDocument();

    (updateCompletedPurchaseInvoiceAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'تعذر حفظ التعديل' });
    jest.mocked(window.confirm).mockReturnValueOnce(true);
    fireEvent.click(save);
    await waitFor(() => expect(updateCompletedPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(updateCompletedPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 'purchase-1',
      supplier_id: 7,
      cart: [expect.objectContaining({
        id: 101, unit_id: 6, purchase_invoice_item_id: 44, quantity: 5,
        selling_price: '25', cost_price: 12, discount_percent: 40, discount_value: 48,
      })],
    }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر حفظ التعديل'));
    expect(screen.getByDisplayValue('INV-ORIGINAL')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();

    (updateCompletedPurchaseInvoiceAction as jest.Mock).mockResolvedValueOnce({ success: true });
    jest.mocked(window.confirm).mockReturnValueOnce(true);
    fireEvent.click(save);
    await waitFor(() => expect(updateCompletedPurchaseInvoiceAction).toHaveBeenCalledTimes(2));

    view.unmount();
    window.history.replaceState({}, '', '/purchases');
  });

  it('keeps completed purchase lines isolated from catalog update, archive, and delete callbacks', async () => {
    window.history.replaceState({}, '', '/purchases/new?edit_invoice_id=purchase-1');
    (getPurchaseInvoiceAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'purchase-1', status: 'completed', supplier_id: 7,
        invoice_number: 'INV-ORIGINAL', invoice_date: '2026-08-30', payment_method: 'cash',
      },
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 44, drug_id: 101, trade_name: 'دواء شراء', trade_name_en: 'Purchase Drug',
        unit_id: 6,
        quantity: 5, bonus_quantity: 0, cost_price: 12, selling_price: 20,
        discount_percent: 40, discount_value: 48,
        expiry_date: '2029-12-31', strips_per_box: 2, barcode: '123456',
      }],
    });

    const view = render(<PurchaseInvoiceClient />);
    expect(await screen.findByRole('heading', { name: 'تعديل فاتورة شراء مكتملة' })).toBeInTheDocument();

    const itemRow = screen.getAllByText('Purchase Drug')[1].closest('tr')!;
    fireEvent.contextMenu(itemRow, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'معلومات الصنف' }));
    expect(await screen.findByTestId('purchase-drug-details-mock')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mock catalog update' }));
    expect(screen.getAllByText('Purchase Drug').length).toBeGreaterThan(0);
    expect(screen.queryByText('Catalog Renamed Drug')).not.toBeInTheDocument();
    expect(within(itemRow).getByDisplayValue('123456')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mock archive' }));
    expect(screen.getAllByText('Purchase Drug').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'mock delete' }));
    expect(screen.getAllByText('Purchase Drug').length).toBeGreaterThan(0);

    jest.mocked(window.confirm).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /حفظ التعديلات/ }));
    await waitFor(() => expect(updateCompletedPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(updateCompletedPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 'purchase-1',
      cart: [expect.objectContaining({
        id: 101,
        purchase_invoice_item_id: 44,
        barcode: '123456',
        selling_price: 20,
      })],
    }));

    view.unmount();
    window.history.replaceState({}, '', '/purchases');
  });

  it('shows master unit names on a loaded purchase conversion without changing canonical quantity semantics', async () => {
    window.history.replaceState({}, '', '/purchases/new?edit_invoice_id=purchase-custom-units');
    (getPurchaseInvoiceAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'purchase-custom-units',
        status: 'completed',
        supplier_id: 7,
        invoice_number: 'INV-CUSTOM-UNITS',
        invoice_date: '2026-09-30',
        payment_method: 'credit',
      },
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 61,
        drug_id: 101,
        trade_name: 'دواء وحدات مخصصة',
        trade_name_en: 'Custom Unit Purchase Drug',
        quantity: 3,
        bonus_quantity: 0,
        cost_price: 12,
        selling_price: 20,
        discount_percent: 0,
        tax_percent: 0,
        expiry_date: '2029-12-31',
        strips_per_box: 6,
        large_unit: 'زجاجة',
        medium_unit: 'باكيت',
        small_unit: 'مل',
        barcode: 'CUSTOM-PURCHASE-UNIT',
      }],
    });

    const view = render(<PurchaseInvoiceClient />);

    expect((await screen.findAllByText('Custom Unit Purchase Drug')).length).toBeGreaterThan(0);
    expect(screen.getByText('معامل التحويل')).toBeInTheDocument();
    expect(screen.getByText('باكيت/زجاجة')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'معامل تحويل باكيت/زجاجة' })).toHaveValue('6');
    expect(screen.queryByText('شرائط/علبة')).not.toBeInTheDocument();

    view.unmount();
    window.history.replaceState({}, '', '/purchases');
  });

  it('treats Dexatrol drops with missing unit metadata as a single-container purchase', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 5954,
        trade_name: 'DEXATROL EYE/EAR DROPS 5 ML',
        trade_name_en: null,
        barcode: null,
        official_price: 27,
        base_price: 20,
        large_unit: null,
        medium_unit: null,
        small_unit: null,
        large_to_medium: null,
        medium_to_small: null,
        has_expiry: 1,
      }],
    });

    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), {
      target: { value: 'DEXATROL' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /DEXATROL EYE\/EAR DROPS 5 ML/i }));

    const singleUnitLabel = await screen.findByText('وحدة مفردة');
    const itemRow = singleUnitLabel.closest('tr')!;
    expect(itemRow).not.toBeNull();
    expect(within(itemRow).getByText('زجاجة')).toBeInTheDocument();
    expect(within(itemRow).queryByRole('textbox', { name: /معامل تحويل/ })).not.toBeInTheDocument();
  });

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

  it('rewrites the purchase cart to the chosen canonical ID after reconciling three barcode owners', async () => {
    const canonical = { id: 99, trade_name: 'Canonical DEXATROL', trade_name_en: 'Canonical DEXATROL', barcode: '123456', inventory_barcodes: '123456', stock_quantity: 10, official_price: 27, large_to_medium: 1 };
    const cartDuplicate = { id: 101, trade_name: 'dexatrol drops', trade_name_en: 'dexatrol drops', barcode: '123456', inventory_barcodes: '123456', stock_quantity: 0, official_price: 27, large_to_medium: 1 };
    const third = { id: 102, trade_name: 'Drug 102', trade_name_en: 'Drug 102', barcode: '123456', inventory_barcodes: '123456', stock_quantity: 3, official_price: 27, large_to_medium: 1 };
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [{ ...cartDuplicate, base_price: 18.95 }] });
    (findDrugBarcodeConflict as jest.Mock).mockResolvedValue(canonical);
    (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([canonical, cartDuplicate, third]);
    (getReplacementDrug as jest.Mock).mockImplementation(async id => ({ 99: canonical, 101: cartDuplicate, 102: third } as any)[id]);
    (reconcileDrugBarcodeOwnersAction as jest.Mock).mockResolvedValue({ success: true, id: 99, backupPath: 'backups/group.db' });

    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /dexatrol drops/i }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'GROUP-CONFLICT' } });
    fireEvent.change(document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1], { target: { value: '2030-01-01' } });

    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/تعارض باركود متعدد/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText(/الاحتفاظ بالصنف #99/));
    await within(dialog).findByLabelText('البيانات النهائية: الاسم التجاري');
    fireEvent.click(within(dialog).getByLabelText(/جميع الأصناف المذكورة/));
    fireEvent.change(within(dialog).getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'admin-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'نقل الروابط وحذف القديم' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(reconcileDrugBarcodeOwnersAction).toHaveBeenCalledWith([101, 102], 99, 'admin-password', {});
    (findDrugBarcodeConflict as jest.Mock).mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      invoice_number: 'GROUP-CONFLICT',
      cart: [expect.objectContaining({ id: 99, trade_name: 'Canonical DEXATROL', barcode: '123456' })],
    }));
  });

  it('does not offer destructive catalog replacement to a purchase-only admin', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'buyer-1',
      role: 'admin',
      permissions: { can_view_purchases: true, can_manage_inventory: false },
    });
    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'CONFLICT-DENIED' } });
    fireEvent.change(document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1], { target: { value: '2030-01-01' } });
    (findDrugBarcodeConflict as jest.Mock).mockResolvedValue({ id: 99, trade_name: 'Old drug', barcode: '123456' });

    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('إدارة المخزون')));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(replaceDrugAction).not.toHaveBeenCalled();
    expect(createPurchaseInvoiceAction).not.toHaveBeenCalled();
  });

  it.each([false, true])('submits the full invoice and clears the local draft (print barcodes: %s)', async printBarcodes => {
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

    const postSaveDialog = await screen.findByRole('dialog', { name: 'تم حفظ فاتورة الشراء' });
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('تم حفظ الفاتورة');
    expect(window.confirm).not.toHaveBeenCalledWith(expect.stringContaining('طباعة الباركود'));

    if (printBarcodes) {
      fireEvent.click(within(postSaveDialog).getByRole('button', { name: 'طباعة الباركود' }));
      expect(mockPush).not.toHaveBeenCalledWith('/purchases');
    } else {
      fireEvent.click(within(postSaveDialog).getByRole('button', { name: 'العودة إلى المشتريات' }));
      expect(mockPush).toHaveBeenCalledWith('/purchases');
    }
    expect(sessionStorage.getItem(draftKey)).toBeNull();
    view.unmount();
    render(<PurchaseInvoiceClient />);
    await screen.findByRole('option', { name: 'مورد اختبار' });
    expect(screen.queryByText('Purchase Drug')).not.toBeInTheDocument();
  });

  it('allows a completed purchase with blank expiry for a non-expiring master drug', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{
        id: 101,
        trade_name: 'دواء بدون صلاحية',
        trade_name_en: 'Non Expiring Purchase Drug',
        barcode: 'NO-EXPIRY-101',
        official_price: 20,
        base_price: 12,
        large_to_medium: 2,
        has_expiry: 0,
      }],
    });
    render(<PurchaseInvoiceClient />);

    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: 'NO-EXPIRY-101' } });
    fireEvent.click(await screen.findByRole('button', { name: /Non Expiring Purchase Drug/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'NO-EXPIRY-INV' } });

    const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
    expect(dateInputs).toHaveLength(2);
    expect(dateInputs[1]).toBeDisabled();
    expect(dateInputs[1]).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      cart: [expect.objectContaining({ id: 101, has_expiry: 0, expiry_date: '' })],
    })));
  });

  it('submits the current purchase as a draft when the native F10 bridge fires', async () => {
    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'NATIVE-F10-DRAFT' } });
    fireEvent.click(screen.getByRole('button', { name: 'شيك' }));
    fireEvent.change(screen.getByPlaceholderText('رقم الشيك...'), { target: { value: 'CHK-F10' } });

    await act(async () => {
      window.dispatchEvent(new Event('pharma:purchase-save-draft'));
    });

    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      supplier_id: 7,
      invoice_number: 'NATIVE-F10-DRAFT',
      payment_method: 'check',
      check_number: 'CHK-F10',
      status: 'draft',
      cart: [expect.objectContaining({ id: 101, quantity: 1 })],
    }));
  });

  it('captures the real F10 key before the Windows menu default and submits one draft', async () => {
    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'WINDOWS-F10-DRAFT' } });

    const event = new KeyboardEvent('keydown', {
      key: 'F10',
      bubbles: true,
      cancelable: true,
    });
    const dispatched = window.dispatchEvent(event);

    expect(dispatched).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      supplier_id: 7,
      invoice_number: 'WINDOWS-F10-DRAFT',
      status: 'draft',
      cart: [expect.objectContaining({ id: 101, quantity: 1 })],
    }));
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
    const postSaveDialog = await screen.findByRole('dialog', { name: 'تم حفظ فاتورة الشراء' });
    fireEvent.click(within(postSaveDialog).getByRole('button', { name: 'العودة إلى المشتريات' }));
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

  it('cancels a staged shortage handoff without posting a purchase', async () => {
    sessionStorage.setItem(shortageHandoffKey, JSON.stringify([
      { drug_id: 202, trade_name: 'Shortage Cancel Drug', requested_quantity: 4, official_price: 30 },
    ]));
    jest.mocked(window.confirm).mockReturnValue(true);

    render(<PurchaseInvoiceClient />);
    expect((await screen.findAllByText('Shortage Cancel Drug')).length).toBeGreaterThan(0);
    expect(sessionStorage.getItem(shortageHandoffKey)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الفاتورة' }));

    expect(createPurchaseInvoiceAction).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(draftKey)).toBeNull();
    expect(screen.queryByText('Shortage Cancel Drug')).not.toBeInTheDocument();
  });

  it('abandons a staged shortage handoff without posting a purchase', async () => {
    sessionStorage.setItem(shortageHandoffKey, JSON.stringify([
      { drug_id: 203, trade_name: 'Shortage Abandon Drug', requested_quantity: 2, official_price: 25 },
    ]));

    const view = render(<PurchaseInvoiceClient />);
    expect((await screen.findAllByText('Shortage Abandon Drug')).length).toBeGreaterThan(0);
    expect(sessionStorage.getItem(shortageHandoffKey)).toBeNull();

    view.unmount();

    expect(createPurchaseInvoiceAction).not.toHaveBeenCalled();
  });

  it('keeps an explicit cash choice when a delayed supplier draft auto-load finishes', async () => {
    let resolvePending!: (value: any) => void;
    const pending = new Promise(resolve => { resolvePending = resolve; });
    (checkSupplierPendingInvoiceAction as jest.Mock).mockImplementationOnce(() => pending);
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{
        id: 55, drug_id: 101, trade_name: 'دواء شراء', trade_name_en: 'Purchase Drug',
        quantity: 1, bonus_quantity: 0, cost_price: 12, selling_price: 20,
        discount_percent: 0, tax_percent: 0,
        expiry_date: '2029-12-31', strips_per_box: 2, barcode: '123456',
      }],
    });
    window.history.replaceState({}, '', '/purchases/new?supplier_id=7');

    render(<PurchaseInvoiceClient />);
    await waitFor(() => expect(checkSupplierPendingInvoiceAction).toHaveBeenCalledWith(7));

    const cash = screen.getByRole('button', { name: 'نقدي' });
    fireEvent.click(cash);
    expect(cash.className).toContain('text-emerald-600');

    await act(async () => {
      resolvePending({
        success: true,
        hasPending: true,
        invoice: {
          id: 'pending-credit',
          invoice_number: 'PENDING-CREDIT',
          invoice_date: '2026-09-29',
          payment_method: 'credit',
          notes: '',
          check_number: '',
          discount_percent: 0,
          discount_value: 0,
          expenses: 0,
          tax_percent: 0,
        },
      });
      await pending;
    });

    expect(await screen.findAllByText('Purchase Drug')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'نقدي' }).className).toContain('text-emerald-600');

    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 'pending-credit',
      payment_method: 'cash',
      status: 'completed',
    })));
  });

  it('keeps an explicit cash choice when continuing a pending supplier draft from the toast', async () => {
    (checkSupplierPendingInvoiceAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      hasPending: true,
      invoice: {
        id: 'pending-toast-credit',
        invoice_number: 'PENDING-TOAST-CREDIT',
        invoice_date: '2026-09-29',
        payment_method: 'credit',
        notes: '',
        check_number: '',
        discount_percent: 0,
        discount_value: 0,
        expenses: 0,
        tax_percent: 0,
      },
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{
        id: 56, drug_id: 101, trade_name: 'دواء شراء', trade_name_en: 'Purchase Drug',
        quantity: 1, bonus_quantity: 0, cost_price: 12, selling_price: 20,
        discount_percent: 0, tax_percent: 0,
        expiry_date: '2029-12-31', strips_per_box: 2, barcode: '123456',
      }],
    });

    render(<PurchaseInvoiceClient />);
    const supplier = await screen.findByRole('combobox');
    fireEvent.change(supplier, { target: { value: '7' } });
    await waitFor(() => expect(checkSupplierPendingInvoiceAction).toHaveBeenCalledWith(7));

    const cash = screen.getByRole('button', { name: 'نقدي' });
    fireEvent.click(cash);
    expect(cash.className).toContain('text-emerald-600');

    const toastRenderer = (toast as unknown as jest.Mock).mock.calls
      .map(([content]) => content)
      .find((content) => typeof content === 'function');
    expect(toastRenderer).toBeDefined();
    render(toastRenderer({ id: 'pending-toast' }));
    fireEvent.click(screen.getByRole('button', { name: 'استكمال الفاتورة' }));

    expect(await screen.findAllByText('Purchase Drug')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'نقدي' }).className).toContain('text-emerald-600');

    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 'pending-toast-credit',
      payment_method: 'cash',
      status: 'completed',
    })));
  });

  it('keeps an explicit cheque number when continuing a pending supplier draft from the toast', async () => {
    (checkSupplierPendingInvoiceAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      hasPending: true,
      invoice: {
        id: 'pending-toast-credit',
        invoice_number: 'PENDING-TOAST-CREDIT',
        invoice_date: '2026-09-29',
        payment_method: 'credit',
        notes: '',
        check_number: '',
        discount_percent: 0,
        discount_value: 0,
        expenses: 0,
        tax_percent: 0,
      },
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{
        id: 57, drug_id: 101, trade_name: 'دواء شراء', trade_name_en: 'Purchase Drug',
        quantity: 1, bonus_quantity: 0, cost_price: 12, selling_price: 20,
        discount_percent: 0, tax_percent: 0,
        expiry_date: '2029-12-31', strips_per_box: 2, barcode: '123456',
      }],
    });

    render(<PurchaseInvoiceClient />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    await waitFor(() => expect(checkSupplierPendingInvoiceAction).toHaveBeenCalledWith(7));

    fireEvent.click(screen.getByRole('button', { name: 'شيك' }));
    const checkNumber = screen.getByPlaceholderText('رقم الشيك...');
    fireEvent.change(checkNumber, { target: { value: 'USER-CHK-77' } });

    const toastRenderer = (toast as unknown as jest.Mock).mock.calls
      .map(([content]) => content)
      .find((content) => typeof content === 'function');
    expect(toastRenderer).toBeDefined();
    render(toastRenderer({ id: 'pending-toast-check' }));
    fireEvent.click(screen.getByRole('button', { name: 'استكمال الفاتورة' }));

    expect(await screen.findAllByText('Purchase Drug')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'شيك' }).className).toContain('text-amber-600');
    expect(screen.getByPlaceholderText('رقم الشيك...')).toHaveValue('USER-CHK-77');

    fireEvent.click(screen.getByRole('button', { name: /حفظ نهائي/ }));
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 'pending-toast-credit',
      payment_method: 'check',
      check_number: 'USER-CHK-77',
      status: 'completed',
    })));
  });

  it('ignores a pending supplier auto-load that resolves after the invoice is reset', async () => {
    let resolvePending!: (value: any) => void;
    const pending = new Promise(resolve => { resolvePending = resolve; });
    (checkSupplierPendingInvoiceAction as jest.Mock).mockImplementationOnce(() => pending);
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{
        id: 58, drug_id: 101, trade_name: 'دواء شراء', trade_name_en: 'Purchase Drug',
        quantity: 1, bonus_quantity: 0, cost_price: 12, selling_price: 20,
        discount_percent: 0, tax_percent: 0,
        expiry_date: '2029-12-31', strips_per_box: 2, barcode: '123456',
      }],
    });
    window.history.replaceState({}, '', '/purchases/new?supplier_id=7');
    jest.mocked(window.confirm).mockReturnValue(true);

    render(<PurchaseInvoiceClient />);
    await waitFor(() => expect(checkSupplierPendingInvoiceAction).toHaveBeenCalledWith(7));
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الفاتورة' }));
    expect(screen.getByRole('combobox')).toHaveValue('');

    await act(async () => {
      resolvePending({
        success: true,
        hasPending: true,
        invoice: {
          id: 'stale-after-reset',
          invoice_number: 'STALE-AFTER-RESET',
          invoice_date: '2026-09-29',
          payment_method: 'credit',
          notes: '',
          check_number: '',
          discount_percent: 0,
          discount_value: 0,
          expenses: 0,
          tax_percent: 0,
        },
      });
      await pending;
    });

    expect(screen.queryAllByText('Purchase Drug')).toHaveLength(0);
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).not.toHaveValue('STALE-AFTER-RESET');
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('invalidates an older supplier pending response when a saved draft is loaded', async () => {
    let resolveSupplierA!: (value: any) => void;
    const supplierAPending = new Promise(resolve => { resolveSupplierA = resolve; });
    (getSuppliersAction as jest.Mock).mockReset().mockResolvedValue({
      success: true,
      data: [
        { id: 7, name_ar: 'مورد أ', balance: 0 },
        { id: 8, name_ar: 'مورد ب', balance: 0 },
      ],
    });
    (checkSupplierPendingInvoiceAction as jest.Mock).mockReset().mockImplementationOnce(() => supplierAPending);
    (getDraftPurchaseInvoicesAction as jest.Mock).mockReset().mockResolvedValue({
      success: true,
      data: [{
        id: 'draft-b',
        supplier_id: 8,
        supplier_name: 'مورد ب',
        invoice_number: 'DRAFT-B',
        invoice_date: '2026-09-30',
      }],
    });
    (getPurchaseInvoiceAction as jest.Mock).mockReset().mockResolvedValue({
      success: true,
      data: {
        id: 'draft-b',
        supplier_id: 8,
        invoice_number: 'DRAFT-B',
        invoice_date: '2026-09-30',
        payment_method: 'credit',
        notes: '',
        check_number: '',
        discount_percent: 0,
        discount_value: 0,
        expenses: 0,
        tax_percent: 0,
      },
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockReset().mockResolvedValue({
      success: true,
      data: [{
        id: 59, drug_id: 202, trade_name: 'دواء ب', trade_name_en: 'Draft B Drug',
        quantity: 1, bonus_quantity: 0, cost_price: 10, selling_price: 15,
        discount_percent: 0, tax_percent: 0,
        expiry_date: '2029-12-31', strips_per_box: 1, barcode: 'B-202',
      }],
    });

    render(<PurchaseInvoiceClient />);
    const supplier = await screen.findByRole('combobox');
    fireEvent.change(supplier, { target: { value: '7' } });
    await waitFor(() => expect(checkSupplierPendingInvoiceAction).toHaveBeenCalledWith(7));

    fireEvent.click(screen.getByRole('button', { name: 'استرجاع المسودات' }));
    expect(await screen.findByText('المسودات المحفوظة')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تحميل المسودة' }));
    expect(await screen.findAllByText('Draft B Drug')).toHaveLength(2);
    expect(screen.getByRole('combobox')).toHaveValue('8');
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).toHaveValue('DRAFT-B');

    (toast as unknown as jest.Mock).mockClear();
    await act(async () => {
      resolveSupplierA({
        success: true,
        hasPending: true,
        invoice: {
          id: 'supplier-a-pending',
          invoice_number: 'SUPPLIER-A-PENDING',
          invoice_date: '2026-09-29',
          payment_method: 'cash',
          notes: '',
          check_number: '',
          discount_percent: 0,
          discount_value: 0,
          expenses: 0,
          tax_percent: 0,
        },
      });
      await supplierAPending;
    });

    expect(toast).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveValue('8');
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).toHaveValue('DRAFT-B');
    expect(screen.getAllByText('Draft B Drug')).toHaveLength(2);
  });

  it('ignores a stale pending-invoice response after the user switches suppliers', async () => {
    let resolveSupplierA!: (value: any) => void;
    const supplierAPending = new Promise(resolve => { resolveSupplierA = resolve; });
    (getSuppliersAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 7, name_ar: 'مورد أ', balance: 0 },
        { id: 8, name_ar: 'مورد ب', balance: 0 },
      ],
    });
    (checkSupplierPendingInvoiceAction as jest.Mock)
      .mockImplementationOnce(() => supplierAPending)
      .mockResolvedValueOnce({ success: true, hasPending: false });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 77, drug_id: 101, trade_name: 'دواء قديم', trade_name_en: 'Supplier A Draft Drug',
        quantity: 1, bonus_quantity: 0, cost_price: 12, selling_price: 20,
        discount_percent: 0, tax_percent: 0, expiry_date: '2029-12-31', strips_per_box: 2,
      }],
    });
    window.history.replaceState({}, '', '/purchases/new?supplier_id=7');

    render(<PurchaseInvoiceClient />);
    await waitFor(() => expect(checkSupplierPendingInvoiceAction).toHaveBeenCalledWith(7));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '8' } });
    await waitFor(() => expect(checkSupplierPendingInvoiceAction).toHaveBeenCalledWith(8));
    expect(screen.getByRole('combobox')).toHaveValue('8');

    await act(async () => {
      resolveSupplierA({
        success: true,
        hasPending: true,
        invoice: {
          id: 'supplier-a-draft',
          invoice_number: 'SUPPLIER-A-DRAFT',
          invoice_date: '2026-09-29',
          payment_method: 'credit',
          notes: '', check_number: '', discount_percent: 0, discount_value: 0, expenses: 0, tax_percent: 0,
        },
      });
      await supplierAPending;
    });

    expect(screen.getByRole('combobox')).toHaveValue('8');
    expect(screen.queryByText('Supplier A Draft Drug')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('مثلاً: INV-2024-001')).not.toHaveValue('SUPPLIER-A-DRAFT');
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

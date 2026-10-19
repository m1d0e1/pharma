import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseInvoiceClient from '@/app/(dashboard)/purchases/new/PurchaseInvoiceClient';
import { createPurchaseInvoiceAction, getSuppliersAction, checkSupplierPendingInvoiceAction } from '@/app/actions-client/purchases';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { findDrugBarcodeConflict } from '@/app/actions-client/drug-replacement';
import { useHotkeys } from 'react-hotkeys-hook';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/components/purchases/BarcodePrinter', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/master-drugs/QuickAddDrugModal', () => () => null);
jest.mock('@/components/master-drugs/DrugReplacementDialog', () => () => null);
jest.mock('@/app/actions-client/drug-replacement', () => ({ findDrugBarcodeConflict: jest.fn().mockResolvedValue(null) }));
jest.mock('@/app/actions-client/master-drugs', () => ({ searchMasterDrugsAction: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  getSuppliersAction: jest.fn(),
  createPurchaseInvoiceAction: jest.fn(),
  addPurchaseInvoiceItemAction: jest.fn(),
  completePurchaseInvoiceAction: jest.fn(),
  checkSupplierPendingInvoiceAction: jest.fn(),
  getDraftPurchaseInvoicesAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getPurchaseInvoiceAction: jest.fn(),
  updateCompletedPurchaseInvoiceAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: Object.assign(jest.fn(), {
    error: jest.fn(), success: jest.fn(), loading: jest.fn(), dismiss: jest.fn(),
  }),
}));

function f9Submit() {
  const handlers = (useHotkeys as jest.Mock).mock.calls.filter(([key]) => key === 'f9');
  return handlers[handlers.length - 1][1] as (event: { preventDefault: () => void }) => void;
}

async function populateInvoice(number: string) {
  fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
  fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
  fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: number } });
  const dates = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
  fireEvent.change(dates[1], { target: { value: '2030-12-31' } });
}

describe('persisted purchase creation nonce across reload', () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const NONCE = '12345678-abcd-4abc-8abc-123456789abc';
  beforeEach(() => {
    jest.clearAllMocks();
    (createPurchaseInvoiceAction as jest.Mock).mockReset();
    sessionStorage.clear();
    localStorage.setItem('pharma_session_user', JSON.stringify({ id:'owner-a',pharmacy_id:'A' }));
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:jest.fn(()=>NONCE)}});
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success:true,data:[{id:7,name_ar:'مورد اختبار',balance:0}],
    });
    (checkSupplierPendingInvoiceAction as jest.Mock).mockResolvedValue({success:true,hasPending:false});
    (jest.requireMock('@/app/actions-client/purchases').getDraftPurchaseInvoicesAction as jest.Mock)
      .mockResolvedValue({success:true,data:[]});
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success:true,data:[{id:101,trade_name:'دواء شراء',trade_name_en:'Purchase Drug',
        barcode:'123456',official_price:20,base_price:12,large_to_medium:2}],
    });
  });
  afterAll(() => {
    if (originalCrypto) Object.defineProperty(globalThis,'crypto',originalCrypto);
    else delete (globalThis as {crypto?: Crypto}).crypto;
  });

  it('restores exactly the old request nonce after an uncertain failure and clears it only on success', async () => {
    (createPurchaseInvoiceAction as jest.Mock)
      .mockResolvedValueOnce({success:false,error:'IPC status unknown'})
      .mockResolvedValueOnce({success:true,id:'created-a'});
    const first = render(<PurchaseInvoiceClient />);
    await populateInvoice('UNRESOLVED-1');
    await act(async () => { f9Submit()({preventDefault:jest.fn()}); });
    await waitFor(()=>expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    const key = 'pharma_purchase_draft_v2:["A","owner-a"]:pending-native-create-v1';
    expect(JSON.parse(sessionStorage.getItem(key) || 'null').requestId).toBe(NONCE);
    first.unmount();

    render(<PurchaseInvoiceClient />);
    await screen.findByDisplayValue('UNRESOLVED-1');
    await act(async () => { f9Submit()({preventDefault:jest.fn()}); });
    await waitFor(()=>expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(2));
    expect((createPurchaseInvoiceAction as jest.Mock).mock.calls[0][0].request_id).toBe(NONCE);
    expect((createPurchaseInvoiceAction as jest.Mock).mock.calls[1][0].request_id).toBe(NONCE);
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('posts a native purchase without invoking forbidden renderer barcode SQL preflight', async () => {
    // A conflict check from the renderer would fail strict native SQL before
    // the idempotent purchase request reached its authoritative Rust writer.
    (findDrugBarcodeConflict as jest.Mock).mockRejectedValue(new Error('renderer SQL denied'));
    (createPurchaseInvoiceAction as jest.Mock).mockResolvedValue({ success: true, id: 'native-synthetic-receipt' });

    render(<PurchaseInvoiceClient />);
    await populateInvoice('NATIVE-BARCODE-PREFLIGHT-REGR');
    await act(async () => { f9Submit()({ preventDefault: jest.fn() }); });

    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(findDrugBarcodeConflict).not.toHaveBeenCalled();
    expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      invoice_number: 'NATIVE-BARCODE-PREFLIGHT-REGR',
      request_id: NONCE,
      status: 'completed',
    }));
    expect(sessionStorage.getItem('pharma_purchase_draft_v2:["A","owner-a"]:pending-native-create-v1')).toBeNull();
  });

  it('requires an independently entered synthetic acquisition cost when catalog omits cost and conversion', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true, data: [{
        id: 16793, trade_name: 'دواء تجريبي', trade_name_en: 'PANADOL EXTRA 24 F.C. TABS',
        barcode: '', official_price: 54, base_price: 0, large_to_medium: 0, has_expiry: 1,
      }],
    });
    (createPurchaseInvoiceAction as jest.Mock).mockResolvedValue({ success: true, id: 'qa-shape-synthetic-invoice' });
    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: 'PANADOL' } });
    fireEvent.click(await screen.findByRole('button', { name: /PANADOL EXTRA 24/ }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: 'SYNTHETIC-PANADOL-001' } });
    const dates = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
    fireEvent.change(dates[1], { target: { value: '2099-10-30' } });

    await act(async () => { f9Submit()({ preventDefault: jest.fn() }); });
    expect(createPurchaseInvoiceAction).not.toHaveBeenCalled();
    // The catalog's official retail price is NOT purchase acquisition evidence.
    // No actual supplier invoice is created by this mocked synthetic fixture.
    const missingCost = screen.getByText('أدخل تكلفة شراء مؤكدة من المورد');
    const costInput = missingCost.previousElementSibling as HTMLInputElement | null;
    expect(costInput).toBeInstanceOf(HTMLInputElement);
    fireEvent.change(costInput!, { target: { value: '20' } });
    await act(async () => { f9Submit()({ preventDefault: jest.fn() }); });
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      supplier_id: 7, invoice_number: 'SYNTHETIC-PANADOL-001',
      payment_method: 'credit', status: 'completed', request_id: NONCE,
      cart: [expect.objectContaining({
        id: 16793, quantity: 1, cost_price: '20', barcode: '',
        expiry_date: '2099-10-30',
      })],
    }));
    expect(sessionStorage.getItem('pharma_purchase_draft_v2:["A","owner-a"]:pending-native-create-v1')).toBeNull();
  });

  it('blocks changed form after ambiguous attempt even across remount; does not submit another invoice', async () => {
    (createPurchaseInvoiceAction as jest.Mock).mockResolvedValue({success:false,error:'IPC unknown'});
    const first = render(<PurchaseInvoiceClient />);
    await populateInvoice('UNRESOLVED-2');
    await act(async () => { f9Submit()({preventDefault:jest.fn()}); });
    await waitFor(()=>expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<PurchaseInvoiceClient />);
    await screen.findByDisplayValue('UNRESOLVED-2');
    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), {target:{value:'CHANGED-INVOICE'}});
    await act(async () => { f9Submit()({preventDefault:jest.fn()}); });
    expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1);
    const key = 'pharma_purchase_draft_v2:["A","owner-a"]:pending-native-create-v1';
    expect(JSON.parse(sessionStorage.getItem(key) || 'null').requestId).toBe(NONCE);
  });

  it('allows correcting a first rejected pre-native validation without trapping the form behind an unused nonce', async () => {
    (createPurchaseInvoiceAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'سطر شراء مكرر', native_write_not_attempted: true })
      .mockResolvedValueOnce({ success: true, id: 'corrected-synthetic' });
    render(<PurchaseInvoiceClient />);
    await populateInvoice('INVALID-BEFORE-WRITER');
    await act(async () => { f9Submit()({ preventDefault: jest.fn() }); });
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    const key = 'pharma_purchase_draft_v2:["A","owner-a"]:pending-native-create-v1';
    expect(sessionStorage.getItem(key)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), {
      target: { value: 'CORRECTED-BEFORE-WRITER' },
    });
    await act(async () => { f9Submit()({ preventDefault: jest.fn() }); });
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(2));
    expect(createPurchaseInvoiceAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ invoice_number: 'CORRECTED-BEFORE-WRITER' }),
    );
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('preserves a prior uncertain purchase identity even when a later retry fails before its native write', async () => {
    (createPurchaseInvoiceAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'IPC unknown' })
      .mockResolvedValueOnce({ success: false, error: 'Permission revoked', native_write_not_attempted: true });
    render(<PurchaseInvoiceClient />);
    await populateInvoice('AMBIGUOUS-RETRY');
    await act(async () => { f9Submit()({ preventDefault: jest.fn() }); });
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
    await act(async () => { f9Submit()({ preventDefault: jest.fn() }); });
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(2));
    const key = 'pharma_purchase_draft_v2:["A","owner-a"]:pending-native-create-v1';
    expect(JSON.parse(sessionStorage.getItem(key) || 'null').requestId).toBe(NONCE);
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('cannot discard an unresolved original form through Cancel and then silently rotate its nonce', async () => {
    (createPurchaseInvoiceAction as jest.Mock).mockResolvedValue({success:false,error:'IPC result unknown'});
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<PurchaseInvoiceClient />);
      await populateInvoice('UNRESOLVED-CANCEL');
      await act(async () => { f9Submit()({preventDefault:jest.fn()}); });
      await waitFor(()=>expect(createPurchaseInvoiceAction).toHaveBeenCalledTimes(1));
      const key = 'pharma_purchase_draft_v2:["A","owner-a"]:pending-native-create-v1';
      fireEvent.click(screen.getByRole('button', {name:'إلغاء الفاتورة'}));
      expect(screen.getByDisplayValue('UNRESOLVED-CANCEL')).toBeInTheDocument();
      expect(JSON.parse(sessionStorage.getItem(key) || 'null').requestId).toBe(NONCE);
      expect(jest.requireMock('react-hot-toast').toast.error).toHaveBeenCalledWith(
        expect.stringContaining('محاولة شراء سابقة غير مؤكدة')
      );
    } finally {
      confirm.mockRestore();
    }
  });
});

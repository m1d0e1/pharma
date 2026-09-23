import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseInvoiceClient from '@/app/(dashboard)/purchases/new/PurchaseInvoiceClient';
import { useHotkeys } from 'react-hotkeys-hook';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { createPurchaseInvoiceAction, getSuppliersAction, checkSupplierPendingInvoiceAction } from '@/app/actions-client/purchases';
import { findDrugBarcodeConflict } from '@/app/actions-client/drug-replacement';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/components/purchases/BarcodePrinter', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/master-drugs/QuickAddDrugModal', () => () => null);
jest.mock('@/components/master-drugs/DrugReplacementDialog', () => () => null);
jest.mock('@/app/actions-client/drug-replacement', () => ({
  findDrugBarcodeConflict: jest.fn().mockResolvedValue(null),
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

function lastHotkeyHandler(key: string) {
  const calls = (useHotkeys as jest.Mock).mock.calls.filter(args => args[0] === key);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as (event: { preventDefault: jest.Mock }) => void;
}

async function populateValidInvoice(invoiceNumber: string) {
  fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
  fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
  fireEvent.change(screen.getByPlaceholderText('مثلاً: INV-2024-001'), { target: { value: invoiceNumber } });
  const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
  expect(dateInputs).toHaveLength(2);
  fireEvent.change(dateInputs[1], { target: { value: '2030-12-31' } });
}

describe('coverage-gap: purchase invoice keyboard shortcuts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'buyer-1', pharmacy_id: 'local_default' }));
    mockPush.mockReset();
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 7, name_ar: 'مورد اختبار', balance: 0 }],
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
    (findDrugBarcodeConflict as jest.Mock).mockResolvedValue(null);
    (createPurchaseInvoiceAction as jest.Mock).mockResolvedValue({ success: true, id: 'purchase-hotkey' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('F4 focuses the actual purchase search field', async () => {
    render(<PurchaseInvoiceClient />);
    const search = await screen.findByPlaceholderText('اسم الصنف أو الباركود...');
    expect(search).not.toHaveFocus();
    const preventDefault = jest.fn();

    lastHotkeyHandler('f4')({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(search).toHaveFocus();
  });

  it('F2 honors the discard confirmation before starting a new purchase invoice', async () => {
    render(<PurchaseInvoiceClient />);
    fireEvent.change(screen.getByPlaceholderText('اسم الصنف أو الباركود...'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: /Purchase Drug/ }));
    expect(screen.getByText('Purchase Drug')).toBeInTheDocument();

    const preventDefault = jest.fn();
    lastHotkeyHandler('f2')({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith('هل تريد مسح الفاتورة الحالية والبدء من جديد؟');
    expect(screen.getByText('Purchase Drug')).toBeInTheDocument();

    jest.mocked(window.confirm).mockReturnValue(true);
    lastHotkeyHandler('f2')({ preventDefault: jest.fn() });
    await waitFor(() => expect(screen.queryByText('Purchase Drug')).not.toBeInTheDocument());
  });

  it('F9 submits a valid invoice as completed through the same action as the Save button', async () => {
    render(<PurchaseInvoiceClient />);
    await populateValidInvoice('HOTKEY-F9');
    const preventDefault = jest.fn();

    lastHotkeyHandler('f9')({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      supplier_id: 7,
      invoice_number: 'HOTKEY-F9',
      status: 'completed',
      cart: [expect.objectContaining({ id: 101, quantity: 1, cost_price: 12, selling_price: 20, expiry_date: '2030-12-31' })],
    })));
  });

  it('F10 saves a valid invoice as draft instead of posting it completed', async () => {
    render(<PurchaseInvoiceClient />);
    await populateValidInvoice('HOTKEY-F10');
    const preventDefault = jest.fn();

    lastHotkeyHandler('f10')({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(createPurchaseInvoiceAction).toHaveBeenCalledWith(expect.objectContaining({
      supplier_id: 7,
      invoice_number: 'HOTKEY-F10',
      status: 'draft',
    })));
  });
});

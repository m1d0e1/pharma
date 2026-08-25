import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseInvoiceClient from '@/app/(dashboard)/purchases/new/PurchaseInvoiceClient';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import {
  checkSupplierPendingInvoiceAction,
  createPurchaseInvoiceAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';

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

  it('validates and submits the complete supplier-to-inventory invoice payload', async () => {
    render(<PurchaseInvoiceClient />);

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
    expect(mockPush).toHaveBeenCalledWith('/purchases');
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseReturnClient from '@/app/(dashboard)/purchases/returns/new/PurchaseReturnClient';
import {
  getSuppliersAction,
  createPurchaseReturnAction,
  getPurchasesReportsAction,
  getPurchaseInvoiceDetailsAction,
  searchPurchaseInvoicesForReturnAction,
} from '@/app/actions-client/purchases';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/app/actions-client/purchases', () => ({
  getSuppliersAction: jest.fn(),
  createPurchaseReturnAction: jest.fn(),
  getPurchasesReportsAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  searchPurchaseInvoicesForReturnAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('rendered purchase-return flow', () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: jest.fn(),
    });
  });

  beforeEach(() => {
    mockPush.mockReset();
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 1, name: 'المتحدة للأدوية' }],
    });
    (searchPurchaseInvoicesForReturnAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'purch-inv-1',
        invoice_number: 'PINV-101',
        supplier_id: 1,
        supplier_name: 'المتحدة للأدوية',
        total_amount: 1500,
        paid_amount: 1500,
        status: 'completed',
        created_at: '2026-08-30T10:00:00.000Z',
      }],
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'item-1',
        drug_id: 101,
        trade_name: 'Panadol Extra',
        trade_name_en: 'Panadol Extra',
        barcode: '6221000999',
        quantity: 10,
        refundable_large_unit_price: 50,
        remaining_large_quantity: 10,
        unit: 'large',
        large_to_medium: 2,
        medium_to_small: 10,
        expiry_date: '2027-12-31',
        returned_large_quantity: 0,
      }],
    });
    (createPurchaseReturnAction as jest.Mock).mockResolvedValue({
      success: true,
      id: 'return-p-1',
    });
  });

  it('searches purchase invoice by barcode and executes return successfully', async () => {
    render(<PurchaseReturnClient />);

    // 1. Type barcode in search input
    const searchInput = screen.getByPlaceholderText(/امسح الباركود، أو اكتب اسم الدواء/);
    fireEvent.change(searchInput, { target: { value: '6221000999' } });

    // Wait for invoice to load and select
    await waitFor(() => expect(searchPurchaseInvoicesForReturnAction).toHaveBeenCalledWith('6221000999'));
    expect(await screen.findByText('Panadol Extra')).toBeInTheDocument();

    // 2. Change return quantity
    const qtyInput = screen.getByDisplayValue('0');
    fireEvent.change(qtyInput, { target: { value: '3' } });

    // 3. Add return reason
    const reasonInput = screen.getByPlaceholderText(/اختياري/);
    fireEvent.change(reasonInput, { target: { value: 'تالف من المصدر' } });

    // 4. Click Submit Return
    const submitBtn = screen.getByRole('button', { name: /تنفيذ المرتجع/ });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createPurchaseReturnAction).toHaveBeenCalledWith(
        expect.objectContaining({
          purchase_invoice_id: 'purch-inv-1',
          supplier_id: 1,
          reason: 'تالف من المصدر',
          items: expect.arrayContaining([
            expect.objectContaining({
              drug_id: 101,
              quantity: 3,
              unit_price: 50,
            }),
          ]),
        })
      );
    });

    expect(mockPush).toHaveBeenCalledWith('/purchases/returns');
  });
});

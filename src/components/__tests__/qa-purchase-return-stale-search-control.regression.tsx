import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseReturnClient from '@/app/(dashboard)/purchases/returns/new/PurchaseReturnClient';
import {
  createPurchaseReturnAction,
  getPurchaseInvoiceDetailsAction,
  getSuppliersAction,
  searchPurchaseInvoicesForReturnAction,
} from '@/app/actions-client/purchases';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseReturnAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
  searchPurchaseInvoicesForReturnAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const oldA = {
  id: 'old-purchase-A', invoice_number: 'OLD-A', supplier_id: 81,
  supplier_name: 'Synthetic Supplier', status: 'completed', total_amount: 100,
};
const oldB = {
  id: 'old-purchase-B', invoice_number: 'OLD-B', supplier_id: 81,
  supplier_name: 'Synthetic Supplier', status: 'completed', total_amount: 200,
};
const fresh = {
  id: 'fresh-purchase-C', invoice_number: 'FRESH-C', supplier_id: 81,
  supplier_name: 'Synthetic Supplier', status: 'completed', total_amount: 70,
};

const detailsFor = (invoiceId: string) => [{
  id: 'item-' + invoiceId, drug_id: 151,
  trade_name: invoiceId === fresh.id ? 'Fresh Drug' : 'Old Drug',
  inventory_id: 'lot-' + invoiceId, quantity: 4, returned_large_quantity: 0,
  remaining_large_quantity: 4, refundable_large_unit_price: 25,
  unit: 'large', large_to_medium: 2, medium_to_small: 10,
}];

describe('rendered purchase-return search source custody (mocked action boundary)', () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true, value: jest.fn(),
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ id: 81, name_ar: 'Synthetic Supplier' }],
    });
    (searchPurchaseInvoicesForReturnAction as jest.Mock).mockImplementation(async (term: string) => {
      if (term === 'old-source') return { success: true, data: [oldA, oldB] };
      if (term === 'new-query-fails') {
        return { success: false, error: 'Supplier purchase-return source denied' };
      }
      if (term === 'fresh-source') return { success: true, data: [fresh] };
      return { success: true, data: [] };
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockImplementation(async (id: string) => ({
      success: true, data: detailsFor(id),
    }));
    (createPurchaseReturnAction as jest.Mock).mockResolvedValue({ success: true, id: 'synthetic-return' });
  });

  it('removes old invoice controls when a new search fails; only a newly proven receipt can fund the return', async () => {
    render(<PurchaseReturnClient />);
    const search = screen.getByRole('textbox', { name: /البحث بالباركود أو اسم الصنف أو رقم الفاتورة/ });

    fireEvent.change(search, { target: { value: 'old-source' } });
    expect(await screen.findByRole('button', { name: /رقم الفاتورة: OLD-B/ })).toBeInTheDocument();
    expect(await screen.findByText('Old Drug')).toBeInTheDocument();
    const oldReadCount = (getPurchaseInvoiceDetailsAction as jest.Mock).mock.calls.length;

    fireEvent.change(search, { target: { value: 'new-query-fails' } });
    // The old source cannot remain selectable during the new lookup, or after
    // the action denies the newer lookup. This is a rendered control claim,
    // not a simulated native authorization or financial commit.
    expect(screen.queryByRole('button', { name: /رقم الفاتورة: OLD-A/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /رقم الفاتورة: OLD-B/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تنفيذ المرتجع' })).not.toBeInTheDocument();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Supplier purchase-return source denied'));
    expect(screen.queryByRole('button', { name: /رقم الفاتورة: OLD-B/ })).not.toBeInTheDocument();
    expect((getPurchaseInvoiceDetailsAction as jest.Mock).mock.calls.length).toBe(oldReadCount);
    expect(createPurchaseReturnAction).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'fresh-source' } });
    expect(await screen.findByRole('button', { name: /رقم الفاتورة: FRESH-C/ })).toBeInTheDocument();
    expect(await screen.findByText('Fresh Drug')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /رقم الفاتورة: OLD-B/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('0'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      purchase_invoice_id: fresh.id,
      supplier_id: 81,
      items: [expect.objectContaining({ purchase_invoice_item_id: 'item-' + fresh.id, quantity: 1 })],
    })));
    expect(createPurchaseReturnAction).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/purchases/returns');
  });
});

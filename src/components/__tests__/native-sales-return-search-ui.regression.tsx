import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesReturnClient from '@/app/(dashboard)/returns/new/SalesReturnClient';
import {
  createReturnAction,
  getInvoiceForReturnAction,
  getSalesInvoicesByDateAction,
  searchRecentReturnInvoicesAction,
} from '@/app/actions-client/returns';
import { toast } from 'react-hot-toast';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/app/actions-client/returns', () => ({
  createReturnAction: jest.fn(),
  getInvoiceForReturnAction: jest.fn(),
  getSalesInvoicesByDateAction: jest.fn(),
  searchRecentReturnInvoicesAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

describe('sales-return invoice native-search UI query', () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true, value: jest.fn(),
    });
  });
  beforeEach(() => {
    jest.clearAllMocks();
    (getSalesInvoicesByDateAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true, data: {
        id: '3726c3df-c9cf-4e32-835a-848d045e69aa', total_amount: 300,
        payment_method: 'cash', patient_name: null,
        items: [{ id: 8, inventory_id: 'lot-a', drug_name: 'Panadol Extra',
          quantity_sold: 2, returned_quantity: 0, unit_price: 150, unit: 'large' }],
      },
    });
  });

  it('selects a tenant-owned native ID-prefix result without exposing an unowned patient name', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true, data: [{
        id: '3726c3df-c9cf-4e32-835a-848d045e69aa',
        total_amount: 300, payment_method: 'cash',
        created_at: '2026-10-17 09:30:00', patient_name: null, user_name: 'Owned Cashier',
      }],
    });
    render(<SalesReturnClient />);
    fireEvent.change(screen.getByLabelText(/البحث بالباركود أو اسم الصنف/), {
      target: { value: '3726c3df' },
    });
    await waitFor(() => expect(searchRecentReturnInvoicesAction).toHaveBeenCalledWith('3726c3df'));
    expect(await screen.findByRole('button', { name: /رقم الفاتورة: 3726c3df/i })).toBeInTheDocument();
    expect(screen.queryByText(/Foreign Patient/)).not.toBeInTheDocument();
    await waitFor(() => expect(getInvoiceForReturnAction)
      .toHaveBeenCalledWith('3726c3df-c9cf-4e32-835a-848d045e69aa'));
    expect(createReturnAction).not.toHaveBeenCalled();
  });

  it('shows native 043-denial feedback instead of pretending there were no eligible invoices', async () => {
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: false, data: [], error: 'Matched sale has unverified 043 provenance or tenant ownership',
    });
    render(<SalesReturnClient />);
    fireEvent.change(screen.getByLabelText(/البحث بالباركود أو اسم الصنف/), {
      target: { value: '3726c3df' },
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Matched sale has unverified 043 provenance or tenant ownership',
    ));
    expect(screen.queryByRole('button', { name: /رقم الفاتورة: 3726c3df/i })).not.toBeInTheDocument();
    expect(createReturnAction).not.toHaveBeenCalled();
  });
});

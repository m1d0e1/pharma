import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesReturnClient from '@/app/(dashboard)/returns/new/SalesReturnClient';
import {
  createReturnAction,
  getInvoiceForReturnAction,
  getSalesInvoicesByDateAction,
  searchRecentReturnInvoicesAction,
} from '@/app/actions-client/returns';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/app/actions-client/returns', () => ({
  createReturnAction: jest.fn(),
  getInvoiceForReturnAction: jest.fn(),
  getSalesInvoicesByDateAction: jest.fn(),
  searchRecentReturnInvoicesAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('rendered customer-return flow', () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: jest.fn(),
    });
  });

  beforeEach(() => {
    mockPush.mockReset();
    (getSalesInvoicesByDateAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'invoice-12345678',
        total_amount: 100,
        payment_method: 'credit',
        patient_name: 'Test Patient',
        user_name: 'Cashier',
        created_at: '2026-08-25T10:00:00.000Z',
      }],
    });
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'invoice-12345678',
        patient_id: 'patient-1',
        patient_name: 'Test Patient',
        user_name: 'Cashier',
        created_at: '2026-08-25T10:00:00.000Z',
        items: [{
          id: 'sale-item-1',
          inventory_id: 'batch-1',
          drug_name: 'Return Drug',
          quantity_sold: 3,
          returned_quantity: 1,
          unit_price: 10,
          unit: 'large',
          large_to_medium: 2,
          medium_to_small: 5,
        }],
      },
    });
    (createReturnAction as jest.Mock).mockResolvedValue({ success: true, data: { id: 'return-1' } });
  });

  it('searches the original invoice, clamps cumulative quantity, and posts its original batch', async () => {
    render(<SalesReturnClient />);
    fireEvent.change(screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...'), {
      target: { value: 'Return Drug' },
    });

    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
    const quantity = screen.getByRole('spinbutton');
    fireEvent.change(quantity, { target: { value: '99' } });
    expect(quantity).toHaveValue(2);
    fireEvent.change(screen.getByPlaceholderText('اختياري...'), { target: { value: 'Damaged pack' } });
    fireEvent.change(screen.getAllByRole('combobox').at(-1)!, { target: { value: 'patient_account' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith({
      invoice_id: 'invoice-12345678',
      refund_method: 'patient_account',
      reason: 'Damaged pack',
      patient_id: 'patient-1',
      items: [{
        sale_item_id: 'sale-item-1',
        inventory_id: 'batch-1',
        drug_name: 'Return Drug',
        quantity: 2,
        unit_price: 10,
        unit: 'large',
      }],
    }));
    expect(mockPush).toHaveBeenCalledWith('/returns');
  });

  it('scans barcode and presses Enter to select receipt and return item', async () => {
    render(<SalesReturnClient />);
    const searchInput = screen.getByPlaceholderText('امسح الباركود، أو اكتب اسم الدواء، أو رقم الفاتورة...');
    
    // Simulate barcode scan with Enter key
    fireEvent.change(searchInput, { target: { value: '6221000123456' } });
    fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(searchRecentReturnInvoicesAction).toHaveBeenCalledWith('6221000123456'));
    expect(await screen.findByText('Return Drug')).toBeInTheDocument();
  });
});

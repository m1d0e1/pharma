import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PatientProfileModal from '@/components/patients/PatientProfileModal';
import PurchaseReturnClient from '@/app/(dashboard)/purchases/returns/new/PurchaseReturnClient';
import { getPatientProfileAction, updatePatientAction } from '@/app/actions-client/patients';
import {
  createPurchaseReturnAction,
  getPurchaseInvoiceDetailsAction,
  getPurchasesReportsAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientProfileAction: jest.fn(),
  updatePatientAction: jest.fn(),
  addPatientAllergyAction: jest.fn(),
  addPatientConditionAction: jest.fn(),
  deletePatientAllergyAction: jest.fn(),
  getReceiptDetailsAction: jest.fn(),
  updatePatientWalletAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({ addPatientPaymentAction: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseReturnAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getPurchasesReportsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
}));
jest.mock('@/components/patients/CustomerStatementModal', () => () => null);
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/finance/FinancialComponents', () => ({
  CustomerStatementContent: () => null,
  FinancialNoticeForm: () => null,
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe("today's customer and purchase-return UI wiring", () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: jest.fn(),
    });
  });

  beforeEach(() => {
    mockPush.mockReset();
    (getPatientProfileAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        full_name: 'Test Patient',
        credit_limit: 350,
        payment_method: 'credit',
        allergies: [],
        conditions: [],
        payments: [],
        purchaseHistory: [],
      },
    });
    (updatePatientAction as jest.Mock).mockResolvedValue({ success: true });
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 7, name_ar: 'Test Supplier' }],
    });
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'invoice-1',
        invoice_number: 'INV-1',
        supplier_id: 7,
        status: 'completed',
        payment_method: 'credit',
        total_amount: 50,
      }],
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        {
          id: 11,
          inventory_id: 'inventory-alpha',
          drug_id: 101,
          trade_name: 'Alpha Drug',
          barcode: '111111',
          quantity: 5,
          remaining_large_quantity: 5,
          refundable_large_unit_price: 10,
          strips_per_box: 1,
          medium_to_small: 1,
        },
        {
          id: 22,
          inventory_id: 'inventory-beta',
          drug_id: 202,
          trade_name: 'Beta Drug',
          barcode: '222222',
          quantity: 3,
          remaining_large_quantity: 3,
          refundable_large_unit_price: 20,
          strips_per_box: 1,
          medium_to_small: 1,
        },
      ],
    });
    (createPurchaseReturnAction as jest.Mock).mockResolvedValue({ success: true, id: 'return-1' });
  });

  it('edits and saves a patient credit limit from the finance tab', async () => {
    const onSuccess = jest.fn();
    render(<PatientProfileModal patientId="patient-1" onClose={jest.fn()} onSuccess={onSuccess} />);

    fireEvent.click(await screen.findByRole('button', { name: 'المالية والتأمين' }));
    fireEvent.change(screen.getByDisplayValue('350'), { target: { value: '625.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ حد الائتمان والإعدادات' }));

    await waitFor(() => expect(updatePatientAction).toHaveBeenCalledWith(
      'patient-1',
      expect.objectContaining({ credit_limit: 625.5 }),
    ));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('searches a purchase return by barcode and submits the matching original invoice line', async () => {
    render(<PurchaseReturnClient />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } });
    const search = await screen.findByPlaceholderText('ابحث باسم الصنف أو امسح الباركود...');
    fireEvent.change(search, { target: { value: '222222' } });

    expect(screen.queryByText('Alpha Drug')).not.toBeInTheDocument();
    expect(screen.getByText('Beta Drug')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createPurchaseReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      purchase_invoice_id: 'invoice-1',
      supplier_id: 7,
      items: [expect.objectContaining({
        purchase_invoice_item_id: 22,
        inventory_id: 'inventory-beta',
        drug_id: 202,
        quantity: 2,
      })],
    })));
    expect(mockPush).toHaveBeenCalledWith('/purchases/returns');
  });
});

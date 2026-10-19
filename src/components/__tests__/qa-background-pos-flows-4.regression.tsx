import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SalesReturnClient from '@/app/(dashboard)/returns/new/SalesReturnClient';
import {
  createReturnAction,
  getInvoiceForReturnAction,
  getSalesInvoicesByDateAction,
  searchRecentReturnInvoicesAction,
} from '@/app/actions-client/returns';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/app/actions-client/returns', () => ({
  createReturnAction: jest.fn(),
  getInvoiceForReturnAction: jest.fn(),
  getSalesInvoicesByDateAction: jest.fn(),
  searchRecentReturnInvoicesAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const sameDrugLines = [
  {
    id: 'sale-line-lot-A', inventory_id: 'inventory-lot-A', drug_name: 'Same Drug Two Lots',
    quantity_sold: 2, returned_quantity: 0, unit_price: 48,
    unit: 'large', large_to_medium: 4, medium_to_small: 3,
    large_unit: 'علبة', medium_unit: 'شريط', small_unit: 'قرص',
  },
  {
    id: 'sale-line-lot-B', inventory_id: 'inventory-lot-B', drug_name: 'Same Drug Two Lots',
    quantity_sold: 8, returned_quantity: 2, unit_price: 12,
    unit: 'medium', large_to_medium: 4, medium_to_small: 3,
    large_unit: 'علبة', medium_unit: 'شريط', small_unit: 'قرص',
  },
];

const receipt = (id: string, paymentMethod = 'credit', patientId: string | null = 'patient-47', items: any[] = sameDrugLines) => ({
  id, patient_id: patientId, patient_name: patientId ? 'Synthetic Patient' : null,
  payment_method: paymentMethod, status: 'completed', created_at: '2026-09-21T13:00:00Z',
  total_amount: items.reduce((sum, item) => sum + item.quantity_sold * item.unit_price, 0),
  already_refunded: 0, discount_amount: 0, items,
});

async function searchReceipt(query = 'same drug') {
  fireEvent.change(screen.getByRole('textbox', { name: /البحث بالباركود أو اسم الصنف/ }), {
    target: { value: query },
  });
  await waitFor(() => expect(screen.getAllByRole('spinbutton', { name: 'كمية مرتجع Same Drug Two Lots' })).toHaveLength(2));
}

function returnRow(index: number): HTMLTableRowElement {
  const rows = screen.getAllByRole('spinbutton', { name: 'كمية مرتجع Same Drug Two Lots' });
  return rows[index].closest('tr')!;
}

describe('QA background: rendered sales-return lot selections, units and refund routing', () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true, value: jest.fn(),
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (getSalesInvoicesByDateAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 'sale-two-lots-47', total_amount: 192, payment_method: 'credit', created_at: '2026-09-21T13:00:00Z' }],
    });
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true, data: receipt('sale-two-lots-47'),
    });
    (createReturnAction as jest.Mock).mockResolvedValue({ success: true, totalRefund: 72 });
  });

  it('returns only the second source lot after converting its six remaining strips to eighteen pills', async () => {
    render(<SalesReturnClient />);
    await searchReceipt();

    expect(screen.getAllByRole('spinbutton', { name: 'كمية مرتجع Same Drug Two Lots' })).toHaveLength(2);
    const first = returnRow(0);
    const second = returnRow(1);
    expect(within(first).getByText('0 علبة')).toBeInTheDocument();
    expect(within(second).getByText('2 شريط')).toBeInTheDocument();

    fireEvent.change(within(second).getByRole('spinbutton'), { target: { value: '99' } });
    expect(within(second).getByRole('spinbutton')).toHaveValue(6);
    fireEvent.change(within(second).getByRole('combobox', { name: 'وحدة مرتجع Same Drug Two Lots' }), {
      target: { value: 'small' },
    });
    expect(within(second).getByRole('spinbutton')).toHaveValue(18);
    expect(within(first).getByRole('spinbutton')).toHaveValue(null);

    fireEvent.change(screen.getByRole('combobox', { name: 'طريقة الاسترداد *' }), { target: { value: 'bank' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'سبب المرتجع / ملاحظات' }), { target: { value: 'Damaged second lot' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith({
      request_id: expect.any(String), invoice_id: 'sale-two-lots-47', patient_id: 'patient-47',
      expected_total_refund: 72,
      refund_method: 'bank', reason: 'Damaged second lot',
      items: [{
        sale_item_id: 'sale-line-lot-B', inventory_id: 'inventory-lot-B', drug_name: 'Same Drug Two Lots',
        quantity: 18, unit_price: 4, unit: 'small',
      }],
    }));
    expect(createReturnAction).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/returns');
  });

  it('disables patient-credit/wallet for an unlinked cash receipt and retries its exact lot payload after a writer refusal', async () => {
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true, data: receipt('sale-two-lots-47', 'cash', null),
    });
    (createReturnAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic refund refusal' })
      .mockResolvedValueOnce({ success: true, totalRefund: 48 });
    render(<SalesReturnClient />);
    await searchReceipt();

    const methods = screen.getByRole('combobox', { name: 'طريقة الاسترداد *' });
    expect(methods).toHaveValue('cash');
    expect(within(methods).getByRole('option', { name: /خصم من مديونية مريض الفاتورة/ })).toBeDisabled();
    expect(within(methods).getByRole('option', { name: /إرجاع الرصيد إلى محفظة المريض/ })).toBeDisabled();
    expect(screen.getByText(/الفاتورة غير مرتبطة بمريض/)).toBeInTheDocument();
    fireEvent.change(within(returnRow(0)).getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل حفظ المرتجع: Synthetic refund refusal'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'تنفيذ المرتجع' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));
    await waitFor(() => expect(createReturnAction).toHaveBeenCalledTimes(2));
    const first = (createReturnAction as jest.Mock).mock.calls[0][0];
    const second = (createReturnAction as jest.Mock).mock.calls[1][0];
    expect(first).toEqual({
      request_id: expect.any(String), invoice_id: 'sale-two-lots-47', patient_id: undefined,
      expected_total_refund: 48,
      refund_method: 'cash', reason: '',
      items: [{
        sale_item_id: 'sale-line-lot-A', inventory_id: 'inventory-lot-A',
        drug_name: 'Same Drug Two Lots', quantity: 1, unit_price: 48, unit: 'large',
      }],
    });
    expect(second).toEqual(first);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('clamps an already-partly-returned pill sale across package units and posts only its remaining strip equivalent', async () => {
    const pill = {
      id: 'sale-pill-line-89', inventory_id: 'inventory-pill-lot-89', drug_name: 'Partial Pill Return',
      quantity_sold: 12, returned_quantity: 5, unit_price: 8,
      unit: 'small', large_to_medium: 3, medium_to_small: 4,
      large_unit: 'علبة', medium_unit: 'شريط', small_unit: 'قرص',
    };
    (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
      success: true, data: receipt('sale-two-lots-47', 'cash', null, [pill]),
    });
    render(<SalesReturnClient />);
    fireEvent.change(screen.getByRole('textbox', { name: /البحث بالباركود أو اسم الصنف/ }), {
      target: { value: 'pill partial' },
    });
    expect(await screen.findByText('Partial Pill Return')).toBeInTheDocument();
    const quantity = screen.getByRole('spinbutton', { name: 'كمية مرتجع Partial Pill Return' });
    const unit = screen.getByRole('combobox', { name: 'وحدة مرتجع Partial Pill Return' });
    expect(screen.getByRole('button', { name: 'تنفيذ المرتجع' })).toBeDisabled();
    fireEvent.change(quantity, { target: { value: '-4' } });
    expect(quantity).toHaveValue(null);
    expect(createReturnAction).not.toHaveBeenCalled();

    fireEvent.change(unit, { target: { value: 'large' } });
    fireEvent.change(quantity, { target: { value: '3' } });
    expect((quantity as HTMLInputElement).valueAsNumber).toBeCloseTo(7 / 12, 12);
    fireEvent.change(unit, { target: { value: 'medium' } });
    expect((quantity as HTMLInputElement).valueAsNumber).toBeCloseTo(1.75, 12);
    fireEvent.change(quantity, { target: { value: '1.5' } });
    expect(screen.getAllByText('48.00 ج.م').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith({
      request_id: expect.any(String), invoice_id: 'sale-two-lots-47', patient_id: undefined,
      expected_total_refund: 48,
      refund_method: 'cash', reason: '',
      items: [{ sale_item_id: 'sale-pill-line-89', inventory_id: 'inventory-pill-lot-89',
        drug_name: 'Partial Pill Return', quantity: 1.5, unit_price: 32, unit: 'medium' }],
    }));
  });

  it('uses the clicked date-list receipt with its own patient-credit default and lot source', async () => {
    const first = receipt('dated-cash-11', 'cash', null, [sameDrugLines[0]]);
    const second = receipt('dated-credit-22', 'credit', 'dated-patient-22', [sameDrugLines[1]]);
    (getSalesInvoicesByDateAction as jest.Mock).mockResolvedValue({ success: true, data: [first, second] });
    (getInvoiceForReturnAction as jest.Mock).mockImplementation(async (id: string) => ({
      success: true, data: id === first.id ? first : second,
    }));
    render(<SalesReturnClient />);
    expect(await screen.findByText('رقم الفاتورة: dated-ca')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /رقم الفاتورة: dated-cr/ }));
    await waitFor(() => expect(getInvoiceForReturnAction).toHaveBeenCalledWith('dated-credit-22'));
    expect(await screen.findByRole('combobox', { name: 'طريقة الاسترداد *' })).toHaveValue('patient_account');
    const row = screen.getByRole('spinbutton', { name: 'كمية مرتجع Same Drug Two Lots' }).closest('tr')!;
    expect(within(row).getByRole('combobox', { name: 'وحدة مرتجع Same Drug Two Lots' })).toHaveValue('medium');
    fireEvent.change(within(row).getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ المرتجع' }));

    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith({
      request_id: expect.any(String), invoice_id: 'dated-credit-22', patient_id: 'dated-patient-22',
      expected_total_refund: 24,
      refund_method: 'patient_account', reason: '',
      items: [{ sale_item_id: 'sale-line-lot-B', inventory_id: 'inventory-lot-B',
        drug_name: 'Same Drug Two Lots', quantity: 2, unit_price: 12, unit: 'medium' }],
    }));
  });
});

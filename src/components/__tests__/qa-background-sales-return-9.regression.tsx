import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

const listed = (id: string, payment_method = 'cash') => ({
  id, total_amount: 90, payment_method, created_at: '2026-10-14T10:00:00Z',
  user_name: 'Synthetic Cashier',
});
const detail = (id: string, patient_id?: string) => ({
  id, total_amount: 90, discount_amount: 10, payment_method: patient_id ? 'credit' : 'cash',
  patient_id, user_name: 'Synthetic Cashier', created_at: '2026-10-14T10:00:00Z',
  items: [{
    id: 'sale-item-' + id, inventory_id: 41, drug_name: 'Lot Alpha',
    quantity_sold: 2, returned_quantity: 0, unit: 'large',
    unit_price: 50, large_unit: 'box', medium_unit: 'strip', small_unit: 'pill',
    large_to_medium: 5, medium_to_small: 10,
  }],
});

const quantity = () => screen.getByRole('spinbutton', { name: 'كمية مرتجع Lot Alpha' });
const unit = () => screen.getByRole('combobox', { name: 'وحدة مرتجع Lot Alpha' });
const commit = () => screen.getByRole('button', { name: 'تنفيذ المرتجع' });

describe('QA background: sales returns actual rendered invoice/refund controls (mocked native writer)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true, value: jest.fn(),
    });
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true, value: jest.fn().mockReturnValue('qa-only-return-nonce'),
    });
    (getSalesInvoicesByDateAction as jest.Mock).mockResolvedValue({
      success: true, data: [listed('INV-RET-A')],
    });
    (searchRecentReturnInvoicesAction as jest.Mock).mockResolvedValue({
      success: true, data: [listed('INV-RET-B', 'credit')],
    });
    (getInvoiceForReturnAction as jest.Mock).mockImplementation(async (id: string) => ({
      success: true, data: detail(id, id === 'INV-RET-B' ? 'PATIENT-QA' : undefined),
    }));
    (createReturnAction as jest.Mock).mockResolvedValue({ success: true, totalRefund: 90 });
  });

  it('clamps over-return quantity and preserves exact stock units, discounted refund and chosen bank destination', async () => {
    render(<SalesReturnClient />);
    expect(screen.queryByRole('button', { name: 'تنفيذ المرتجع' })).not.toBeInTheDocument();
    await screen.findByRole('spinbutton', { name: 'كمية مرتجع Lot Alpha' });
    expect(commit()).toBeDisabled();
    fireEvent.change(quantity(), { target: { value: '999' } });
    expect(quantity()).toHaveValue(2);
    fireEvent.change(unit(), { target: { value: 'medium' } });
    expect(quantity()).toHaveValue(10);
    expect(within(screen.getByRole('row', { name: /Lot Alpha/ })).getByText('10.00 ج.م')).toBeInTheDocument();
    expect(screen.getByText('90.00 ج.م', { selector: 'span.text-3xl' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('طريقة الاسترداد *'), { target: { value: 'bank' } });
    fireEvent.change(screen.getByLabelText('سبب المرتجع / ملاحظات'), {
      target: { value: 'QA synthetic damaged pack' },
    });
    fireEvent.click(commit());
    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith({
      request_id: 'qa-only-return-nonce', invoice_id: 'INV-RET-A',
      expected_total_refund: 90,
      refund_method: 'bank', reason: 'QA synthetic damaged pack',
      patient_id: undefined,
      items: [{
        sale_item_id: 'sale-item-INV-RET-A', inventory_id: 41,
        drug_name: 'Lot Alpha', quantity: 10, unit_price: 10, unit: 'medium',
      }],
    }));
    expect(createReturnAction).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/returns');
  });

  it('rejects zero return, preserves the one request nonce on denied writer retry, and prevents duplicate commit', async () => {
    (createReturnAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic owner denied' })
      .mockResolvedValueOnce({ success: true, totalRefund: 45 });
    render(<SalesReturnClient />);
    await screen.findByRole('spinbutton', { name: 'كمية مرتجع Lot Alpha' });
    expect(commit()).toBeDisabled();
    expect(createReturnAction).not.toHaveBeenCalled();
    fireEvent.change(quantity(), { target: { value: '-3' } });
    expect(quantity()).toHaveValue(null);
    expect(commit()).toBeDisabled();
    fireEvent.change(quantity(), { target: { value: '1' } });
    fireEvent.click(commit());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل حفظ المرتجع: Synthetic owner denied'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(quantity()).toHaveValue(1);
    fireEvent.click(commit());
    await waitFor(() => expect(createReturnAction).toHaveBeenCalledTimes(2));
    expect((createReturnAction as jest.Mock).mock.calls[0]).toEqual(
      (createReturnAction as jest.Mock).mock.calls[1],
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'تم حفظ المرتجع' })).toBeDisabled());
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('invalidates an earlier prepared invoice when searching and restricts patient-only refunds by invoice owner', async () => {
    render(<SalesReturnClient />);
    await screen.findByRole('spinbutton', { name: 'كمية مرتجع Lot Alpha' });
    fireEvent.change(quantity(), { target: { value: '1' } });
    expect(commit()).toBeEnabled();
    const refund = screen.getByLabelText('طريقة الاسترداد *');
    expect(within(refund).getByRole('option', { name: /مديونية مريض/ })).toBeDisabled();
    expect(within(refund).getByRole('option', { name: /محفظة المريض/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/البحث بالباركود أو اسم الصنف/), {
      target: { value: 'PATIENT-QA' },
    });
    await waitFor(() => expect(searchRecentReturnInvoicesAction).toHaveBeenCalledWith('PATIENT-QA'));
    await waitFor(() => expect(getInvoiceForReturnAction).toHaveBeenCalledWith('INV-RET-B'));
    await waitFor(() => expect(screen.getByLabelText('طريقة الاسترداد *')).toHaveValue('patient_account'));
    expect(commit()).toBeDisabled();
    expect(within(screen.getByLabelText('طريقة الاسترداد *'))
      .getByRole('option', { name: /مديونية مريض/ })).toBeEnabled();
    fireEvent.change(quantity(), { target: { value: '1' } });
    fireEvent.click(commit());
    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 'INV-RET-B', patient_id: 'PATIENT-QA', refund_method: 'patient_account',
      items: [expect.objectContaining({ sale_item_id: 'sale-item-INV-RET-B' })],
    })));
    expect(createReturnAction).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale earlier invoice-detail response after the operator selects a newer search result', async () => {
    let settleOld!: (value: unknown) => void;
    (getInvoiceForReturnAction as jest.Mock).mockImplementation((id: string) =>
      id === 'INV-RET-A'
        ? new Promise(resolve => { settleOld = resolve; })
        : Promise.resolve({ success: true, data: detail('INV-RET-B', 'PATIENT-QA') }));
    render(<SalesReturnClient />);
    await waitFor(() => expect(getInvoiceForReturnAction).toHaveBeenCalledWith('INV-RET-A'));
    fireEvent.change(screen.getByLabelText(/البحث بالباركود أو اسم الصنف/), {
      target: { value: 'NEW-INVOICE' },
    });
    await waitFor(() => expect(getInvoiceForReturnAction).toHaveBeenCalledWith('INV-RET-B'));
    await waitFor(() => expect(screen.getByLabelText('طريقة الاسترداد *')).toHaveValue('patient_account'));
    await act(async () => {
      settleOld({ success: true, data: detail('INV-RET-A') });
    });
    expect(screen.getByLabelText('طريقة الاسترداد *')).toHaveValue('patient_account');
    expect(commit()).toBeDisabled();
    fireEvent.change(quantity(), { target: { value: '1' } });
    fireEvent.click(commit());
    await waitFor(() => expect(createReturnAction).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 'INV-RET-B', patient_id: 'PATIENT-QA',
      items: [expect.objectContaining({ sale_item_id: 'sale-item-INV-RET-B' })],
    })));
    expect(createReturnAction).toHaveBeenCalledTimes(1);
  });
});

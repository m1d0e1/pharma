import { fireEvent, render, screen } from '@testing-library/react';
import CogsAdjustmentClient from '@/components/sales/CogsAdjustmentClient';
import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';
import toast from 'react-hot-toast';

jest.mock('@/app/actions-client/cogs', () => ({
  getSoldItemsForCogsAdjustmentAction: jest.fn(),
  updateSoldItemCostAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
}));

const soldItem = {
  id: 11, trade_name: 'COGS Drug', invoice_id: 'invoice-12345678',
  invoice_date: '2026-09-20T10:00:00', unit_price: 100, current_inv_cost: 40,
};

const assertNoSourceOrPostingAccess = () => {
  expect(getSoldItemsForCogsAdjustmentAction).not.toHaveBeenCalled();
  expect(updateSoldItemCostAction).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText('لم يتم العثور على نتائج للبحث...')).not.toBeInTheDocument();
};

describe('COGS screen: previously active browser paths stay fail-closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Even if the test mock promises a candidate, the UI must never request
    // or treat one as sourced. No DB or journal behavior is simulated here.
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockResolvedValue({
      success: true, data: [soldItem],
    });
    (updateSoldItemCostAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('blocks Enter and Search instead of displaying items or invented empty results', () => {
    render(<CogsAdjustmentClient />);
    const search = screen.getByRole('textbox', { name: 'بحث باسم الصنف أو رقم الفاتورة' });
    const button = screen.getByRole('button', { name: 'بحث' });
    expect(search).toBeDisabled();
    expect(button).toBeDisabled();
    fireEvent.change(search, { target: { value: 'COGS Drug' } });
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' });
    fireEvent.click(button);
    expect(screen.queryByText('COGS Drug')).not.toBeInTheDocument();
    assertNoSourceOrPostingAccess();
  });

  it('never surfaces a false successful update even with a forged successful posting reply', () => {
    render(<CogsAdjustmentClient />);
    const cost = screen.getByRole('spinbutton', { name: 'التكلفة الجديدة' });
    const save = screen.getByRole('button', { name: 'حفظ التكلفة' });
    expect(cost).toBeDisabled();
    expect(save).toBeDisabled();
    fireEvent.change(cost, { target: { value: '55' } });
    fireEvent.click(save);
    assertNoSourceOrPostingAccess();
  });

  it('does not call a denied or rejecting search, nor imply there are no sales', () => {
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockRejectedValue(new Error('private invoice data'));
    render(<CogsAdjustmentClient />);
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/لا يعني تعطيل البحث عدم وجود مبيعات/);
    assertNoSourceOrPostingAccess();
  });

  it('cannot render an older search response over a newer one when neither request is allowed', () => {
    const lateOld = new Promise(() => {});
    const lateNew = new Promise(() => {});
    (getSoldItemsForCogsAdjustmentAction as jest.Mock)
      .mockReturnValueOnce(lateOld).mockReturnValueOnce(lateNew);
    const { rerender } = render(<CogsAdjustmentClient />);
    const search = screen.getByRole('textbox', { name: 'بحث باسم الصنف أو رقم الفاتورة' });
    fireEvent.change(search, { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    rerender(<CogsAdjustmentClient />);
    fireEvent.change(search, { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    expect(screen.queryByText('Older Result')).not.toBeInTheDocument();
    expect(screen.queryByText('Newer Result')).not.toBeInTheDocument();
    assertNoSourceOrPostingAccess();
  });

  it('never double-submits while the mock journal action is pending', () => {
    (updateSoldItemCostAction as jest.Mock).mockImplementation(() => new Promise(() => {}));
    render(<CogsAdjustmentClient />);
    const save = screen.getByRole('button', { name: 'حفظ التكلفة' });
    fireEvent.click(save);
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assertNoSourceOrPostingAccess();
  });

  it('never enters the throwing update path or creates a misleading retry flow', () => {
    (updateSoldItemCostAction as jest.Mock).mockRejectedValue(new Error('private network error'));
    render(<CogsAdjustmentClient />);
    const cost = screen.getByRole('spinbutton', { name: 'التكلفة الجديدة' });
    fireEvent.change(cost, { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التكلفة' }));
    expect(cost).toBeDisabled();
    assertNoSourceOrPostingAccess();
  });

  it('cannot display a stale post-update refresh as a newer search result', () => {
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ ...soldItem, id: 31, trade_name: 'Stale Post-Update Result' }],
    });
    const { rerender } = render(<CogsAdjustmentClient />);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التكلفة' }));
    rerender(<CogsAdjustmentClient />);
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    expect(screen.queryByText('Stale Post-Update Result')).not.toBeInTheDocument();
    assertNoSourceOrPostingAccess();
  });
});

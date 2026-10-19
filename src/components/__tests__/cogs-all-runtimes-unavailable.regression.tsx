import { fireEvent, render, screen } from '@testing-library/react';
import CogsAdjustmentClient from '@/components/sales/CogsAdjustmentClient';
import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';
import toast from 'react-hot-toast';

let mockTauri = false;
jest.mock('@/lib/env', () => ({ get isTauri() { return mockTauri; } }));
jest.mock('@/app/actions-client/cogs', () => ({
  getSoldItemsForCogsAdjustmentAction: jest.fn(),
  updateSoldItemCostAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
}));

describe.each([
  ['browser legacy', false],
  ['strict native', true],
])('post-sale COGS screen denied in %s mode', (_label, native) => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTauri = native;
    // A stale/forged success response must never be presented by this screen.
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 77, trade_name: 'NOT A PROVEN SALE', current_inv_cost: 20 }],
    });
    (updateSoldItemCostAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('announces missing immutable evidence instead of pretending no sales exist', () => {
    render(<CogsAdjustmentClient />);
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent(/غير متاح/);
    expect(notice).toHaveTextContent(/قيد مستقل/);
    expect(notice).toHaveTextContent(/لا يجوز إعادة كتابة تكلفة سطر بيع أو مرتجع/);
    expect(notice).toHaveTextContent(/مصدر|توثيق|موثق/);
    expect(notice).toHaveTextContent(/المرتجعات/);
    expect(notice).toHaveTextContent(/لا يعني تعطيل البحث عدم وجود مبيعات/);
    expect(screen.queryByText('لم يتم العثور على نتائج للبحث...')).not.toBeInTheDocument();
    expect(screen.queryByText('NOT A PROVEN SALE')).not.toBeInTheDocument();
  });

  it('keeps search, cost entry, and Save disabled with accessible denial descriptions', () => {
    render(<CogsAdjustmentClient />);
    const search = screen.getByRole('textbox', { name: 'بحث باسم الصنف أو رقم الفاتورة' });
    const searchButton = screen.getByRole('button', { name: 'بحث' });
    const proposedCost = screen.getByRole('spinbutton', { name: 'التكلفة الجديدة' });
    const save = screen.getByRole('button', { name: 'حفظ التكلفة' });
    for (const control of [search, searchButton, proposedCost, save]) {
      expect(control).toBeDisabled();
      expect(control).toHaveAccessibleDescription(/غير متاح/);
    }
    fireEvent.change(search, { target: { value: 'NOT A PROVEN SALE' } });
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' });
    fireEvent.click(searchButton);
    fireEvent.change(proposedCost, { target: { value: '120.25' } });
    fireEvent.click(save);
    expect(getSoldItemsForCogsAdjustmentAction).not.toHaveBeenCalled();
    expect(updateSoldItemCostAction).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('does not contact search or mutation APIs on mount or rerender', () => {
    const { rerender } = render(<CogsAdjustmentClient />);
    rerender(<CogsAdjustmentClient />);
    expect(getSoldItemsForCogsAdjustmentAction).not.toHaveBeenCalled();
    expect(updateSoldItemCostAction).not.toHaveBeenCalled();
  });
});

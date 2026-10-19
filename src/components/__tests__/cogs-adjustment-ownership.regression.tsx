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
  default: { success: jest.fn(), error: jest.fn() },
}));

describe('post-sale COGS correction ownership and duplicate-submit boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not submit once, let alone twice, for same-tick forged Save clicks', () => {
    // UI role display cannot authorize a cost correction. A fake positive
    // response or pending posting promise must never become accessible here.
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ id: 11, trade_name: 'صنف مباع' }],
    });
    (updateSoldItemCostAction as jest.Mock).mockImplementation(() => new Promise(() => {}));

    render(<CogsAdjustmentClient />);
    const save = screen.getByRole('button', { name: 'حفظ التكلفة' });
    expect(save).toBeDisabled();
    const cost = screen.getByRole('spinbutton', { name: 'التكلفة الجديدة' });
    expect(cost).toBeDisabled();
    fireEvent.change(cost, { target: { value: '65' } });
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(getSoldItemsForCogsAdjustmentAction).not.toHaveBeenCalled();
    expect(updateSoldItemCostAction).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByText('صنف مباع')).not.toBeInTheDocument();
  });
});

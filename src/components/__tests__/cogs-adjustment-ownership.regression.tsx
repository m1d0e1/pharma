import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CogsAdjustmentClient from '@/components/sales/CogsAdjustmentClient';
import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';

jest.mock('@/app/actions-client/cogs', () => ({
  getSoldItemsForCogsAdjustmentAction: jest.fn(),
  updateSoldItemCostAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

describe('COGS adjustment ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 11,
        trade_name: 'صنف مباع',
        invoice_id: 'invoice-12345678',
        invoice_date: '2026-09-20T08:00:00.000Z',
        unit_price: 100,
        current_inv_cost: 60,
      }],
    });
  });

  it('submits one cost update for same-tick repeated save clicks', async () => {
    let resolveUpdate!: (value: { success: boolean; error?: string }) => void;
    const pending = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveUpdate = resolve;
    });
    (updateSoldItemCostAction as jest.Mock).mockImplementation(() => pending);

    render(<CogsAdjustmentClient />);

    fireEvent.change(screen.getByPlaceholderText('ابحث باسم الصنف أو رقم الفاتورة...'), {
      target: { value: 'صنف' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    expect(await screen.findByText('صنف مباع')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '65' } });
    const saveButton = screen.getAllByRole('button').find(button => button.textContent === '')!;

    act(() => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => expect(updateSoldItemCostAction).toHaveBeenCalled());
    const callsWhilePending = (updateSoldItemCostAction as jest.Mock).mock.calls.length;

    await act(async () => {
      resolveUpdate({ success: false, error: 'update failed' });
      await pending;
    });

    expect(callsWhilePending).toBe(1);
  });
});

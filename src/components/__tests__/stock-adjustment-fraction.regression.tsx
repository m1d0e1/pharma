import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdjustmentsClient from '@/app/(dashboard)/stores/adjustments/AdjustmentsClient';
import { createStockAdjustmentAction } from '@/app/actions-client/master-drugs';
import { dbSelect } from '@/lib/db/tauri';

jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'admin', role: 'owner', pharmacy_id: 'local_default' }),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({ createStockAdjustmentAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

describe('stock adjustment fractional quantities', () => {
  it('preserves a fractional quantity from the UI through the adjustment action', async () => {
    (dbSelect as jest.Mock).mockResolvedValue([
      { id: 'inv-1', quantity: 2, trade_name: 'Panadol', trade_name_en: 'Panadol', barcode: '123' },
    ]);
    (createStockAdjustmentAction as jest.Mock).mockResolvedValue({ success: true });

    render(<AdjustmentsClient reasons={[{ id: 1, name_ar: 'جرد' }]} />);

    fireEvent.change(screen.getByPlaceholderText('إسم الصنف أو الباركود...'), { target: { value: 'Pana' } });
    fireEvent.click(await screen.findByRole('button', { name: /Panadol/ }));

    const quantityInput = screen.getByRole('spinbutton');
    expect(quantityInput).toHaveAttribute('step', 'any');
    fireEvent.change(quantityInput, { target: { value: '1.5' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));

    await waitFor(() => expect(createStockAdjustmentAction).toHaveBeenCalledWith('inv-1', {
      reason_id: 1,
      old_quantity: 2,
      new_quantity: 1.5,
    }));
  });
});

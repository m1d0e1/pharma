import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdjustmentsClient from '@/app/(dashboard)/stores/adjustments/AdjustmentsClient';
import { createStockAdjustmentAction } from '@/app/actions-client/master-drugs';
import { dbSelect } from '@/lib/db/tauri';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({ createStockAdjustmentAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const inventoryRow = {
  id: 'inventory-1',
  drug_id: 5,
  quantity: 8,
  trade_name: 'دواء الجرد',
  trade_name_en: 'Adjustment Drug',
  barcode: '123456',
};

describe('stock-adjustment client interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'manager', pharmacy_id: 'ph-2' });
    (dbSelect as jest.Mock).mockResolvedValue([inventoryRow]);
  });

  it('waits for a meaningful query, scopes search to the current pharmacy, validates reason, and preserves selection after action failure', async () => {
    (createStockAdjustmentAction as jest.Mock).mockResolvedValue({ success: false, error: 'تم تغيير الرصيد؛ حدّث الشاشة وحاول مرة أخرى' });
    render(<AdjustmentsClient reasons={[{ id: 9, name_ar: 'جرد فعلي' }]} />);

    const search = screen.getByPlaceholderText('إسم الصنف أو الباركود...');
    fireEvent.change(search, { target: { value: 'Ad' } });
    expect(dbSelect).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'Adju' } });
    expect(await screen.findByRole('button', { name: /Adjustment Drug/ })).toBeInTheDocument();
    expect(dbSelect).toHaveBeenCalledWith(
      expect.stringContaining("i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default')"),
      ['%Adju%', '%Adju%', '%Adju%', 'ph-2', 'ph-2'],
    );

    fireEvent.click(screen.getByRole('button', { name: /Adjustment Drug/ }));
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));
    expect(createStockAdjustmentAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يرجى اختيار الصنف وسبب التسوية');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '9' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));

    await waitFor(() => expect(createStockAdjustmentAction).toHaveBeenCalledWith('inventory-1', {
      reason_id: 9,
      old_quantity: 8,
      new_quantity: 6,
    }));
    expect(toast.error).toHaveBeenCalledWith('تم تغيير الرصيد؛ حدّث الشاشة وحاول مرة أخرى');
    expect(screen.getByText('الرصيد الحالي: 8')).toBeInTheDocument();
  });

  it('clears the selected item after a successful adjustment', async () => {
    (createStockAdjustmentAction as jest.Mock).mockResolvedValue({ success: true });
    render(<AdjustmentsClient reasons={[{ id: 1, name_ar: 'جرد' }]} />);

    fireEvent.change(screen.getByPlaceholderText('إسم الصنف أو الباركود...'), { target: { value: 'Adju' } });
    fireEvent.click(await screen.findByRole('button', { name: /Adjustment Drug/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'تنفيذ التسوية' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تمت تسوية الكمية بنجاح'));
    expect(screen.queryByText('الرصيد الحالي: 8')).not.toBeInTheDocument();
  });

  it('surfaces inventory-search failure and clears stale suggestions', async () => {
    (dbSelect as jest.Mock)
      .mockResolvedValueOnce([inventoryRow])
      .mockRejectedValueOnce(new Error('db unavailable'));
    render(<AdjustmentsClient reasons={[{ id: 1, name_ar: 'جرد' }]} />);

    const search = screen.getByPlaceholderText('إسم الصنف أو الباركود...');
    fireEvent.change(search, { target: { value: 'Adju' } });
    expect(await screen.findByRole('button', { name: /Adjustment Drug/ })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'Other' } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل البحث في المخزون'));
    expect(screen.queryByRole('button', { name: /Adjustment Drug/ })).not.toBeInTheDocument();
  });

  it('does not let an older inventory search overwrite a newer query result', async () => {
    let resolveOld: (value: any[]) => void = () => {};
    let resolveNew: (value: any[]) => void = () => {};
    (dbSelect as jest.Mock).mockImplementation((_sql: string, params: any[]) => new Promise(resolve => {
      if (params[0] === '%Old%') resolveOld = resolve;
      else if (params[0] === '%New%') resolveNew = resolve;
    }));
    render(<AdjustmentsClient reasons={[{ id: 1, name_ar: 'جرد' }]} />);

    const search = screen.getByPlaceholderText('إسم الصنف أو الباركود...');
    fireEvent.change(search, { target: { value: 'Old' } });
    fireEvent.change(search, { target: { value: 'New' } });

    await waitFor(() => expect(dbSelect).toHaveBeenCalledTimes(2));

    await act(async () => resolveNew([{ ...inventoryRow, id: 'new-row', trade_name_en: 'Newest Adjustment Drug' }]));
    expect(await screen.findByRole('button', { name: /Newest Adjustment Drug/ })).toBeInTheDocument();

    await act(async () => resolveOld([{ ...inventoryRow, id: 'old-row', trade_name_en: 'Stale Adjustment Drug' }]));
    expect(screen.getByRole('button', { name: /Newest Adjustment Drug/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stale Adjustment Drug/ })).not.toBeInTheDocument();
  });

  it('blocks repeated adjustment writes while the first submission is pending', async () => {
    let resolveAdjustment: (value: { success: boolean; error?: string }) => void = () => {};
    (createStockAdjustmentAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveAdjustment = resolve; }));
    render(<AdjustmentsClient reasons={[{ id: 9, name_ar: 'جرد فعلي' }]} />);

    fireEvent.change(screen.getByPlaceholderText('إسم الصنف أو الباركود...'), { target: { value: 'Adju' } });
    fireEvent.click(await screen.findByRole('button', { name: /Adjustment Drug/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '9' } });
    const submit = screen.getByRole('button', { name: 'تنفيذ التسوية' });

    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });

    expect(createStockAdjustmentAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveAdjustment({ success: false, error: 'adjustment rejected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'تنفيذ التسوية' })).toBeEnabled());
  });
});

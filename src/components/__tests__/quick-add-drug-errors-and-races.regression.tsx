import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuickAddDrugModal from '@/components/master-drugs/QuickAddDrugModal';
import { addMasterDrugAction, getUnitsAction } from '@/app/actions-client/master-drugs';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/master-drugs', () => ({
  addMasterDrugAction: jest.fn(),
  getUnitsAction: jest.fn(),
}));

jest.mock('@/app/actions-client/drug-replacement', () => ({
  findDrugBarcodeConflict: jest.fn().mockResolvedValue(null),
  getReplacementDrug: jest.fn(),
}));

jest.mock('@/components/master-drugs/DrugReplacementDialog', () => () => null);
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

function fillRequiredQuickAddFields() {
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), { target: { value: 'دواء اختبار' } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '40' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '2' } });
}

describe('QuickAddDrugModal async/error behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getUnitsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (addMasterDrugAction as jest.Mock).mockReset();
  });

  it('blocks repeated quick-add submissions while the first write is pending', async () => {
    let resolveAdd!: (value: { success: boolean; error?: string }) => void;
    (addMasterDrugAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveAdd = resolve; }));

    render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={jest.fn()} />);
    fillRequiredQuickAddFields();
    const form = screen.getByRole('button', { name: 'حفظ الصنف' }).closest('form') as HTMLFormElement;

    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(addMasterDrugAction).toHaveBeenCalledTimes(1);

    await act(async () => resolveAdd({ success: false, error: 'write rejected' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('write rejected'));
  });

  it('recovers quick-add submission after a thrown write without losing the form', async () => {
    (addMasterDrugAction as jest.Mock)
      .mockRejectedValueOnce(new Error('quick-add transport'))
      .mockResolvedValueOnce({ success: true, id: 42 });
    const onClose = jest.fn();
    const onSuccess = jest.fn();

    render(<QuickAddDrugModal onClose={onClose} onSuccess={onSuccess} />);
    fillRequiredQuickAddFields();
    const form = screen.getByRole('button', { name: 'حفظ الصنف' }).closest('form') as HTMLFormElement;

    fireEvent.submit(form);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل إضافة الصنف'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'حفظ الصنف' })).toBeEnabled();
    expect(screen.getByDisplayValue('دواء اختبار')).toBeInTheDocument();

    fireEvent.submit(form);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(42, 'دواء اختبار', '', 40, 2, ''));
  });

  it('keeps quick-add usable when unit suggestions fail to load', async () => {
    (getUnitsAction as jest.Mock).mockRejectedValueOnce(new Error('units transport'));

    render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={jest.fn()} />);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر تحميل الوحدات'));
    expect(screen.getByPlaceholderText('اختر أو اكتب الوحدة')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'حفظ الصنف' })).toBeEnabled();
  });
});

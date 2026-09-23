import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddInventoryModal from '@/components/AddInventoryModal';
import EditInventoryModal from '@/components/EditInventoryModal';
import { addInventoryAction, updateInventoryAction } from '@/app/actions-client/inventory';
import { getAdjustmentReasonsAction, getUnitsAction, searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { toast } from 'react-hot-toast';
import { useHotkeys } from 'react-hotkeys-hook';

jest.mock('@/app/actions-client/inventory', () => ({
  addInventoryAction: jest.fn(),
  updateInventoryAction: jest.fn(),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  getUnitsAction: jest.fn(),
  searchMasterDrugsAction: jest.fn(),
  getAdjustmentReasonsAction: jest.fn(),
}));

jest.mock('@/components/master-drugs/QuickAddDrugModal', () => () => null);
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const drug = (id: number, name: string) => ({
  id,
  trade_name: name,
  trade_name_en: name,
  active_ingredient: 'Ingredient',
  official_price: 20,
  large_unit: 'علبة',
  large_to_medium: 2,
});

describe('inventory modal async/error behavior', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (getUnitsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [{ name_ar: 'علبة' }] });
    (searchMasterDrugsAction as jest.Mock).mockReset();
    (getAdjustmentReasonsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [{ id: 1, name_ar: 'جرد' }] });
    (addInventoryAction as jest.Mock).mockReset();
    (updateInventoryAction as jest.Mock).mockReset();
  });

  it('keeps the newest add-inventory search result when an older search resolves afterwards', async () => {
    jest.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    (searchMasterDrugsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));

    render(<AddInventoryModal pharmacyId="ph-1" onClose={jest.fn()} onSuccess={jest.fn()} />);
    const input = screen.getByPlaceholderText('ابحث باسم الدواء (مثلاً: Panadol)...');

    fireEvent.change(input, { target: { value: 'old' } });
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(searchMasterDrugsAction).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: 'new' } });
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(searchMasterDrugsAction).toHaveBeenCalledTimes(2);

    await act(async () => resolveNew({ success: true, data: [drug(2, 'Newest Drug')] }));
    expect(screen.getByText('Newest Drug')).toBeInTheDocument();

    await act(async () => resolveOld({ success: true, data: [drug(1, 'Stale Drug')] }));
    expect(screen.getByText('Newest Drug')).toBeInTheDocument();
    expect(screen.queryByText('Stale Drug')).not.toBeInTheDocument();
  });

  it('recovers add-inventory search after a thrown request instead of leaving the spinner stuck', async () => {
    jest.useFakeTimers();
    (searchMasterDrugsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('search transport'))
      .mockResolvedValueOnce({ success: true, data: [drug(3, 'Recovered Drug')] });

    render(<AddInventoryModal pharmacyId="ph-1" onClose={jest.fn()} onSuccess={jest.fn()} />);
    const input = screen.getByPlaceholderText('ابحث باسم الدواء (مثلاً: Panadol)...');
    fireEvent.change(input, { target: { value: 'broken' } });
    await act(async () => { jest.advanceTimersByTime(300); });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByText('جاري البحث في قاعدة البيانات...')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'recovered' } });
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(screen.getByText('Recovered Drug')).toBeInTheDocument();
  });

  it('blocks repeated add-inventory submissions while the first write is pending', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [drug(4, 'Add Drug')] });
    let resolveAdd!: (value: { success: boolean; error?: string }) => void;
    (addInventoryAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveAdd = resolve; }));

    render(<AddInventoryModal pharmacyId="ph-1" onClose={jest.fn()} onSuccess={jest.fn()} />);
    const input = screen.getByPlaceholderText('ابحث باسم الدواء (مثلاً: Panadol)...');
    fireEvent.change(input, { target: { value: 'Add Drug' } });
    await screen.findByText('Add Drug');
    fireEvent.click(screen.getByText('Add Drug'));

    fireEvent.change(screen.getByPlaceholderText('مثلاً: 20'), { target: { value: '5' } });
    fireEvent.change(screen.getByDisplayValue('20'), { target: { value: '21' } });
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2027-12-31' } });
    const submit = screen.getByRole('button', { name: /حفظ في المخزون/ });
    const form = submit.closest('form') as HTMLFormElement;

    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(addInventoryAction).toHaveBeenCalledTimes(1);

    await act(async () => resolveAdd({ success: false, error: 'write rejected' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('write rejected'));
  });

  it('keeps add-inventory close shortcuts blocked while the inventory write is pending', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [drug(41, 'Pending Add Drug')] });
    let resolveAdd!: (value: { success: boolean; error?: string }) => void;
    (addInventoryAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveAdd = resolve; }));
    const onClose = jest.fn();

    render(<AddInventoryModal pharmacyId="ph-1" onClose={onClose} onSuccess={jest.fn()} />);
    const input = screen.getByPlaceholderText('ابحث باسم الدواء (مثلاً: Panadol)...');
    fireEvent.change(input, { target: { value: 'Pending Add Drug' } });
    fireEvent.click(await screen.findByText('Pending Add Drug'));
    fireEvent.change(screen.getByPlaceholderText('مثلاً: 20'), { target: { value: '5' } });
    fireEvent.change(screen.getByDisplayValue('20'), { target: { value: '21' } });
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2027-12-31' } });
    fireEvent.submit(screen.getByRole('button', { name: /حفظ في المخزون/ }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(addInventoryAction).toHaveBeenCalledTimes(1));

    const headerClose = screen.getAllByRole('button').find(button => button.textContent === '×');
    expect(headerClose).toBeDefined();
    fireEvent.click(headerClose!);
    const escCall = [...(useHotkeys as jest.Mock).mock.calls].reverse().find(call => call[0] === 'esc');
    expect(escCall).toBeDefined();
    escCall?.[1]();

    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolveAdd({ success: false, error: 'keep open' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /حفظ في المخزون/ })).toBeEnabled());
  });

  it('recovers add-inventory submission after a thrown write without closing or losing edits', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [drug(5, 'Retry Add Drug')] });
    (addInventoryAction as jest.Mock)
      .mockRejectedValueOnce(new Error('write transport'))
      .mockResolvedValueOnce({ success: false, error: 'retry rejected' });
    const onClose = jest.fn();
    const onSuccess = jest.fn();

    render(<AddInventoryModal pharmacyId="ph-1" onClose={onClose} onSuccess={onSuccess} />);
    const input = screen.getByPlaceholderText('ابحث باسم الدواء (مثلاً: Panadol)...');
    fireEvent.change(input, { target: { value: 'Retry Add Drug' } });
    await screen.findByText('Retry Add Drug');
    fireEvent.click(screen.getByText('Retry Add Drug'));

    fireEvent.change(screen.getByPlaceholderText('مثلاً: 20'), { target: { value: '5' } });
    fireEvent.change(screen.getByDisplayValue('20'), { target: { value: '21' } });
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2027-12-31' } });
    const form = screen.getByRole('button', { name: /حفظ في المخزون/ }).closest('form') as HTMLFormElement;

    fireEvent.submit(form);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء الإضافة. يرجى المحاولة مرة أخرى.'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /حفظ في المخزون/ })).toBeEnabled();
    expect(screen.getByDisplayValue('21')).toBeInTheDocument();

    fireEvent.submit(form);
    await waitFor(() => expect(addInventoryAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('retry rejected'));
  });

  it('shows retryable adjustment-reason loading failure instead of an unusable empty required selector', async () => {
    (getAdjustmentReasonsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('reason transport'))
      .mockResolvedValueOnce({ success: true, data: [{ id: 7, name_ar: 'تالف' }] });

    render(<EditInventoryModal item={{
      id: 'lot-1', quantity: 10, local_selling_price: 20, expiry_date: '2027-12-31', strips_per_box: 2,
      master_drugs: { trade_name: 'Edit Drug', large_to_medium: 2 },
    }} onClose={jest.fn()} onSuccess={jest.fn()} />);

    fireEvent.change(screen.getByDisplayValue('10'), { target: { value: '11' } });
    expect(await screen.findByText('تعذر تحميل أسباب التعديل')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل الأسباب' }));
    expect(await screen.findByRole('option', { name: 'تالف' })).toBeInTheDocument();
  });

  it('blocks repeated edit-inventory submissions and preserves the modal after a rejected write', async () => {
    let resolveUpdate!: (value: { success: boolean; error?: string }) => void;
    (updateInventoryAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveUpdate = resolve; }));
    const onClose = jest.fn();
    const onSuccess = jest.fn();

    render(<EditInventoryModal item={{
      id: 'lot-2', quantity: 10, local_selling_price: 20, expiry_date: '2027-12-31', strips_per_box: 2,
      master_drugs: { trade_name: 'Edit Drug', large_to_medium: 2 },
    }} onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(screen.getByDisplayValue('20'), { target: { value: '22' } });
    const submit = screen.getByRole('button', { name: 'حفظ التغييرات' });
    const form = submit.closest('form') as HTMLFormElement;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(updateInventoryAction).toHaveBeenCalledTimes(1);

    await act(async () => resolveUpdate({ success: false, error: 'update rejected' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('update rejected'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'حفظ التغييرات' })).toBeEnabled();
    expect(screen.getByDisplayValue('22')).toBeInTheDocument();
  });

  it('keeps edit-inventory cancel shortcuts blocked while the update is pending', async () => {
    let resolveUpdate!: (value: { success: boolean; error?: string }) => void;
    (updateInventoryAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveUpdate = resolve; }));
    const onClose = jest.fn();

    render(<EditInventoryModal item={{
      id: 'lot-pending', quantity: 10, local_selling_price: 20, expiry_date: '2027-12-31', strips_per_box: 2,
      master_drugs: { trade_name: 'Pending Edit Drug', large_to_medium: 2 },
    }} onClose={onClose} onSuccess={jest.fn()} />);

    fireEvent.change(screen.getByDisplayValue('20'), { target: { value: '24' } });
    fireEvent.submit(screen.getByRole('button', { name: 'حفظ التغييرات' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(updateInventoryAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    const headerClose = screen.getAllByRole('button').find(button => button.textContent === '×');
    expect(headerClose).toBeDefined();
    fireEvent.click(headerClose!);
    const escCall = [...(useHotkeys as jest.Mock).mock.calls].reverse().find(call => call[0] === 'esc');
    expect(escCall).toBeDefined();
    escCall?.[1]();

    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolveUpdate({ success: false, error: 'keep open' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ التغييرات' })).toBeEnabled());
  });

  it('recovers edit-inventory submission after a thrown write without closing or losing edits', async () => {
    (updateInventoryAction as jest.Mock)
      .mockRejectedValueOnce(new Error('update transport'))
      .mockResolvedValueOnce({ success: false, error: 'retry update rejected' });
    const onClose = jest.fn();
    const onSuccess = jest.fn();

    render(<EditInventoryModal item={{
      id: 'lot-3', quantity: 10, local_selling_price: 20, expiry_date: '2027-12-31', strips_per_box: 2,
      master_drugs: { trade_name: 'Edit Drug', large_to_medium: 2 },
    }} onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(screen.getByDisplayValue('20'), { target: { value: '23' } });
    const form = screen.getByRole('button', { name: 'حفظ التغييرات' }).closest('form') as HTMLFormElement;
    fireEvent.submit(form);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء التحديث'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'حفظ التغييرات' })).toBeEnabled();
    expect(screen.getByDisplayValue('23')).toBeInTheDocument();

    fireEvent.submit(form);
    await waitFor(() => expect(updateInventoryAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('retry update rejected'));
  });
});

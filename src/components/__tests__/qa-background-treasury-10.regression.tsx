import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CashTransactionsClient from '@/components/finance/CashTransactionsClient';
import { createCashMovementAction, getCashMovementsAction } from '@/app/actions-client/finance';
import { addExpenseAction } from '@/app/actions-client/expenses';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';
import { toast } from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(), getCashMovementsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/expenses', () => ({ addExpenseAction: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({ getCurrentShiftAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const form = () => screen.getByRole('dialog', { name: 'صرف نقدية جديدة' });
const amount = () => screen.getByRole('spinbutton', { name: 'القيمة المالية' });
const save = () => screen.getByRole('button', { name: 'حفظ العملية' });

describe('QA background: treasury disbursement real-rendered controls with mocked writers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCashMovementsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({ success: true, data: null });
    (createCashMovementAction as jest.Mock).mockResolvedValue({ success: false, error: 'Native denied' });
    (addExpenseAction as jest.Mock).mockResolvedValue({ success: false, error: 'Expense denied' });
  });

  it('rejects nonfinite cash amounts before both native financial writers', async () => {
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'disbursement' }} />);
    expect(await screen.findByRole('dialog', { name: 'صرف نقدية جديدة' })).toBeInTheDocument();
    fireEvent.change(amount(), { target: { value: '1e309' } });
    fireEvent.click(save());
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال قيمة صحيحة');
    expect(createCashMovementAction).not.toHaveBeenCalled();
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('preserves expense category/shift identity and allows correcting a denied expense without cash movement', async () => {
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({ success: true,
      data: { id: 'qa-treasury-shift-A', status: 'open' } });
    (addExpenseAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Expense denied' })
      .mockResolvedValueOnce({ success: true, id: 'qa-expense-only' });
    render(<CashTransactionsClient />);
    await screen.findByText(/وردية نشطة #qa-treas/);
    fireEvent.click(screen.getByRole('button', { name: 'صرف نقدية' }));
    await screen.findByRole('dialog', { name: 'صرف نقدية جديدة' });
    expect(screen.getByLabelText('صرف من')).toHaveValue('pos');
    fireEvent.change(screen.getByLabelText('التصنيف الفرعي'), { target: { value: 'تراخيص' } });
    fireEvent.change(screen.getByLabelText('ملاحظات إضافية'), { target: { value: 'QA synthetic license expense' } });
    fireEvent.change(amount(), { target: { value: '15.25' } });
    fireEvent.click(save());
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledWith(expect.objectContaining({
      category: 'تراخيص', amount: 15.25, description: 'QA synthetic license expense',
      source_type: 'pos', shift_id: 'qa-treasury-shift-A',
    })));
    expect(toast.error).toHaveBeenCalledWith('Expense denied');
    expect(form()).toBeInTheDocument();
    expect(amount()).toHaveValue(15.25);
    fireEvent.change(amount(), { target: { value: '20.25' } });
    fireEvent.click(save());
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(2));
    expect((addExpenseAction as jest.Mock).mock.calls[1][0]).toEqual(
      expect.objectContaining({ amount: 20.25, source_type: 'pos', shift_id: 'qa-treasury-shift-A' }));
    const [firstIntent, updatedIntent] = (addExpenseAction as jest.Mock).mock.calls.map(([data]) => data);
    expect(firstIntent.request_id).toEqual(expect.any(String));
    expect(updatedIntent.request_id).toEqual(expect.any(String));
    expect(updatedIntent.request_id).not.toBe(firstIntent.request_id);
    expect(createCashMovementAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'صرف نقدية جديدة' })).not.toBeInTheDocument());
  });

  it('retries the unchanged operating cash expense with its original request ID after an uncertain writer failure', async () => {
    (addExpenseAction as jest.Mock).mockResolvedValue({ success: false, error: 'Native reply unavailable' });
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'disbursement' }} />);
    await screen.findByRole('dialog', { name: 'صرف نقدية جديدة' });
    fireEvent.change(amount(), { target: { value: '21.75' } });
    fireEvent.click(save());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Native reply unavailable'));
    fireEvent.click(save());
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(2));
    const [first, retry] = (addExpenseAction as jest.Mock).mock.calls.map(([data]) => data);
    expect(first.request_id).toEqual(expect.any(String));
    expect(first).toEqual(retry);
    expect(createCashMovementAction).not.toHaveBeenCalled();
  });

  it('reuses a failed cash-movement ID and creates a new ID only after its business intent changes', async () => {
    (createCashMovementAction as jest.Mock).mockResolvedValue({ success: false, error: 'Native reply unavailable' });
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'disbursement' }} />);
    await screen.findByRole('dialog', { name: 'صرف نقدية جديدة' });
    fireEvent.change(screen.getByLabelText('صرف إلى النوع'), { target: { value: 'personal' } });
    fireEvent.change(amount(), { target: { value: '21.75' } });
    fireEvent.click(save());
    await waitFor(() => expect(createCashMovementAction).toHaveBeenCalledTimes(1));
    fireEvent.click(save());
    await waitFor(() => expect(createCashMovementAction).toHaveBeenCalledTimes(2));
    const [first, retry] = (createCashMovementAction as jest.Mock).mock.calls.map(([data]) => data);
    expect(retry.request_id).toBe(first.request_id);

    fireEvent.change(amount(), { target: { value: '22.75' } });
    fireEvent.click(save());
    await waitFor(() => expect(createCashMovementAction).toHaveBeenCalledTimes(3));
    expect((createCashMovementAction as jest.Mock).mock.calls[2][0].request_id)
      .not.toBe(first.request_id);
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('does not attribute a preopened cash form to the safe after a native shift finishes loading', async () => {
    let resolveShift!: (result: unknown) => void;
    (getCurrentShiftAction as jest.Mock).mockImplementation(() =>
      new Promise(resolve => { resolveShift = resolve; }));
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'disbursement' }} />);
    await waitFor(() => expect(getCurrentShiftAction).toHaveBeenCalledTimes(1));
    // Never mount a source-selecting writer form against an unresolved shift.
    expect(screen.queryByRole('dialog', { name: 'صرف نقدية جديدة' })).not.toBeInTheDocument();
    await act(async () => { resolveShift({ success: true,
      data: { id: 'qa-late-shift-991', status: 'open' } }); });
    await screen.findByText(/وردية نشطة #qa-late/);
    expect(form()).toBeInTheDocument();
    expect(screen.getByLabelText('صرف من')).toHaveValue('pos');
    fireEvent.change(screen.getByLabelText('صرف إلى النوع'), { target: { value: 'personal' } });
    fireEvent.change(amount(), { target: { value: '7' } });
    fireEvent.click(save());
    await waitFor(() => expect(createCashMovementAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'disbursement', source_type: 'pos', shift_id: 'qa-late-shift-991', amount: 7,
    })));
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('keeps cash writers closed when native shift ownership lookup fails, then opens with the recovered shift', async () => {
    (getCurrentShiftAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Native shift ownership unavailable' })
      .mockResolvedValueOnce({ success: true,
        data: { id: 'qa-recovered-shift-42', status: 'open' } });
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'disbursement' }} />);
    expect(await screen.findByText('Native shift ownership unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'صرف نقدية جديدة' })).not.toBeInTheDocument();
    expect(createCashMovementAction).not.toHaveBeenCalled();
    expect(addExpenseAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => expect(getCurrentShiftAction).toHaveBeenCalledTimes(2));
    await screen.findByRole('dialog', { name: 'صرف نقدية جديدة' });
    expect(screen.getByLabelText('صرف من')).toHaveValue('pos');
    fireEvent.change(screen.getByLabelText('صرف إلى النوع'), { target: { value: 'personal' } });
    fireEvent.change(amount(), { target: { value: '4' } });
    fireEvent.click(save());
    await waitFor(() => expect(createCashMovementAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'disbursement', amount: 4, shift_id: 'qa-recovered-shift-42', source_type: 'pos',
    })));
  });
});

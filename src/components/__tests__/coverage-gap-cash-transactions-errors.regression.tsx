import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CashTransactionsClient from '@/components/finance/CashTransactionsClient';
import { createCashMovementAction, getCashMovementsAction } from '@/app/actions-client/finance';
import { addExpenseAction } from '@/app/actions-client/expenses';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('next/link', () => function MockLink({ href, children, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
});
jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(),
  getCashMovementsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/expenses', () => ({ addExpenseAction: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({ getCurrentShiftAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('cash-transaction error and keyboard behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCashMovementsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({ success: true, data: null });
  });

  it('shows a retryable load failure instead of reporting an empty movement history', async () => {
    (getCashMovementsAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'تعذر تحميل حركة النقدية' });
    render(<CashTransactionsClient />);

    expect(await screen.findByText('تعذر تحميل حركة النقدية')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد حركات مسجلة')).not.toBeInTheDocument();

    (getCashMovementsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{
        id: 'cash-1', type: 'receipt', category: 'pharmacy', amount: 25,
        user_id: 'u1', user_name: 'د. خالد', date: '2026-09-21', created_at: '2026-09-21T10:00:00', notes: 'توريد اختبار',
      }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('توريد اختبار')).toBeInTheDocument();
  });

  it('keeps the newest cash-history retry when same-tick reloads resolve out of order', async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    (getCashMovementsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'تعذر تحميل حركة النقدية' })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    render(<CashTransactionsClient />);
    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getCashMovementsAction).toHaveBeenCalledTimes(3);

    newer.resolve({
      success: true,
      data: [{
        id: 'cash-new', type: 'receipt', category: 'pharmacy', amount: 30,
        user_name: 'Newest User', created_at: '2026-09-22T10:00:00', notes: 'Newest cash history',
      }],
    });
    expect(await screen.findByText(/Newest cash history/)).toBeInTheDocument();

    await act(async () => {
      older.resolve({
        success: true,
        data: [{
          id: 'cash-old', type: 'receipt', category: 'pharmacy', amount: 10,
          user_name: 'Older User', created_at: '2026-09-22T09:00:00', notes: 'Older cash history',
        }],
      });
      await older.promise;
    });

    expect(screen.getByText(/Newest cash history/)).toBeInTheDocument();
    expect(screen.queryByText(/Older cash history/)).not.toBeInTheDocument();
  });

  it('validates amount, surfaces action failure, and keeps the form open for correction', async () => {
    (createCashMovementAction as jest.Mock).mockResolvedValue({ success: false, error: 'لا توجد وردية مفتوحة' });
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'receipt' }} />);

    expect(await screen.findByText('توريد نقدية جديدة')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /حفظ العملية/ }));
    expect(createCashMovementAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال قيمة صحيحة');

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ العملية/ }));

    await waitFor(() => expect(createCashMovementAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'receipt',
      amount: 50,
      category: 'pharmacy',
    })));
    expect(toast.error).toHaveBeenCalledWith('لا توجد وردية مفتوحة');
    expect(screen.getByText('توريد نقدية جديدة')).toBeInTheDocument();
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('registers Enter submit and Escape cancel hotkeys for the open form', async () => {
    const onFormClose = jest.fn();
    (createCashMovementAction as jest.Mock).mockResolvedValue({ success: false, error: 'blocked' });
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'receipt' }} onFormClose={onFormClose} />);
    await screen.findByText('توريد نقدية جديدة');

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '35' } });

    const hotkeyCalls = [...(useHotkeys as jest.Mock).mock.calls].reverse();
    const enterCall = hotkeyCalls.find(call => call[0] === 'enter');
    const escCall = hotkeyCalls.find(call => call[0] === 'esc');
    expect(enterCall).toBeDefined();
    expect(escCall).toBeDefined();

    const preventDefault = jest.fn();
    enterCall?.[1]({ preventDefault });
    await waitFor(() => expect(createCashMovementAction).toHaveBeenCalledWith(expect.objectContaining({ amount: 35 })));
    expect(preventDefault).toHaveBeenCalledTimes(1);

    escCall?.[1]();
    await waitFor(() => expect(onFormClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('توريد نقدية جديدة')).not.toBeInTheDocument();
  });

  it('prevents the save button and Enter hotkey from creating two cash movements in the same pending window', async () => {
    const pending = deferred<any>();
    (createCashMovementAction as jest.Mock).mockImplementation(() => pending.promise);
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'receipt' }} />);
    await screen.findByText('توريد نقدية جديدة');
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '45' } });

    fireEvent.click(screen.getByRole('button', { name: /حفظ العملية/ }));
    const enterCall = [...(useHotkeys as jest.Mock).mock.calls].reverse().find(call => call[0] === 'enter');
    enterCall?.[1]({ preventDefault: jest.fn() });

    expect(createCashMovementAction).toHaveBeenCalledTimes(1);
    pending.resolve({ success: false, error: 'stop' });
    await act(async () => { await pending.promise; });
  });

  it('recovers from a thrown cash-movement write and preserves the entered form for retry', async () => {
    (createCashMovementAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'receipt' }} />);
    await screen.findByText('توريد نقدية جديدة');
    const amount = screen.getByPlaceholderText('0.00') as HTMLInputElement;
    const notes = screen.getByPlaceholderText('اكتب أي ملاحظات هنا...') as HTMLTextAreaElement;
    fireEvent.change(amount, { target: { value: '55' } });
    fireEvent.change(notes, { target: { value: 'keep this note' } });
    const save = screen.getByRole('button', { name: /حفظ العملية/ });
    fireEvent.click(save);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل التسجيل'));
    expect(screen.getByText('توريد نقدية جديدة')).toBeInTheDocument();
    expect(amount.value).toBe('55');
    expect(notes.value).toBe('keep this note');
    expect(save).not.toBeDisabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not allow Escape or cancel to hide a form while its financial write is pending', async () => {
    const pending = deferred<any>();
    const onFormClose = jest.fn();
    (createCashMovementAction as jest.Mock).mockImplementation(() => pending.promise);
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'receipt' }} onFormClose={onFormClose} />);
    await screen.findByText('توريد نقدية جديدة');
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '65' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ العملية/ }));

    const escCall = [...(useHotkeys as jest.Mock).mock.calls].reverse().find(call => call[0] === 'esc');
    escCall?.[1]();
    fireEvent.click(screen.getByRole('button', { name: /إلغاء/ }));

    expect(screen.getByText('توريد نقدية جديدة')).toBeInTheDocument();
    expect(onFormClose).not.toHaveBeenCalled();

    pending.resolve({ success: false, error: 'stop' });
    await act(async () => { await pending.promise; });
  });
});

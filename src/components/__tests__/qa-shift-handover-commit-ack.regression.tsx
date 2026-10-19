import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DrawerHandoverClient from '@/components/finance/DrawerHandoverClient';
import { getHandoverDetailsAction, getShiftCreditSalesAction, processHandoverAction } from '@/app/actions-client/handover';
import { getBanksAction } from '@/app/actions-client/finance';
import { getStaffAction } from '@/app/actions-client/users';
import { getClientSession } from '@/lib/auth/local';
import toast from 'react-hot-toast';

// All financial actions and metadata reads are mocked. No native bridge,
// real customers, bank or shift ledger are accessed by this rendered suite.
jest.mock('@/app/actions-client/handover', () => ({
  getHandoverDetailsAction: jest.fn(),
  getShiftCreditSalesAction: jest.fn(),
  processHandoverAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({ getBanksAction: jest.fn() }));
jest.mock('@/app/actions-client/users', () => ({ getStaffAction: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn() }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));

const shiftId = 'synthetic-shift-handover-201';
const details = {
  id: shiftId,
  user_name: 'Synthetic Shift Cashier',
  start_time: '2026-10-14T08:00:00.000Z',
  starting_cash: 500,
  cash_sales: 800,
  credit_sales: 120,
  expected_cash: 1225,
  returns: 50,
  disbursements: 25,
};

function submitButton() {
  return screen.getByRole('button', { name: 'إتمام تسليم الدرج' });
}

async function mountHandover(onClose = jest.fn()) {
  render(<DrawerHandoverClient shiftId={shiftId} onClose={onClose} />);
  expect(await screen.findByRole('heading', { name: 'تسليم الوردية المشتركة' })).toBeInTheDocument();
  expect(screen.getByText('1,225')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'المستلم' })).toHaveValue('receiver-cashier');
  return onClose;
}

function prepareTransfer() {
  fireEvent.change(screen.getByRole('spinbutton', { name: 'النقدية المعدودة فعليًا في درج الوردية' }), {
    target: { value: '1200' },
  });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'المبلغ المراد تحويله' }), {
    target: { value: '1000' },
  });
  fireEvent.change(screen.getByLabelText('كلمة مرور المستلم'), {
    target: { value: 'synthetic-receiver-proof' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'ملاحظات التحويل' }), {
    target: { value: 'Synthetic shift count and treasury transfer' },
  });
}

describe('shift handover rendered acknowledgement and duplicate-submit boundaries', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'synthetic-cashier', role: 'pharmacist' });
    (getHandoverDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: details });
    (getBanksAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getStaffAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 'receiver-201', username: 'receiver-cashier', full_name: 'Synthetic Receiver' }],
    });
    (getShiftCreditSalesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('retains an acknowledged closed shift and locks further writes when post-commit onClose throws', async () => {
    (processHandoverAction as jest.Mock).mockResolvedValue({
      success: true, remainingCash: 200, startingCash: 200, difference: -25,
      status: 'closed', newShiftId: 'synthetic-new-shift-202',
    });
    const onClose = jest.fn(() => { throw new Error('handover route transition unavailable'); });
    await mountHandover(onClose);
    prepareTransfer();

    fireEvent.click(submitButton());
    await waitFor(() => expect(processHandoverAction).toHaveBeenCalledTimes(1));
    expect(processHandoverAction).toHaveBeenCalledWith(expect.objectContaining({
      shiftId,
      actualCash: 1200,
      transferAmount: 1000,
      transferTargetType: 'treasury',
      receiverUsername: 'receiver-cashier',
      receiverPassword: 'synthetic-receiver-proof',
      receiverPasswordHash: 'synthetic-receiver-proof',
      notes: 'Synthetic shift count and treasury transfer',
      autoOpenNewShift: true,
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('تم التسليم وإغلاق الوردية')));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('تم التسليم لكن تعذر إغلاق شاشة التسليم');
    expect(toast.error).not.toHaveBeenCalledWith('فشل إتمام العملية');
    const committedButton = screen.getByRole('button', { name: 'تم تسليم الدرج' });
    expect(committedButton).toBeDisabled();
    fireEvent.click(committedButton);
    expect(processHandoverAction).toHaveBeenCalledTimes(1);
  });

  it('suppresses duplicate handover writes during an unresolved commit and rejects over-transfer without writing', async () => {
    let completeHandover!: (value: { success: boolean; error?: string }) => void;
    (processHandoverAction as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      completeHandover = resolve;
    }));
    const onClose = await mountHandover();
    prepareTransfer();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'المبلغ المراد تحويله' }), {
      target: { value: '1200.01' },
    });
    fireEvent.click(submitButton());
    expect(toast.error).toHaveBeenCalledWith('مبلغ التحويل أكبر من النقدية الفعلية في الدرج');
    expect(processHandoverAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'المبلغ المراد تحويله' }), {
      target: { value: '1000' },
    });

    const form = submitButton().closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(processHandoverAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'جاري التنفيذ...' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => completeHandover({ success: false, error: 'source handover permission denied' }));
    expect(toast.error).toHaveBeenCalledWith('source handover permission denied');
    expect(screen.getByRole('button', { name: 'إتمام تسليم الدرج' })).toBeEnabled();
  });

  it('retains the recipient, counted amount and treasury destination after denied handover, then retries those exact values', async () => {
    (processHandoverAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'receiver credential declined' })
      .mockResolvedValueOnce({ success: true, remainingCash: 200, difference: -25 });
    const onClose = await mountHandover();
    prepareTransfer();
    fireEvent.click(submitButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('receiver credential declined'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton', { name: 'النقدية المعدودة فعليًا في درج الوردية' })).toHaveValue(1200);
    expect(screen.getByRole('spinbutton', { name: 'المبلغ المراد تحويله' })).toHaveValue(1000);
    expect(screen.getByRole('combobox', { name: 'المستلم' })).toHaveValue('receiver-cashier');
    expect(screen.getByRole('combobox', { name: 'الجهة المحول إليها' })).toHaveValue('treasury');

    fireEvent.click(submitButton());
    await waitFor(() => expect(processHandoverAction).toHaveBeenCalledTimes(2));
    expect((processHandoverAction as jest.Mock).mock.calls[1]).toEqual(
      (processHandoverAction as jest.Mock).mock.calls[0],
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

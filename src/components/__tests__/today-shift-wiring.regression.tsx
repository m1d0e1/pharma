import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LogoutModal from '@/components/auth/LogoutModal';
import DrawerHandoverClient from '@/components/finance/DrawerHandoverClient';
import PosDrawerHandoverModal from '@/components/pos/PosDrawerHandoverModal';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';
import { logoutLocalAction } from '@/app/actions-client/auth';
import {
  getHandoverDetailsAction,
  getOpenShiftHandoverAction,
  getShiftCreditSalesAction,
  processHandoverAction,
} from '@/app/actions-client/handover';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/app/actions-client/auth', () => ({ logoutLocalAction: jest.fn() }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({
  getCurrentShiftAction: jest.fn(),
  openShiftAction: jest.fn(async () => ({ success: true, shiftId: 'mock-shift-id' })),
}));
jest.mock('@/app/actions-client/handover', () => ({
  getHandoverDetailsAction: jest.fn(),
  getOpenShiftHandoverAction: jest.fn(),
  getShiftCreditSalesAction: jest.fn(async () => ({ success: true, data: [] })),
  processHandoverAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({
  getBanksAction: jest.fn(async () => ({ success: true, data: [] })),
}));
jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn(async () => ({
    success: true,
    data: [{ id: 'receiver', username: 'receiver', full_name: 'Receiver' }],
  })),
}));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => ({ role: 'owner' })),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('today shift UI wiring', () => {
  beforeEach(() => {
    mockPush.mockReset();
    (getCurrentShiftAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: { id: 'shift-1' } });
    (getOpenShiftHandoverAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: { id: 'shift-1' } });
    (getShiftCreditSalesAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getHandoverDetailsAction as jest.Mock).mockReset().mockResolvedValue({
      success: true,
      data: { id: 'shift-1', user_name: 'Cashier', expected_cash: 0, starting_cash: 0 },
    });
    (processHandoverAction as jest.Mock).mockReset().mockResolvedValue({ success: true });
  });

  it('allows immediate logout while the permanent cash session remains open', async () => {
    const onClose = jest.fn();
    render(<LogoutModal isOpen onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'تأكيد تسجيل الخروج' }));

    await waitFor(() => expect(logoutLocalAction).toHaveBeenCalledTimes(1));
    expect(getCurrentShiftAction).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('allows a zero-cash shift to close with a zero transfer', async () => {
    const onClose = jest.fn();
    render(<DrawerHandoverClient shiftId="shift-1" onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: /إتمام تسليم الدرج/ }));

    await waitFor(() => expect(processHandoverAction).toHaveBeenCalledWith(expect.objectContaining({
      shiftId: 'shift-1',
      actualCash: 0,
      transferAmount: 0,
      transferTargetType: 'treasury',
      receiverUsername: 'receiver',
    })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a paid-off credit receipt as zero instead of falling back to its invoice total', async () => {
    (getShiftCreditSalesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'paid-credit',
        invoice_number: 'paid-credit',
        total_amount: 100,
        credit_amount: 0,
        patient_name: 'Paid Patient',
        created_at: '2026-08-25T10:00:00Z',
      }],
    });

    render(<DrawerHandoverClient shiftId="shift-1" />);
    fireEvent.click(await screen.findByTitle('أين ذهب الآجل؟'));

    const invoiceCell = await screen.findByText('#paid-credit');
    const rowText = invoiceCell.closest('tr')?.textContent || '';
    expect(getShiftCreditSalesAction).toHaveBeenCalledWith('shift-1');
    expect(rowText).toMatch(/0|٠/);
    expect(rowText).not.toMatch(/100|١٠٠/);
  });

  it('clears POS handover state when reopening for a different shift', async () => {
    let activeShiftId = 'shift-a';
    (getCurrentShiftAction as jest.Mock).mockImplementation(async () => ({
      success: true,
      data: { id: activeShiftId },
    }));
    (getHandoverDetailsAction as jest.Mock).mockImplementation(async (shiftId: string) => ({
      success: true,
      data: { id: shiftId, user_name: 'Cashier', expected_cash: 0, starting_cash: 0 },
    }));
    (getShiftCreditSalesAction as jest.Mock).mockImplementation(async (shiftId: string) => shiftId === 'shift-a'
      ? {
          success: true,
          data: [{
            id: 'invoice-a',
            invoice_number: 'invoice-a',
            total_amount: 25,
            credit_amount: 25,
            patient_name: 'Patient A',
          }],
        }
      : { success: false, error: 'failed to load shift B', data: [] });

    const onClose = jest.fn();
    const { rerender } = render(<PosDrawerHandoverModal isOpen onClose={onClose} />);
    await waitFor(() => expect(getHandoverDetailsAction).toHaveBeenCalledWith('shift-a'));
    fireEvent.change(screen.getByPlaceholderText('أدخل النقدية الفعلية...'), { target: { value: '75' } });
    fireEvent.click(screen.getByTitle('عرض تفاصيل فواتير الآجل والعملاء'));
    expect(await screen.findByText('#invoice-a')).toBeInTheDocument();
    expect(getShiftCreditSalesAction).toHaveBeenLastCalledWith('shift-a');

    rerender(<PosDrawerHandoverModal isOpen={false} onClose={onClose} />);
    activeShiftId = 'shift-b';
    rerender(<PosDrawerHandoverModal isOpen onClose={onClose} />);

    await waitFor(() => expect(getHandoverDetailsAction).toHaveBeenCalledWith('shift-b'));
    expect((screen.getByPlaceholderText('أدخل النقدية الفعلية...') as HTMLInputElement).value).toBe('0');
    fireEvent.click(screen.getByTitle('عرض تفاصيل فواتير الآجل والعملاء'));
    await waitFor(() => expect(getShiftCreditSalesAction).toHaveBeenLastCalledWith('shift-b'));
    expect(screen.queryByText('#invoice-a')).not.toBeInTheDocument();
    expect(await screen.findByText('لا توجد مبيعات آجل مسجلة في هذه الوردية')).toBeInTheDocument();
  });
});

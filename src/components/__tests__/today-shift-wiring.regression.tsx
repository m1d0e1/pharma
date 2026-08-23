import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LogoutModal from '@/components/auth/LogoutModal';
import DrawerHandoverClient from '@/components/finance/DrawerHandoverClient';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';
import { getHandoverDetailsAction, processHandoverAction } from '@/app/actions-client/handover';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/app/actions-client/auth', () => ({ logoutLocalAction: jest.fn() }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({ getCurrentShiftAction: jest.fn() }));
jest.mock('@/app/actions-client/handover', () => ({
  getHandoverDetailsAction: jest.fn(),
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
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({ success: true, data: { id: 'shift-1' } });
    (getHandoverDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { id: 'shift-1', user_name: 'Cashier', expected_cash: 0, starting_cash: 0 },
    });
    (processHandoverAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('routes logout with an open shift through the unified handover', async () => {
    const onClose = jest.fn();
    render(<LogoutModal isOpen onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'الانتقال إلى تسليم الوردية' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/finance/handover');
  });

  it('allows a zero-cash shift to close with a zero transfer', async () => {
    const onClose = jest.fn();
    render(<DrawerHandoverClient shiftId="shift-1" onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: /إتمام تسليم الدرج/ }));

    await waitFor(() => expect(processHandoverAction).toHaveBeenCalledWith(expect.objectContaining({
      shiftId: 'shift-1',
      actualCash: 0,
      transferAmount: 0,
      receiverUsername: 'receiver',
    })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import POSPage from '@/app/(dashboard)/pos/page';
import { getClientSession } from '@/lib/auth/local';
import { getCurrentUserAction } from '@/app/actions-client/auth';
import { getUnitsAction } from '@/app/actions-client/master-drugs';
import { usePOSStore } from '@/store/usePOSStore';

const mockPush = jest.fn();
const mockRouter = { push: mockPush };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/hooks/useBarcodeScanner', () => ({ useBarcodeScanner: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/app/actions-client/auth', () => ({ getCurrentUserAction: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({ getUnitsAction: jest.fn() }));
jest.mock('@/app/actions-client/sales', () => ({
  searchDrugsAction: jest.fn(), barcodeLookupAction: jest.fn(),
  fetchDraftsAction: jest.fn(), processCheckoutAction: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({
  searchPatientsAction: jest.fn(),
  getPatientForPosAction: jest.fn(),
}));
jest.mock('@/app/actions-client/interactions', () => ({ checkDrugInteractions: jest.fn() }));
jest.mock('@/app/actions-client/shortages', () => ({ addToShortagesAction: jest.fn() }));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/pos/DrugInteractionModal', () => () => null);
jest.mock('@/components/returns/ReturnsClient', () => () => null);
jest.mock('@/components/pos/DraftsModal', () => () => null);
jest.mock('@/components/pos/StockWarningModal', () => () => null);
jest.mock('@/components/pos/PosDrawerHandoverModal', () => () => null);
jest.mock('@/components/AddPatientModal', () => () => null);

describe('POS tab startup read budget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePOSStore.getState().resetPOS();
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'cashier-a', role: 'cashier', pharmacy_id: 'ph-a',
      full_name: 'Cashier A', permissions: { can_access_pos: true },
    });
    (getCurrentUserAction as jest.Mock).mockResolvedValue({
      success: true,
      user: { id: 'cashier-a', pharmacy_id: 'ph-a', full_name: 'Cashier A' },
    });
    (getUnitsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('renders from its authenticated session without an identical second native session read or unused units scan', async () => {
    render(<POSPage />);
    expect(await screen.findByPlaceholderText('بحث (اسم أو كود)...')).toBeInTheDocument();
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(1));
    expect(getCurrentUserAction).not.toHaveBeenCalled();
    expect(getUnitsAction).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps the existing second session read as a fallback for incomplete legacy session objects', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'cashier-a', role: 'cashier' });
    render(<POSPage />);
    expect(await screen.findByPlaceholderText('بحث (اسم أو كود)...')).toBeInTheDocument();
    await waitFor(() => expect(getCurrentUserAction).toHaveBeenCalledTimes(1));
    expect(getUnitsAction).not.toHaveBeenCalled();
  });
});

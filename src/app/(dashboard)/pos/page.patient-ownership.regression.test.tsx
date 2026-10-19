import { render, screen, waitFor } from '@testing-library/react';
import POSPage from '@/app/(dashboard)/pos/page';
import { getClientSession } from '@/lib/auth/local';
import { getPatientForPosAction } from '@/app/actions-client/patients';
import { usePOSStore } from '@/store/usePOSStore';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/hooks/useBarcodeScanner', () => ({ useBarcodeScanner: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/app/actions-client/auth', () => ({
  getCurrentUserAction: jest.fn().mockResolvedValue({ success: false }),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({
  getUnitsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
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

describe('POS restored patient ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePOSStore.getState().resetPOS();
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'cashier-a', role: 'cashier', pharmacy_id: 'tenant-a',
      permissions: { can_access_pos: true },
    });
  });

  it('clears a restored foreign/legacy patient when the independent lookup denies provenance', async () => {
    (getPatientForPosAction as jest.Mock).mockResolvedValue({
      success: false, error: 'Legacy patient ownership needs independent tenant verification',
    });
    usePOSStore.getState().setSelectedPatient({
      id: 'legacy-b',
      full_name: 'PRIVATE LEGACY PATIENT',
      credit_limit: 9000,
      outstanding_balance: 100,
      wallet_balance: 999,
      points_balance: 500,
      payment_method: 'credit',
    });
    usePOSStore.getState().setPaymentMethod('credit');
    render(<POSPage />);
    await waitFor(() => expect(getPatientForPosAction).toHaveBeenCalledWith('legacy-b'));
    await waitFor(() => expect(usePOSStore.getState().selectedPatient).toBeNull());
    expect(usePOSStore.getState().paymentMethod).toBe('cash');
    expect(screen.queryByText('PRIVATE LEGACY PATIENT')).not.toBeInTheDocument();
  });
});

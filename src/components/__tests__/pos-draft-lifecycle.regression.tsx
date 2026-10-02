import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import POSPage from '@/app/(dashboard)/pos/page';
import { fetchDraftsAction, processCheckoutAction } from '@/app/actions-client/sales';
import { checkDrugInteractions } from '@/app/actions-client/interactions';
import { usePOSStore } from '@/store/usePOSStore';

const mockPush = jest.fn();
const mockRouter = { push: mockPush };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams('tab=drafts'),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/hooks/useBarcodeScanner', () => ({ useBarcodeScanner: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'user-1', role: 'pharmacist' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/app/actions-client/auth', () => ({
  getCurrentUserAction: jest.fn().mockResolvedValue({ success: false }),
}));
jest.mock('@/app/actions-client/sales', () => ({
  searchDrugsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  barcodeLookupAction: jest.fn(),
  fetchDraftsAction: jest.fn(),
  processCheckoutAction: jest.fn(),
}));
jest.mock('@/app/actions-client/interactions', () => ({ checkDrugInteractions: jest.fn() }));
jest.mock('@/app/actions-client/shortages', () => ({ addToShortagesAction: jest.fn() }));
jest.mock('@/app/actions-client/patients', () => ({
  searchPatientsAction: jest.fn(),
  getPatientForPosAction: jest.fn(async (id: string) => ({ success: true, data: { id } })),
  getPatientProfileAction: jest.fn(async (id: string) => ({ success: true, data: { id } })),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({
  getUnitsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/app/actions-client/finance', () => ({ generateDailySnapshotAction: jest.fn() }));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/returns/ReturnsClient', () => () => null);
jest.mock('@/components/pos/DraftsModal', () => function MockDraftsModal({ isOpen, onLoadDraft }: any) {
  if (!isOpen) return null;
  return (
    <button onClick={() => onLoadDraft({
      id: 'source-draft-1',
      patient_id: null,
      payment_method: 'cash',
      discount_amount: 0,
      additional_fees: 0,
      items: [{
        id: 'draft-line',
        drug_id: 'drug-1',
        trade_name: 'Draft Drug',
        trade_name_en: 'Draft Drug',
        active_ingredient: 'Ingredient A',
        qty: 1,
        price: 25,
        itemDiscountPercent: 0,
        basePrice: 25,
        selectedUnit: 'large',
        units: { large: 'box', large_to_medium: 1, medium_to_small: 1 },
        total_stock: 3,
        needsRefill: false,
        batches: [],
        inventory_id: null,
      }],
    })}>LOAD DRAFT</button>
  );
});
jest.mock('@/components/pos/StockWarningModal', () => () => null);
jest.mock('@/components/pos/PosDrawerHandoverModal', () => () => null);
jest.mock('@/components/pos/DrugInteractionModal', () => () => null);
jest.mock('@/components/AddPatientModal', () => () => null);

const cartItem = {
  id: 'draft-line',
  drug_id: 'drug-1',
  trade_name: 'Draft Drug',
  trade_name_en: 'Draft Drug',
  active_ingredient: 'Ingredient A',
  qty: 1,
  price: 25,
  itemDiscountPercent: 0,
  basePrice: 25,
  selectedUnit: 'large',
  units: { large: 'box', large_to_medium: 1, medium_to_small: 1 },
  total_stock: 3,
  needsRefill: false,
  batches: [],
  inventory_id: null,
};

async function loadSourceDraft() {
  fireEvent.click(await screen.findByRole('button', { name: 'LOAD DRAFT' }));
  await screen.findByText('Draft Drug');
}

describe('POS loaded-draft lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockReset();
    usePOSStore.getState().resetPOS();
    (fetchDraftsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { sale_id: 'replacement-sale', total_amount: 25, created_at: '2026-10-01T10:00:00Z' },
    });
    (checkDrugInteractions as jest.Mock).mockResolvedValue({
      success: true,
      data: { interactions: [], allergies: [] },
    });
  });

  afterEach(() => {
    act(() => usePOSStore.getState().resetPOS());
    jest.restoreAllMocks();
  });

  it.each([
    ['حفظ', 'draft'],
    ['إتمام البيع', 'completed'],
  ] as const)('sends source_draft_id when a loaded draft is submitted through %s', async (buttonName, status) => {
    render(<POSPage />);
    await loadSourceDraft();

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      source_draft_id: 'source-draft-1',
      status,
    })));
  });

  it('New clears the local source draft without deleting it, and the next checkout has no stale source id', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<POSPage />);
    await loadSourceDraft();

    fireEvent.click(screen.getByRole('button', { name: 'جديد' }));
    expect(processCheckoutAction).not.toHaveBeenCalled();
    expect(usePOSStore.getState().cart).toEqual([]);

    act(() => usePOSStore.getState().setCart([cartItem]));
    await screen.findByText('Draft Drug');
    fireEvent.click(await screen.findByRole('button', { name: 'إتمام البيع' }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      source_draft_id: null,
      status: 'completed',
    })));
    expect(processCheckoutAction).toHaveBeenCalledTimes(1);
  });
});

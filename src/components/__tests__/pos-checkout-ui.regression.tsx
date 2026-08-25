import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import POSPage from '@/app/(dashboard)/pos/page';
import { processCheckoutAction } from '@/app/actions-client/sales';
import { checkDrugInteractions } from '@/app/actions-client/interactions';
import { usePOSStore } from '@/store/usePOSStore';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/hooks/useBarcodeScanner', () => ({ useBarcodeScanner: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'user-1', role: 'pharmacist' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/app/actions-client/auth', () => ({
  getCurrentUserAction: jest.fn().mockResolvedValue({
    success: true,
    user: { id: 'user-1', pharmacy_id: 'pharmacy-1', full_name: 'Test Pharmacist' },
  }),
}));
jest.mock('@/app/actions-client/sales', () => ({
  searchDrugsAction: jest.fn(),
  searchPatientsAction: jest.fn(),
  barcodeLookupAction: jest.fn(),
  fetchDraftsAction: jest.fn(),
  processCheckoutAction: jest.fn(),
}));
jest.mock('@/app/actions-client/interactions', () => ({ checkDrugInteractions: jest.fn() }));
jest.mock('@/app/actions-client/shortages', () => ({ addToShortagesAction: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({
  getUnitsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/app/actions-client/finance', () => ({ generateDailySnapshotAction: jest.fn() }));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/returns/ReturnsClient', () => () => null);
jest.mock('@/components/pos/DraftsModal', () => () => null);
jest.mock('@/components/pos/StockWarningModal', () => () => null);
jest.mock('@/components/pos/PosDrawerHandoverModal', () => () => null);

const cartItem = {
  id: 'line-1',
  drug_id: 'drug-1',
  trade_name: 'دواء اختبار',
  trade_name_en: 'Test Drug',
  active_ingredient: 'Ingredient A',
  qty: 1,
  price: 25,
  itemDiscountPercent: 0,
  basePrice: 25,
  selectedUnit: 'large',
  units: { large: 'علبة', large_to_medium: 1, medium_to_small: 1 },
  total_stock: 3,
  needsRefill: false,
  batches: [],
  inventory_id: null,
};

describe('rendered POS checkout flow', () => {
  beforeEach(() => {
    mockPush.mockReset();
    usePOSStore.getState().resetPOS();
    usePOSStore.getState().setCart([cartItem]);
    (checkDrugInteractions as jest.Mock).mockResolvedValue({
      success: true,
      data: { interactions: [], allergies: [] },
    });
  });

  afterEach(() => usePOSStore.getState().resetPOS());

  it('blocks checkout on a safety alert, then submits only after explicit confirmation', async () => {
    (checkDrugInteractions as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        interactions: [{ ingredient_a: 'Ingredient A', ingredient_b: 'Ingredient B', severity: 'high', description: 'Unsafe pair' }],
        allergies: [],
      },
    });
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: true, data: { sale_id: 'sale-1' } });

    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: /إتمام وطباعة/ }));

    expect(await screen.findByText('تحذير: سلامة المريض')).toBeInTheDocument();
    expect(processCheckoutAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'استمرار على أي حال' }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ drug_id: 'drug-1', quantity_sold: 1, unit_price: 25 })],
      payment_method: 'cash',
      status: 'completed',
    })));
  });

  it('shows an actionable shift redirect when the backend rejects checkout without an open shift', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: false, error: 'يجب فتح وردية قبل إتمام البيع' });

    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: /إتمام وطباعة/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح وردية' }));

    expect(mockPush).toHaveBeenCalledWith('/shifts');
  });
});

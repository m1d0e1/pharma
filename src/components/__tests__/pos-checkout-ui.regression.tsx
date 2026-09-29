import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import POSPage from '@/app/(dashboard)/pos/page';
import { processCheckoutAction } from '@/app/actions-client/sales';
import { checkDrugInteractions } from '@/app/actions-client/interactions';
import { usePOSStore } from '@/store/usePOSStore';
import { hasUserPermissionSync } from '@/lib/auth/local';

const mockPush = jest.fn();
const mockRouter = { push: mockPush };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
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
jest.mock('@/components/receipts/ReceiptDetailsModal', () => function MockReceiptDetailsModal({ invoice, autoPrint }: any) {
  return (
    <div data-testid="receipt-details-modal" data-auto-print={String(Boolean(autoPrint))}>
      {invoice?.sales_items?.map((item: any, index: number) => (
        <span key={index}>{`receipt-unit-price:${item.unit_price}`}</span>
      ))}
    </div>
  );
});
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
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    usePOSStore.getState().resetPOS();
    usePOSStore.getState().setCart([cartItem]);
    (checkDrugInteractions as jest.Mock).mockResolvedValue({
      success: true,
      data: { interactions: [], allergies: [] },
    });
  });

  afterEach(() => {
    act(() => usePOSStore.getState().resetPOS());
  });

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

  it('blocks checkout when the clinical safety check fails', async () => {
    (checkDrugInteractions as jest.Mock).mockResolvedValue({ success: false, error: 'checker unavailable' });
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: true, data: { sale_id: 'unsafe-sale' } });

    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: /إتمام وطباعة/ }));

    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalled());
    expect(processCheckoutAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /إتمام وطباعة/ })).toBeEnabled();
  });

  it('hides drawer handover when the POS user lacks the handover permission', async () => {
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user: any, key: string) => key !== 'acc_can_view_handover');

    render(<POSPage />);

    await waitFor(() => expect(hasUserPermissionSync).toHaveBeenCalledWith(expect.anything(), 'acc_can_view_handover'));
    expect(screen.queryByRole('button', { name: 'تسليم الدرج' })).not.toBeInTheDocument();
  });

  it('does not redirect to the retired manual-shift flow on a stale backend error', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: false, error: 'يجب فتح وردية قبل إتمام البيع' });

    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: /إتمام وطباعة/ }));
    expect(await screen.findByText('يجب فتح وردية قبل إتمام البيع')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'فتح وردية' })).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalledWith('/shifts');
  });

  it('submits a permitted per-item discount separately from the receipt discount', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: true, data: { sale_id: 'sale-discount' } });
    render(<POSPage />);

    fireEvent.change(await screen.findByLabelText('خصم الصنف Test Drug'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /إتمام وطباعة/ }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ unit_price: 22.5, item_discount_percent: 10 })],
      total_discount: 0,
    })));
  });

  it('prints automatically when checkout is triggered by the button labelled إتمام وطباعة', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { sale_id: 'sale-print', created_at: '2026-09-27T18:00:00' },
    });
    render(<POSPage />);

    fireEvent.click(await screen.findByRole('button', { name: /إتمام وطباعة/ }));

    const receipt = await screen.findByTestId('receipt-details-modal');
    expect(receipt).toHaveAttribute('data-auto-print', 'true');
  });

  it('prints automatically when checkout is triggered by the sidebar button labelled طباعة', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { sale_id: 'sale-sidebar-print', created_at: '2026-09-27T18:00:00' },
    });
    render(<POSPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'طباعة' }));

    const receipt = await screen.findByTestId('receipt-details-modal');
    expect(receipt).toHaveAttribute('data-auto-print', 'true');
  });

  it('builds the immediate receipt with the same discounted unit price persisted by checkout', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { sale_id: 'sale-discount-receipt', created_at: '2026-09-27T18:00:00' },
    });
    render(<POSPage />);

    fireEvent.change(await screen.findByLabelText('خصم الصنف Test Drug'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /إتمام وطباعة/ }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ unit_price: 22.5, item_discount_percent: 10 })],
    })));
    expect(await screen.findByText('receipt-unit-price:22.5')).toBeInTheDocument();
  });

  it('submits wallet checkout with the selected patient', async () => {
    usePOSStore.getState().setSelectedPatient({
      id: 'patient-wallet',
      full_name: 'Wallet Patient',
      wallet_balance: 100,
      credit_limit: 500,
    });
    usePOSStore.getState().setPaymentMethod('wallet');
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: true, data: { sale_id: 'sale-wallet' } });

    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: /إتمام وطباعة/ }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      patient_id: 'patient-wallet',
      payment_method: 'wallet',
      status: 'completed',
    })));
  });

  it('hides return and shortage affordances when the POS user lacks their permissions', async () => {
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user: any, key: string) => (
      key !== 'can_view_returns' && key !== 'can_view_restock'
    ));

    render(<POSPage />);

    await waitFor(() => expect(hasUserPermissionSync).toHaveBeenCalledWith(expect.anything(), 'can_view_returns'));
    await waitFor(() => expect(hasUserPermissionSync).toHaveBeenCalledWith(expect.anything(), 'can_view_restock'));
    expect(screen.queryByRole('button', { name: 'استرجاع' })).not.toBeInTheDocument();

    const row = (await screen.findByText('Test Drug')).closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.queryByText('إضافة إلى النواقص (F9)')).not.toBeInTheDocument();
  });

  it('hides and clears per-item discount when its permission is disabled', async () => {
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user, key) => key !== 'can_discount_sale_item');
    usePOSStore.getState().setCart([{ ...cartItem, itemDiscountPercent: 10 }]);

    render(<POSPage />);

    await waitFor(() => expect(usePOSStore.getState().cart[0].itemDiscountPercent).toBe(0));
    expect(screen.queryByLabelText('خصم الصنف Test Drug')).not.toBeInTheDocument();
    expect(screen.getByTitle('تعديل خصم الصنف يتطلب صلاحية')).toHaveTextContent('0%');
  });

  it('uses the selected batch conversion for small-unit price and stock', async () => {
    usePOSStore.getState().setCart([{
      ...cartItem,
      id: 'batch-line',
      price: 100,
      basePrice: 100,
      selectedUnit: 'large',
      inventory_id: 'batch-1',
      total_stock: 1,
      units: {
        large: 'box',
        medium: 'strip',
        small: 'tablet',
        large_to_medium: 2,
        medium_to_small: 10,
      },
      batches: [{
        inventory_id: 'batch-1',
        quantity: 1,
        unit_price: 100,
        strips_per_box: 2,
        medium_to_small: 5,
        expiry_date: '2099-12-31',
      }],
    }]);

    render(<POSPage />);
    const unitSelect = (await screen.findAllByRole('combobox'))[0];
    fireEvent.change(unitSelect, { target: { value: 'small' } });

    await waitFor(() => expect(usePOSStore.getState().cart[0]).toMatchObject({
      selectedUnit: 'small',
      price: 10,
    }));
  });

  it('disables checkout when multiple rows overcommit the same drug stock pool', async () => {
    usePOSStore.getState().setCart([
      { ...cartItem, id: 'same-drug-large', total_stock: 1, qty: 1 },
      { ...cartItem, id: 'same-drug-second-row', total_stock: 1, qty: 1 },
    ]);

    render(<POSPage />);

    expect(await screen.findByRole('button', { name: /إتمام وطباعة/ })).toBeDisabled();
  });
});

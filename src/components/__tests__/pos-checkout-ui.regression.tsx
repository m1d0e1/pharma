import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import POSPage from '@/app/(dashboard)/pos/page';
import { processCheckoutAction } from '@/app/actions-client/sales';
import { checkDrugInteractions } from '@/app/actions-client/interactions';
import { usePOSStore } from '@/store/usePOSStore';
import { hasUserPermissionSync } from '@/lib/auth/local';
import { getPatientForPosAction, searchPatientsAction } from '@/app/actions-client/patients';

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
jest.mock('@/app/actions-client/patients', () => ({
  searchPatientsAction: jest.fn(),
  getPatientForPosAction: jest.fn(async (id: string) => ({
    success: true,
    data: { id },
  })),
  getPatientProfileAction: jest.fn(async (id: string) => ({
    success: true,
    data: { id, points_balance: 0, credit_limit: 500 },
  })),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({
  getUnitsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/app/actions-client/finance', () => ({ generateDailySnapshotAction: jest.fn() }));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => function MockReceiptDetailsModal({ invoice, autoPrint }: any) {
  return (
    <div data-testid="receipt-details-modal" data-auto-print={String(Boolean(autoPrint))}>
      <span>{`receipt-total:${invoice?.total_amount}`}</span>
      <span>{`receipt-discount:${invoice?.discount_amount}`}</span>
      <span>{`receipt-points-redeemed:${invoice?.points_redeemed || 0}`}</span>
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
    (getPatientForPosAction as jest.Mock).mockImplementation(async (id: string) => ({
      success: true,
      data: { id },
    }));
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
    fireEvent.click(await screen.findByRole('button', { name: /إتمام البيع/ }));

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
    fireEvent.click(await screen.findByRole('button', { name: /إتمام البيع/ }));

    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalled());
    expect(processCheckoutAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /إتمام البيع/ })).toBeEnabled();
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
    fireEvent.click(await screen.findByRole('button', { name: /إتمام البيع/ }));
    expect(await screen.findByText('يجب فتح وردية قبل إتمام البيع')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'فتح وردية' })).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalledWith('/shifts');
  });

  it('submits a permitted per-item discount separately from the receipt discount', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: true, data: { sale_id: 'sale-discount' } });
    render(<POSPage />);

    fireEvent.change(await screen.findByLabelText('خصم الصنف Test Drug'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /إتمام البيع/ }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ unit_price: 22.5, item_discount_percent: 10 })],
      total_discount: 0,
    })));
  });

  it('opens the completed receipt without automatically printing it', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { sale_id: 'sale-print', created_at: '2026-09-27T18:00:00' },
    });
    render(<POSPage />);

    fireEvent.click(await screen.findByRole('button', { name: /إتمام البيع/ }));

    const receipt = await screen.findByTestId('receipt-details-modal');
    expect(receipt).toHaveAttribute('data-auto-print', 'false');
  });

  it('uses the sidebar sale action without automatically printing the receipt', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { sale_id: 'sale-sidebar-print', created_at: '2026-09-27T18:00:00' },
    });
    render(<POSPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'بيع' }));

    const receipt = await screen.findByTestId('receipt-details-modal');
    expect(receipt).toHaveAttribute('data-auto-print', 'false');
  });

  it('routes the POS options sidebar control to settings instead of exposing a dead button', async () => {
    render(<POSPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'خيارات' }));

    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it('wires the remaining POS utility sidebar controls to calculator and reports', async () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    render(<POSPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'آلة حاسبة' }));
    expect(openSpy).toHaveBeenCalledWith('https://www.google.com/search?q=calculator', '_blank');

    fireEvent.click(screen.getByRole('button', { name: 'تقارير' }));
    expect(mockPush).toHaveBeenCalledWith('/reports');
    openSpy.mockRestore();
  });

  it('builds the immediate receipt with the same discounted unit price persisted by checkout', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { sale_id: 'sale-discount-receipt', created_at: '2026-09-27T18:00:00' },
    });
    render(<POSPage />);

    fireEvent.change(await screen.findByLabelText('خصم الصنف Test Drug'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /إتمام البيع/ }));

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
    fireEvent.click(await screen.findByRole('button', { name: /إتمام البيع/ }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      patient_id: 'patient-wallet',
      payment_method: 'wallet',
      status: 'completed',
    })));
  });

  it('lets the cashier choose check payment and submits its check number', async () => {
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: true, data: { sale_id: 'sale-check' } });

    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: /شيك/ }));
    fireEvent.change(screen.getByLabelText('رقم الشيك'), { target: { value: 'CHK-2026-001' } });
    fireEvent.click(screen.getByRole('button', { name: /إتمام البيع/ }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      payment_method: 'check',
      check_number: 'CHK-2026-001',
      status: 'completed',
    })));
  });

  it('blocks a completed check sale until a nonblank check number is entered', async () => {
    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: /شيك/ }));
    fireEvent.change(screen.getByLabelText('رقم الشيك'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /إتمام البيع/ }));

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(checkDrugInteractions).not.toHaveBeenCalled();
    expect(processCheckoutAction).not.toHaveBeenCalled();
    expect(screen.getByText('يرجى إدخال رقم الشيك')).toBeInTheDocument();
  });

  it('preserves searched patient loyalty points and remaining credit through selection into the POS store', async () => {
    (searchPatientsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'w3-main',
        full_name: 'W3 Patient Main',
        phone: '01011112222',
        credit_limit: 500,
        outstanding_balance: 385,
        wallet_balance: 70,
        points_balance: 180,
        payment_method: 'cash',
      }],
    });

    render(<POSPage />);
    fireEvent.change(await screen.findByPlaceholderText('بحث باسم أو هاتف العميل...'), {
      target: { value: 'W3 Patient Main' },
    });

    fireEvent.click(await screen.findByRole('button', { name: /W3 Patient Main.*مديونية: 385\.00/ }));

    await waitFor(() => expect(usePOSStore.getState().selectedPatient).toMatchObject({
      id: 'w3-main',
      credit_limit: 500,
      outstanding_balance: 385,
      points_balance: 180,
    }));
    const selected = usePOSStore.getState().selectedPatient;
    expect(Number(selected?.credit_limit || 0) - Number(selected?.outstanding_balance || 0)).toBe(115);
    expect(await screen.findByText('180')).toBeInTheDocument();
  });

  it('uses explicit selected-state classes and aria-pressed for payment methods', async () => {
    render(<POSPage />);

    const wallet = await screen.findByRole('button', { name: /محفظة/ });
    fireEvent.click(wallet);
    expect(wallet).toHaveAttribute('aria-pressed', 'true');
    expect(wallet).toHaveClass('bg-purple-700', 'border-purple-800');

    const cash = screen.getByRole('button', { name: /كاش/ });
    expect(cash).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps native Tab navigation and exposes cart quantity controls to keyboard users', async () => {
    render(<POSPage />);

    const search = await screen.findByPlaceholderText('بحث (اسم أو كود)...');
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true);

    const decrement = screen.getByRole('button', { name: 'تقليل كمية Test Drug' });
    const increment = screen.getByRole('button', { name: 'زيادة كمية Test Drug' });
    expect(decrement).not.toHaveAttribute('tabindex', '-1');
    expect(increment).not.toHaveAttribute('tabindex', '-1');
    expect(decrement).toHaveClass('h-11', 'w-11');
    expect(increment).toHaveClass('h-11', 'w-11');

    const row = screen.getByText('Test Drug').closest('tr') as HTMLTableRowElement;
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.focus(row);
    expect(row).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the quick sales-return surface as a named keyboard-contained dialog', async () => {
    render(<POSPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'استرجاع' }));
    const dialog = screen.getByRole('dialog', { name: 'اختصار المرتجع السريع' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'إغلاق المرتجع السريع' })).toBeInTheDocument();
  });

  it('keeps the cart remove action keyboard-reachable and explicitly named', async () => {
    render(<POSPage />);

    const remove = await screen.findByRole('button', { name: 'حذف Test Drug من الفاتورة' });
    remove.focus();
    expect(remove).toHaveFocus();
    expect(remove).toHaveAttribute('data-nav', 'remove-item-0');
  });

  it('refreshes a persisted patient snapshot before rendering stale loyalty points', async () => {
    usePOSStore.getState().setSelectedPatient({
      id: 'w3-main',
      full_name: 'W3 Patient Main',
      phone: '01011112222',
      credit_limit: 500,
      outstanding_balance: 385,
      wallet_balance: 70,
      points_balance: 0,
      payment_method: 'credit',
    });
    usePOSStore.getState().setPaymentMethod('credit');
    (getPatientForPosAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'w3-main',
        full_name: 'W3 Patient Main',
        phone: '01011112222',
        credit_limit: 500,
        outstanding_balance: 385,
        wallet_balance: 70,
        points_balance: 180,
        payment_method: 'credit',
      },
    });

    render(<POSPage />);

    await waitFor(() => expect(usePOSStore.getState().selectedPatient).toMatchObject({
      id: 'w3-main',
      outstanding_balance: 385,
      points_balance: 180,
    }));
    const refreshed = usePOSStore.getState().selectedPatient;
    expect(Number(refreshed?.credit_limit || 0) - Number(refreshed?.outstanding_balance || 0)).toBe(115);
    expect(await screen.findByText('180')).toBeInTheDocument();
  });

  it('submits loyalty redemption only as part of checkout and builds the receipt from authoritative checkout totals', async () => {
    usePOSStore.getState().setSelectedPatient({
      id: 'patient-loyalty',
      full_name: 'Loyalty Patient',
      points_balance: 150,
      credit_limit: 500,
    });
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        sale_id: 'sale-loyalty',
        total_amount: 15,
        points_redeemed: 100,
        loyalty_discount_amount: 10,
        created_at: '2026-09-29T12:00:00Z',
      },
    });

    render(<POSPage />);
    fireEvent.change(await screen.findByLabelText('نقاط الولاء المستخدمة'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /إتمام البيع/ }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      patient_id: 'patient-loyalty',
      points_to_redeem: 100,
      total_discount: 0,
    })));
    expect(await screen.findByText('receipt-total:15')).toBeInTheDocument();
    expect(screen.getByText('receipt-discount:10')).toBeInTheDocument();
    expect(screen.getByText('receipt-points-redeemed:100')).toBeInTheDocument();
  });

  it('clamps a selected loyalty redemption when later discounts reduce the redeemable maximum', async () => {
    usePOSStore.getState().setSelectedPatient({
      id: 'patient-loyalty-shrink',
      full_name: 'Loyalty Shrink Patient',
      points_balance: 150,
      credit_limit: 500,
    });
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: true, data: { sale_id: 'sale-loyalty-shrink' } });

    render(<POSPage />);
    fireEvent.change(await screen.findByLabelText('نقاط الولاء المستخدمة'), { target: { value: '100' } });
    act(() => usePOSStore.getState().setTotalDiscount(20));

    await waitFor(() => expect(screen.queryByLabelText('نقاط الولاء المستخدمة')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /إتمام البيع/ }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      patient_id: 'patient-loyalty-shrink',
      total_discount: 20,
      points_to_redeem: 0,
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

    expect(await screen.findByRole('button', { name: /إتمام البيع/ })).toBeDisabled();
  });

  it('drops stale source-drug cart rows after a cross-window identity merge while preserving unrelated rows', async () => {
    usePOSStore.getState().setCart([
      { ...cartItem, id: 'merged-source-line', drug_id: 101, trade_name: 'Merged Source' },
      { ...cartItem, id: 'unrelated-line', drug_id: 202, trade_name: 'Unrelated Drug' },
    ]);

    render(<POSPage />);
    await screen.findByRole('button', { name: /إتمام البيع/ });
    expect(usePOSStore.getState().cart.map(item => item.drug_id)).toEqual([101, 202]);

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pharma:drug-identity-updated',
        newValue: JSON.stringify({ sourceIds: [101], targetId: 303, nonce: 'other-window' }),
      }));
    });

    await waitFor(() => expect(usePOSStore.getState().cart.map(item => item.drug_id)).toEqual([202]));
  });
});

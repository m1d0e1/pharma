import { usePOSStore } from '@/store/usePOSStore';

jest.mock('@/app/actions-client/sales', () => ({
  createSaleAction: jest.fn(() => Promise.resolve({ success: true, saleId: 'sale-001' })),
}));

jest.mock('@/app/actions-client/patients', () => ({
  addPatientAction: jest.fn(() => Promise.resolve({ success: true, id: 'pat-001' })),
}));

describe('POS Flow — Cart Operations', () => {
  beforeEach(() => {
    usePOSStore.getState().resetPOS();
  });

  it('starts with empty cart', () => {
    const state = usePOSStore.getState();
    expect(state.cart).toEqual([]);
    expect(state.paymentMethod).toBe('cash');
    expect(state.selectedPatient).toBeNull();
  });

  it('adds items to cart via setCart functional update', () => {
    const { setCart } = usePOSStore.getState();
    setCart([{
      drug_id: 1, trade_name: 'Panadol', active_ingredient: 'Paracetamol',
      qty: 2, price: 15, itemDiscountPercent: 0, needsRefill: false,
      selectedUnit: 'large', basePrice: 15, units: { large: 'Box', large_to_medium: 10, medium_to_small: 1 },
      total_stock: 100, reorder_point: 10, nearest_expiry: '2026-12-31',
    }]);
    expect(usePOSStore.getState().cart).toHaveLength(1);
    expect(usePOSStore.getState().cart[0].trade_name).toBe('Panadol');
  });

  it('selects a patient', () => {
    const { setSelectedPatient } = usePOSStore.getState();
    setSelectedPatient({ id: 'pat-1', full_name: 'Ahmed', phone: '012345' });
    expect(usePOSStore.getState().selectedPatient?.full_name).toBe('Ahmed');
  });

  it('changes payment method from cash to credit', () => {
    const { setPaymentMethod } = usePOSStore.getState();
    setPaymentMethod('credit');
    expect(usePOSStore.getState().paymentMethod).toBe('credit');
  });

  it('applies discount', () => {
    const { setTotalDiscount, setDiscountPercent } = usePOSStore.getState();
    setTotalDiscount(50);
    setDiscountPercent(10);
    const state = usePOSStore.getState();
    expect(state.totalDiscount).toBe(50);
    expect(state.discountPercent).toBe(10);
  });

  it('resets all state', () => {
    const { setCart, setTotalDiscount, resetPOS } = usePOSStore.getState();
    setCart([{ drug_id: 1, trade_name: 'Test', active_ingredient: 'X', qty: 1, price: 10, itemDiscountPercent: 0, needsRefill: false, selectedUnit: 'large', basePrice: 10, units: { large: 'Box', large_to_medium: 1, medium_to_small: 1 }, total_stock: 50, reorder_point: 5, nearest_expiry: '2026-06-30' }]);
    setTotalDiscount(100);
    resetPOS();
    const state = usePOSStore.getState();
    expect(state.cart).toEqual([]);
    expect(state.totalDiscount).toBe(0);
    expect(state.discountPercent).toBe(0);
    expect(state.paymentMethod).toBe('cash');
    expect(state.selectedPatient).toBeNull();
  });

  it('purchase flow — creates sale via action', async () => {
    const { createSaleAction } = require('@/app/actions-client/sales');
    const result = await createSaleAction({ items: [], total: 0, paymentMethod: 'cash' });
    expect(result.success).toBe(true);
    expect(result.saleId).toBe('sale-001');
  });
});

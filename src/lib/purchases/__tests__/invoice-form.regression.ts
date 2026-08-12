import {
  clampPurchasePercent,
  derivePurchaseDiscountPercent,
  getPurchaseExpiryStatus,
} from '@/lib/purchases/invoice-form';

describe('purchase invoice form invariants', () => {
  it('keeps derived purchase discounts within the native 0..100 contract', () => {
    expect(derivePurchaseDiscountPercent(80, 100)).toBeCloseTo(20);
    expect(derivePurchaseDiscountPercent(120, 100)).toBe(0);
    expect(derivePurchaseDiscountPercent(0, 100)).toBe(100);
    expect(derivePurchaseDiscountPercent(10, 0)).toBe(0);
    expect(clampPurchasePercent(140)).toBe(100);
    expect(clampPurchasePercent(-5)).toBe(0);
  });

  it('validates real calendar dates and rejects a past day in the current month', () => {
    const today = new Date(2026, 7, 12);
    expect(getPurchaseExpiryStatus('2026-08-01', today)).toBe('expired');
    expect(getPurchaseExpiryStatus('2026-08-12', today)).toBe('valid');
    expect(getPurchaseExpiryStatus('2026-08-13', today)).toBe('valid');
    expect(getPurchaseExpiryStatus('2026-02-30', today)).toBe('invalid');
    expect(getPurchaseExpiryStatus('2026-2-03', today)).toBe('invalid');
  });
});

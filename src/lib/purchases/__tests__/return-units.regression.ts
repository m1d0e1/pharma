import {
  purchaseReturnPriceForUnit,
  purchaseReturnQuantityForUnit,
  purchaseReturnRemainingLargeQuantity,
} from '@/lib/purchases/return-units';

describe('purchase return unit limits', () => {
  it('converts the remaining paid boxes, not the original box count', () => {
    const remainingBoxes = purchaseReturnRemainingLargeQuantity(
      2,
      [{ quantity: 6, unit: 'medium' }],
      12,
      10
    );

    expect(purchaseReturnQuantityForUnit(remainingBoxes, 'large', 12, 10)).toBe(1.5);
    expect(purchaseReturnQuantityForUnit(remainingBoxes, 'medium', 12, 10)).toBe(18);
    expect(purchaseReturnQuantityForUnit(remainingBoxes, 'small', 12, 10)).toBe(180);
    expect(purchaseReturnPriceForUnit(120, 'medium', 12, 10)).toBe(10);
  });
});

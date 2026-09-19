import {
  purchaseReturnMatchesSearch,
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

  it('keeps box, strip, and tablet quantities and prices economically equivalent', () => {
    const largePrice = 120;
    const equivalents = [
      { unit: 'large' as const, quantity: 1, price: 120 },
      { unit: 'medium' as const, quantity: 12, price: 10 },
      { unit: 'small' as const, quantity: 120, price: 1 },
    ];

    for (const value of equivalents) {
      expect(purchaseReturnQuantityForUnit(1, value.unit, 12, 10)).toBe(value.quantity);
      expect(purchaseReturnPriceForUnit(largePrice, value.unit, 12, 10)).toBe(value.price);
      expect(value.quantity * value.price).toBe(largePrice);
    }

    expect(purchaseReturnRemainingLargeQuantity(
      2,
      [
        { quantity: 3, unit: 'medium' },
        { quantity: 30, unit: 'small' },
        { quantity: 0.5, unit: 'large' },
      ],
      12,
      10
    )).toBe(1);
  });

  it('matches invoice items by Arabic/English drug name or barcode', () => {
    const item = { drug_name: 'بنادول', drug_name_en: 'Panadol Extra', barcode: '6221234567890' };
    expect(purchaseReturnMatchesSearch(item, 'بنا')).toBe(true);
    expect(purchaseReturnMatchesSearch(item, 'panadol')).toBe(true);
    expect(purchaseReturnMatchesSearch(item, '6221234567890')).toBe(true);
    expect(purchaseReturnMatchesSearch(item, 'aspirin')).toBe(false);
  });
});

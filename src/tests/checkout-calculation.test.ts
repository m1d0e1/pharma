import { calculateCheckoutTotal, calculateLoyaltyPoints } from '@/lib/pos/checkout-calculation';

describe('checkout calculation', () => {
  it('includes fees, discount, and loyalty multiplier consistently', () => {
    const total = calculateCheckoutTotal([
      { unit_price: 10, quantity_sold: 2 },
      { unit_price: 5, quantity_sold: 3 },
    ], 4, 2);

    expect(total).toBe(33);
    expect(calculateLoyaltyPoints(total, 'gold')).toBe(49);
  });
});

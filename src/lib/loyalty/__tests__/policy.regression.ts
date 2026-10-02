import {
  BASE_POINTS_PER_EGP,
  calculateLoyaltyPoints,
  EGP_PER_REDEEMED_POINT,
  loyaltyDiscountAmount,
  maxRedeemablePoints,
  MIN_REDEEM_POINTS,
} from '@/lib/loyalty/policy';

describe('canonical loyalty policy', () => {
  it('uses one earning policy for all loyalty tiers', () => {
    expect(BASE_POINTS_PER_EGP).toBe(1);
    expect(calculateLoyaltyPoints(33)).toBe(33);
    expect(calculateLoyaltyPoints(33, 'silver')).toBe(39);
    expect(calculateLoyaltyPoints(33, 'gold')).toBe(49);
    expect(calculateLoyaltyPoints(33, 'platinum')).toBe(66);
    expect(calculateLoyaltyPoints(Number.NaN, 'gold')).toBe(0);
  });

  it('keeps redemption constants and calculations canonical', () => {
    expect(MIN_REDEEM_POINTS).toBe(100);
    expect(EGP_PER_REDEEMED_POINT).toBe(0.1);
    expect(loyaltyDiscountAmount(123)).toBe(12.3);
    expect(maxRedeemablePoints(150, 10)).toBe(100);
  });
});

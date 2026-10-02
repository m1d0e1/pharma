export const MIN_REDEEM_POINTS = 100;
export const EGP_PER_REDEEMED_POINT = 0.1;
export const BASE_POINTS_PER_EGP = 1;

export function calculateLoyaltyPoints(totalAmount: number, loyaltyLevel?: string | null): number {
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) return 0;
  const multiplier = loyaltyLevel === 'platinum' ? 2 : loyaltyLevel === 'gold' ? 1.5 : loyaltyLevel === 'silver' ? 1.2 : BASE_POINTS_PER_EGP;
  return Math.floor(totalAmount * multiplier);
}

export function loyaltyDiscountAmount(points: number): number {
  if (!Number.isFinite(points) || !Number.isInteger(points) || points < 0) return NaN;
  return Math.round(points * EGP_PER_REDEEMED_POINT * 100) / 100;
}

export function maxRedeemablePoints(pointsBalance: number, eligibleMerchandiseAmount: number): number {
  if (!Number.isFinite(pointsBalance) || !Number.isFinite(eligibleMerchandiseAmount)) return 0;
  const byBalance = Math.max(0, Math.floor(pointsBalance));
  const byMerchandise = Math.max(0, Math.floor((eligibleMerchandiseAmount + 0.000001) / EGP_PER_REDEEMED_POINT));
  return Math.min(byBalance, byMerchandise);
}

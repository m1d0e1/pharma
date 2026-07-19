export function calculateCheckoutTotal(items: Array<{ unit_price: number; quantity_sold: number }>, discount = 0, additionalFees = 0): number {
  return items.reduce((sum, item) => sum + (item.unit_price * item.quantity_sold), 0) + additionalFees - discount;
}

export function calculateLoyaltyPoints(totalAmount: number, loyaltyLevel?: string | null): number {
  const multiplier = loyaltyLevel === 'platinum' ? 2 : loyaltyLevel === 'gold' ? 1.5 : loyaltyLevel === 'silver' ? 1.2 : 1;
  return Math.floor(totalAmount * multiplier);
}

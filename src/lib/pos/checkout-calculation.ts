export { calculateLoyaltyPoints } from '@/lib/loyalty/policy';

export function calculateCheckoutTotal(items: Array<{ unit_price: number; quantity_sold: number }>, discount = 0, additionalFees = 0): number {
  return items.reduce((sum, item) => sum + (item.unit_price * item.quantity_sold), 0) + additionalFees - discount;
}

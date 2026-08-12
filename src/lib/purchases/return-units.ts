export type PurchaseReturnUnit = 'large' | 'medium' | 'small';

export function purchaseReturnUnitFactor(
  unit: PurchaseReturnUnit,
  largeToMedium: number,
  mediumToSmall: number
) {
  const medium = Math.max(1, Number(largeToMedium) || 1);
  const small = Math.max(1, Number(mediumToSmall) || 1);
  return unit === 'medium' ? medium : unit === 'small' ? medium * small : 1;
}

export function purchaseReturnQuantityForUnit(
  remainingLargeQuantity: number,
  unit: PurchaseReturnUnit,
  largeToMedium: number,
  mediumToSmall: number
) {
  return Math.max(0, Number(remainingLargeQuantity) || 0)
    * purchaseReturnUnitFactor(unit, largeToMedium, mediumToSmall);
}

export function purchaseReturnPriceForUnit(
  refundableLargeUnitPrice: number,
  unit: PurchaseReturnUnit,
  largeToMedium: number,
  mediumToSmall: number
) {
  return (Number(refundableLargeUnitPrice) || 0)
    / purchaseReturnUnitFactor(unit, largeToMedium, mediumToSmall);
}

export function purchaseReturnRemainingLargeQuantity(
  purchasedLargeQuantity: number,
  previousReturns: Array<{ quantity: number; unit: PurchaseReturnUnit }>,
  largeToMedium: number,
  mediumToSmall: number
) {
  const returnedLarge = previousReturns.reduce((sum, previous) => sum
    + Number(previous.quantity || 0) / purchaseReturnUnitFactor(
      previous.unit,
      largeToMedium,
      mediumToSmall
    ), 0);
  return Math.max(0, Number(purchasedLargeQuantity) - returnedLarge);
}

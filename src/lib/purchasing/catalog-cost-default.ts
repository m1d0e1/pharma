/**
 * A catalogue selling price is never evidence of a supplier's acquisition cost.
 * Only an explicitly recorded, positive, cent-exact base purchase price may
 * populate a prospective purchase line automatically. Zero is intentional:
 * the purchase form must obtain a reviewed supplier cost before final posting.
 */
export function recordedCatalogPurchaseCost(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  if (typeof value === 'string' && !value.trim()) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000 ||
      Math.abs(n * 100 - Math.round(n * 100)) > 0.000001) return 0;
  return n;
}

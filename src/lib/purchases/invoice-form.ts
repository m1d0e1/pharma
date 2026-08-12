export type PurchaseExpiryStatus = 'valid' | 'invalid' | 'expired';

export function clampPurchasePercent(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
}

export function derivePurchaseDiscountPercent(costValue: unknown, sellingValue: unknown): number {
  const cost = Number(costValue);
  const selling = Number(sellingValue);
  if (!Number.isFinite(cost) || !Number.isFinite(selling) || selling <= 0) return 0;
  return clampPurchasePercent(((selling - cost) / selling) * 100);
}

export function getPurchaseExpiryStatus(value: string, today = new Date()): PurchaseExpiryStatus {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return 'invalid';

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return 'invalid';

  const expiry = new Date(year, month - 1, day);
  if (
    expiry.getFullYear() !== year
    || expiry.getMonth() !== month - 1
    || expiry.getDate() !== day
  ) {
    return 'invalid';
  }

  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return expiry < startOfToday ? 'expired' : 'valid';
}

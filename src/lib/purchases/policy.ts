import { isBusinessDate, localDate } from '@/lib/time';

export type PurchasePolicyItem = {
  id?: unknown;
  drug_id?: unknown;
  quantity?: unknown;
  cost_price?: unknown;
  selling_price?: unknown;
  bonus_quantity?: unknown;
  tax_percent?: unknown;
  discount_percent?: unknown;
  expiry_date?: string | null;
  strips_per_box?: unknown;
  large_to_medium?: unknown;
};

export type PurchaseLifecyclePolicyInput = {
  status?: string;
  payment_method?: string;
  check_number?: string;
};

export function normalizePurchaseDateToYMD(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const value = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return isBusinessDate(value) ? value : null;
  let match = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const normalized = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    return isBusinessDate(normalized) ? normalized : null;
  }
  match = value.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (match) {
    const normalized = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    return isBusinessDate(normalized) ? normalized : null;
  }
  match = value.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const normalized = `${match[2]}-${match[1].padStart(2, '0')}-01`;
    return isBusinessDate(normalized) ? normalized : null;
  }
  return null;
}

export function assertCompletedPurchaseExpiryPolicy(
  items: PurchasePolicyItem[],
  today = localDate(),
  nonExpiringDrugIds: ReadonlySet<number> = new Set<number>(),
) {
  for (const item of items) {
    const expiry = normalizePurchaseDateToYMD(item.expiry_date);
    // Persisted purchase rows have their own line id; drug_id is the catalog identity.
    const drugId = Number(item.drug_id ?? item.id);
    if (!expiry) {
      if (nonExpiringDrugIds.has(drugId)) continue;
      throw new Error(`تاريخ الصلاحية مطلوب لفاتورة الشراء المكتملة للصنف ${drugId || ''}`.trim());
    }
    if (expiry < today) {
      throw new Error(`تاريخ الصلاحية منتهي للصنف ${drugId || ''}`.trim());
    }
  }
}

export function purchaseLotIdentity(item: PurchasePolicyItem) {
  // Persisted invoice rows have a line id; only drug_id identifies their drug.
  const drugId = Number(item.drug_id ?? item.id);
  const expiry = normalizePurchaseDateToYMD(item.expiry_date) || '';
  return `${drugId}|${expiry}`;
}

export function assertNoDuplicatePurchaseLots(items: PurchasePolicyItem[]) {
  const seen = new Set<string>();
  for (const item of items) {
    const drugId = Number(item.drug_id ?? item.id);
    const key = purchaseLotIdentity(item);
    if (seen.has(key)) {
      throw new Error(`سطر شراء مكرر للصنف ${drugId || ''} بنفس تاريخ الصلاحية؛ ادمج الكميات في سطر واحد`.trim());
    }
    seen.add(key);
  }
}

export function assertPurchaseLifecyclePolicy(data: PurchaseLifecyclePolicyInput) {
  const status = data.status || 'completed';
  const paymentMethod = data.payment_method || 'credit';
  if (!['draft', 'completed'].includes(status)) {
    throw new Error('Invalid purchase status');
  }
  if (!['cash', 'credit', 'check'].includes(paymentMethod)) {
    throw new Error('Invalid purchase payment method');
  }
  if (status !== 'draft' && paymentMethod === 'check' && !String(data.check_number || '').trim()) {
    throw new Error('رقم الشيك مطلوب لفاتورة الشراء المكتملة');
  }
}

export function assertPurchaseItemsPolicy(
  items: PurchasePolicyItem[],
  status: string = 'completed',
) {
  if (items.length === 0) {
    throw new Error('Purchase items are required');
  }
  const completed = status !== 'draft';
  for (const item of items) {
    const quantity = Number(item.quantity);
    const costPrice = Number(item.cost_price);
    const bonusQuantity = Number(item.bonus_quantity || 0);
    const sellingPrice = item.selling_price == null ? null : Number(item.selling_price);
    const taxPercent = Number(item.tax_percent || 0);
    const discountPercent = Number(item.discount_percent || 0);
    const stripsPerBox = Number(item.strips_per_box || item.large_to_medium || 1);
    if (!Number.isFinite(quantity) || quantity <= 0
      || !Number.isFinite(costPrice) || costPrice < 0
      || (completed && costPrice <= 0)
      || !Number.isFinite(bonusQuantity) || bonusQuantity < 0
      || (sellingPrice != null && (!Number.isFinite(sellingPrice) || sellingPrice < 0))
      || !Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100
      || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100
      || !Number.isFinite(stripsPerBox) || stripsPerBox <= 0) {
      throw new Error('Invalid purchase item values');
    }
  }
}

export function calculatePurchaseAllocation(items: PurchasePolicyItem[], header: Record<string, unknown>) {
  assertPurchaseItemsPolicy(items, 'completed');
  if (['tax_percent', 'expenses', 'discount_value', 'discount_percent'].some(key =>
    !Number.isFinite(Number(header[key] || 0)) || Number(header[key] || 0) < 0)) {
    throw new Error('Invalid purchase tax or discount');
  }
  if (Number(header.tax_percent || 0) > 100 || Number(header.discount_percent || 0) > 100) {
    throw new Error('Purchase tax and discount percentages must not exceed 100');
  }
  const bases = items.map(item => Number(item.quantity || 0) * Number(item.cost_price || 0)
    * (1 + Number(item.tax_percent || 0) / 100)
    * (1 + Number(header.tax_percent || 0) / 100));
  const baseTotal = bases.reduce((sum, value) => sum + value, 0);
  const beforePercentDiscount = baseTotal + Number(header.expenses || 0) - Number(header.discount_value || 0);
  if (beforePercentDiscount < 0) throw new Error('Purchase discount exceeds the item total and expenses');
  const finalTotal = beforePercentDiscount * (1 - Number(header.discount_percent || 0) / 100);
  if (!Number.isFinite(baseTotal) || baseTotal <= 0 || !Number.isFinite(finalTotal) || finalTotal < 0) {
    throw new Error('Purchase total must be finite and nonnegative with a positive item base');
  }
  const paidFactor = finalTotal / baseTotal;
  return {
    finalTotal,
    netUnitCosts: items.map((item, index) => {
      const received = Number(item.quantity || 0) + Number(item.bonus_quantity || 0);
      return received > 0 ? (bases[index] * paidFactor) / received : Number(item.cost_price || 0);
    }),
  };
}

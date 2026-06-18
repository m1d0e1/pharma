import { CartItem, InvoiceHeader } from '@/types/pharmacy';

export interface BillingSummary {
  subtotal: number;
  percentDiscountValue: number;
  itemDiscountsTotal: number;
  total: number;
  itemCount: number;
  totalQty: number;
}

export function calculateItemTotal(item: CartItem): number {
  const base = item.price * item.qty;
  const discount = base * ((item.itemDiscountPercent || 0) / 100);
  return base - discount;
}

export function calculateInvoiceSummary(cart: CartItem[], header: InvoiceHeader): BillingSummary {
  const itemCount = cart.length;
  const totalQty = cart.reduce((sum, item) => sum + item.qty, 0);
  
  // 1. Calculate sum of items after their individual discounts
  const subtotal = cart.reduce((sum, item) => sum + calculateItemTotal(item), 0);
  
  // 2. Global percentage discount
  const percentDiscountValue = (subtotal * (header.discountPercent || 0)) / 100;
  
  // 3. Item discounts for reporting
  const itemDiscountsTotal = cart.reduce((sum, item) => {
    return sum + (item.price * item.qty * (item.itemDiscountPercent || 0) / 100);
  }, 0);

  // 4. Final Total
  const total = subtotal - (header.totalDiscount || 0) - percentDiscountValue + (header.additionalFees || 0);

  return {
    subtotal,
    percentDiscountValue,
    itemDiscountsTotal,
    total,
    itemCount,
    totalQty
  };
}

export interface DrugUnit {
  large: string;
  medium?: string;
  small?: string;
  large_to_medium: number;
  medium_to_small: number;
}

export interface DrugItem {
  id: number;
  trade_name: string;
  trade_name_en?: string;
  active_ingredient: string;
  category: string;
  official_price: number;
  total_stock: number;
  min_price: number;
  cost_price: number;
  profit_margin: number | null;
  nearest_expiry: string | null;
  is_expired: boolean;
  reorder_point: number;
  needs_reorder: boolean;
  units: DrugUnit;
}

export interface CartItem {
  drug_id: number;
  trade_name: string;
  trade_name_en?: string;
  active_ingredient: string;
  qty: number;
  price: number;
  itemDiscountPercent: number;
  needsRefill: boolean;
  selectedUnit: 'large' | 'medium' | 'small';
  basePrice: number;
  units: DrugUnit;
  total_stock: number;
  reorder_point: number;
  nearest_expiry: string | null;
  isNegative?: boolean;
}

export interface Patient {
  id: string;
  full_name: string;
  phone: string;
}

export type PaymentMethod = 'cash' | 'credit' | 'check' | 'visa' | 'delivery';

export interface InvoiceHeader {
  paymentMethod: PaymentMethod;
  checkNumber: string;
  totalDiscount: number;
  discountPercent: number;
  additionalFees: number;
}

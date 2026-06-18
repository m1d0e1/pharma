export interface Supplier {
  id: number;
  name_ar: string;
  name_en?: string;
  balance: number;
  phone?: string;
}

export interface PurchaseItem {
  id: number | string;
  trade_name: string;
  trade_name_en?: string;
  quantity: number | string;
  bonus_quantity: number | string;
  cost_price: number | string;
  selling_price: number | string;
  tax_percent: number | string;
  discount_percent: number | string;
  expiry_date: string;
  official_price: number;
  barcode?: string;
}

export interface PurchaseInvoiceHeader {
  invoice_number: string;
  invoice_date: string;
  payment_method: 'cash' | 'credit' | 'check';
  notes: string;
  check_number: string;
  expenses: number | string;
  discount_value: number | string;
  discount_percent: number | string;
  tax_percent: number | string;
}

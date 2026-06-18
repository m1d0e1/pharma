import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { PurchaseItem, PurchaseInvoiceHeader, Supplier } from '@/types/purchases';

interface PurchaseState {
  cart: PurchaseItem[];
  selectedSupplier: Supplier | null;
  header: PurchaseInvoiceHeader;
  
  // Actions
  setCart: (cart: PurchaseItem[] | ((prev: PurchaseItem[]) => PurchaseItem[])) => void;
  setSelectedSupplier: (supplier: Supplier | null) => void;
  setHeader: (header: Partial<PurchaseInvoiceHeader>) => void;
  resetPurchase: () => void;
}

const initialHeader: PurchaseInvoiceHeader = {
  invoice_number: '',
  invoice_date: new Date().toISOString().split('T')[0],
  payment_method: 'credit',
  notes: '',
  check_number: '',
  expenses: 0,
  discount_value: 0,
  discount_percent: 0,
  tax_percent: 0
};

export const usePurchaseStore = create<PurchaseState>()(
  persist(
    (set) => ({
      cart: [],
      selectedSupplier: null,
      header: initialHeader,

      setCart: (cartUpdate) => set((state) => ({
        cart: typeof cartUpdate === 'function' ? cartUpdate(state.cart) : cartUpdate
      })),
      setSelectedSupplier: (selectedSupplier) => set({ selectedSupplier }),
      setHeader: (headerUpdate) => set((state) => ({
        header: { ...state.header, ...headerUpdate }
      })),
      resetPurchase: () => set({
        cart: [],
        selectedSupplier: null,
        header: initialHeader,
      }),
    }),
    {
      name: 'purchase-storage',
      storage: createJSONStorage(() => localStorage),
    }
  )
);

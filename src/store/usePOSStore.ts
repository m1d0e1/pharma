import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface CartItem {
  id?: string;
  drug_id: string | number;
  trade_name: string;
  trade_name_en?: string;
  active_ingredient?: string;
  qty: number;
  price: number;
  itemDiscountPercent: number;
  basePrice: number;
  selectedUnit: string;
  units: {
    large: string;
    medium?: string;
    small?: string;
    large_to_medium?: number;
    medium_to_small?: number;
  };
  total_stock: number;
  reorder_point?: number;
  nearest_expiry?: string | null;
  needsRefill: boolean;
  batches?: any[];
  inventory_id?: string | null;
  isNegative?: boolean;
}

export interface Patient {
  id: string;
  full_name: string;
  phone?: string | null;
  credit_limit?: number;
  wallet_balance?: number;
  opening_balance?: number;
  outstanding_balance?: number;
  payment_method?: 'cash' | 'credit' | 'visa' | 'wallet';
}

export type POSPaymentMethod = 'cash' | 'credit' | 'check' | 'visa' | 'delivery' | 'wallet';

interface POSState {
  cart: CartItem[];
  selectedPatient: Patient | null;
  paymentMethod: POSPaymentMethod;
  checkNumber: string;
  totalDiscount: number;
  discountPercent: number;
  additionalFees: number;
  
  // Actions
  setCart: (cart: CartItem[] | ((prev: CartItem[]) => CartItem[])) => void;
  setSelectedPatient: (patient: Patient | null | ((prev: Patient | null) => Patient | null)) => void;
  setPaymentMethod: (method: POSPaymentMethod | ((prev: POSPaymentMethod) => POSPaymentMethod)) => void;
  setCheckNumber: (num: string | ((prev: string) => string)) => void;
  setTotalDiscount: (val: number | ((prev: number) => number)) => void;
  setDiscountPercent: (val: number | ((prev: number) => number)) => void;
  setAdditionalFees: (val: number | ((prev: number) => number)) => void;
  resetPOS: () => void;
}

export const usePOSStore = create<POSState>()(
  persist(
    (set) => ({
      cart: [],
      selectedPatient: null,
      paymentMethod: 'cash',
      checkNumber: '',
      totalDiscount: 0,
      discountPercent: 0,
      additionalFees: 0,

      setCart: (cartUpdate) => set((state) => ({
        cart: typeof cartUpdate === 'function' ? cartUpdate(state.cart) : cartUpdate
      })),
      setSelectedPatient: (patientUpdate) => set((state) => ({
        selectedPatient: typeof patientUpdate === 'function' ? patientUpdate(state.selectedPatient) : patientUpdate
      })),
      setPaymentMethod: (methodUpdate) => set((state) => ({
        paymentMethod: typeof methodUpdate === 'function' ? methodUpdate(state.paymentMethod) : methodUpdate
      })),
      setCheckNumber: (numUpdate) => set((state) => ({
        checkNumber: typeof numUpdate === 'function' ? numUpdate(state.checkNumber) : numUpdate
      })),
      setTotalDiscount: (valUpdate) => set((state) => ({
        totalDiscount: typeof valUpdate === 'function' ? valUpdate(state.totalDiscount) : valUpdate
      })),
      setDiscountPercent: (valUpdate) => set((state) => ({
        discountPercent: typeof valUpdate === 'function' ? valUpdate(state.discountPercent) : valUpdate
      })),
      setAdditionalFees: (valUpdate) => set((state) => ({
        additionalFees: typeof valUpdate === 'function' ? valUpdate(state.additionalFees) : valUpdate
      })),
      
      resetPOS: () => set({
        cart: [],
        selectedPatient: null,
        paymentMethod: 'cash',
        checkNumber: '',
        totalDiscount: 0,
        discountPercent: 0,
        additionalFees: 0,
      }),
    }),
    {
      name: 'pharma_pos_draft_v1',
      storage: createJSONStorage(() => localStorage),
    }
  )
);

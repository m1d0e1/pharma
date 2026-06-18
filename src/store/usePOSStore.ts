import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { CartItem, Patient, PaymentMethod, InvoiceHeader } from '@/types/pharmacy';

interface POSState {
  cart: CartItem[];
  selectedPatient: Patient | null;
  paymentMethod: PaymentMethod;
  checkNumber: string;
  totalDiscount: number;
  discountPercent: number;
  additionalFees: number;
  
  // Actions
  setCart: (cart: CartItem[] | ((prev: CartItem[]) => CartItem[])) => void;
  setSelectedPatient: (patient: Patient | null) => void;
  setPaymentMethod: (method: PaymentMethod) => void;
  setCheckNumber: (num: string) => void;
  setTotalDiscount: (val: number) => void;
  setDiscountPercent: (val: number) => void;
  setAdditionalFees: (val: number) => void;
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
      setSelectedPatient: (selectedPatient) => set({ selectedPatient }),
      setPaymentMethod: (paymentMethod) => set({ paymentMethod }),
      setCheckNumber: (checkNumber) => set({ checkNumber }),
      setTotalDiscount: (totalDiscount) => set({ totalDiscount }),
      setDiscountPercent: (discountPercent) => set({ discountPercent }),
      setAdditionalFees: (additionalFees) => set({ additionalFees }),
      
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
      name: 'pos-storage',
      storage: createJSONStorage(() => localStorage),
    }
  )
);

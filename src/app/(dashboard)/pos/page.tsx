'use client';

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useMemo, useCallback, memo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { toast, Toaster } from 'react-hot-toast';
import { ShoppingCart, Search, User, X, Loader2, FileText, Clock, Plus, Printer, Trash2, Maximize2, Minimize2, Calculator, BarChart3, RotateCcw, PlusCircle, Settings, Save, Info } from 'lucide-react';
import nextDynamic from 'next/dynamic';

const ReceiptDetailsModal = nextDynamic(() => import('@/components/receipts/ReceiptDetailsModal'), { ssr: false });
const DrugInteractionModal = nextDynamic(() => import('@/components/pos/DrugInteractionModal'), { ssr: false });
const DrugDetailsModal = nextDynamic(() => import('@/components/pos/DrugDetailsModal'), { ssr: false });
const ReturnsClient = nextDynamic(() => import('@/components/returns/ReturnsClient'), { ssr: false });
const DraftsModal = nextDynamic(() => import('@/components/pos/DraftsModal'), { ssr: false });
const StockWarningModal = nextDynamic(() => import('@/components/pos/StockWarningModal'), { ssr: false });
import { getCurrentUserAction } from '@/app/actions-client/auth';
import { addToShortagesAction } from '@/app/actions-client/shortages';
import { 
  searchDrugsAction, 
  searchPatientsAction, 
  barcodeLookupAction, 
  fetchDraftsAction, 
  processCheckoutAction 
} from '@/app/actions-client/sales';
import { ShieldAlert } from 'lucide-react';
import { checkDrugInteractions } from '@/app/actions-client/interactions';
import AccessDenied from '@/components/AccessDenied';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';



export interface DrugItem {
  id: string | number;
  trade_name: string;
  trade_name_en?: string;
  active_ingredient?: string;
  category?: string;
  official_price: number;
  total_stock: number;
  min_price: number;
  cost_price: number;
  nearest_expiry: string;
  is_expired: boolean;
  large_unit?: string;
  medium_unit?: string;
  small_unit?: string;
  large_to_medium?: number;
  medium_to_small?: number;
  reorder_point?: number;
  profit_margin?: number;
  needs_reorder?: boolean;
  units: {
    large: string;
    medium?: string;
    small?: string;
    large_to_medium?: number;
    medium_to_small?: number;
  };
  batches?: any[];
}

export interface CartItem {
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
  nearest_expiry?: string;
  needsRefill: boolean;
  batches?: any[];
  inventory_id?: string | null;
  isNegative?: boolean;
}

interface Patient {
  id: string;
  full_name: string;
  phone: string;
}

export interface POSSearchSidebarRef {
  clear: () => void;
  focus: () => void;
}

interface POSSearchSidebarProps {
  addToCart: (drug: DrugItem) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const POSSearchSidebar = memo(forwardRef<POSSearchSidebarRef, POSSearchSidebarProps>(
  ({ addToCart, onKeyDown }, ref) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [searchResults, setSearchResults] = useState<DrugItem[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      clear: () => {
        setSearchTerm('');
        setSearchResults([]);
      },
      focus: () => {
        inputRef.current?.focus();
      }
    }));

    useEffect(() => {
      const searchDrugs = async () => {
        if (searchTerm.length < 2) {
          setSearchResults([]);
          return;
        }

        setIsLoading(true);
        try {
          const res = await searchDrugsAction(searchTerm);
          if (res.success) {
            setSearchResults(res.data || []);
          } else {
            setSearchResults([]);
          }
        } catch (error: any) {
          console.error('Drug search error:', error);
          setSearchResults([]);
        } finally {
          setIsLoading(false);
        }
      };

      const timer = setTimeout(searchDrugs, 150);
      return () => {
        clearTimeout(timer);
      };
    }, [searchTerm]);

    return (
      <div className="bg-white dark:bg-slate-900 p-5 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xl flex flex-col min-h-0 flex-1">
        <div className="relative mb-4">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            data-nav="search-input"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchResults.length > 0) {
                addToCart(searchResults[0]);
                setSearchTerm('');
                setSearchResults([]);
              } else if (onKeyDown) {
                onKeyDown(e);
              }
            }}
            placeholder="بحث (اسم أو كود)..."
            className="w-full pr-10 pl-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 font-bold text-sm"
          />
        </div>
        
        <div className="flex-1 overflow-auto space-y-2">
          {isLoading ? (
            <div className="py-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>
          ) : searchResults.map(drug => (
            <button 
              key={drug.id} 
              onClick={() => {
                addToCart(drug);
                setSearchTerm('');
                setSearchResults([]);
              }} 
              className={`w-full flex justify-between items-center p-3 rounded-2xl border text-right transition-all hover:scale-[1.02] active:scale-95 ${
                drug.is_expired ? 'bg-red-50 dark:bg-red-900/10 border-red-100 opacity-60' : 'bg-white dark:bg-slate-800 border-slate-100 dark:border-slate-700'
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="font-bold text-xs truncate text-slate-900 dark:text-white">{drug.trade_name}</p>
                <div className="flex items-center gap-2">
                  <p className="text-[9px] text-slate-400 font-black">{drug.total_stock} متاح | {drug.min_price} ج.م</p>
                  {drug.category && <span className="text-[8px] bg-slate-100 dark:bg-slate-700 px-1 rounded text-slate-500">{drug.category}</span>}
                </div>
              </div>
              {drug.is_expired ? <X className="w-4 h-4 text-red-500" /> : <Plus className="w-4 h-4 text-emerald-500" />}
            </button>
          ))}
        </div>
      </div>
    );
  }
));

POSSearchSidebar.displayName = 'POSSearchSidebar';

export default function POSPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [alternatives, setAlternatives] = useState<DrugItem[]>([]);
  const searchSidebarRef = useRef<POSSearchSidebarRef>(null);

  // Patient Selection
  const [patientSearch, setPatientSearch] = useState('');
  const [patientResults, setPatientResults] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);

  const [completedInvoice, setCompletedInvoice] = useState<any>(null);
  const [currentUserName, setCurrentUserName] = useState('صيدلي');
  const [currentUser, setCurrentUser] = useState<{ id: string; pharmacy_id: string } | null>(null);
  const [isAllowed, setIsAllowed] = useState(false);
  const [isUserLoading, setIsUserLoading] = useState(true);
  const [pendingInteractions, setPendingInteractions] = useState<any[]>([]);
  const [showInteractionModal, setShowInteractionModal] = useState(false);
  const [isCheckingInteractions, setIsCheckingInteractions] = useState(false);

  // Drafts State
  const [drafts, setDrafts] = useState<any[]>([]);
  const [showDraftsModal, setShowDraftsModal] = useState(false);
  const [isLoadingDrafts, setIsLoadingDrafts] = useState(false);

  // Selected Row for deletion
  const [selectedRowId, setSelectedRowId] = useState<string | number | null>(null);

  // Return/Stock Modal State
  const [showStockWarning, setShowStockWarning] = useState<DrugItem | null>(null);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [showDrugDetails, setShowDrugDetails] = useState<string | number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, drugId: string | number } | null>(null);

  // Billing State
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit' | 'check' | 'visa' | 'delivery'>('cash');
  const [checkNumber, setCheckNumber] = useState('');
  const [totalDiscount, setTotalDiscount] = useState(0);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [additionalFees, setAdditionalFees] = useState(0);

  // Dynamic Units
  const [unitsList, setUnitsList] = useState<{name_ar: string}[]>([]);

  useEffect(() => {
    async function fetchUnits() {
      const { getUnitsAction } = await import('@/app/actions-client/master-drugs');
      const res = await getUnitsAction();
      if (res.success && res.data) setUnitsList(res.data);
    }
    fetchUnits();
  }, []);

  // Dynamic navigation sequence helper
  const getNavElements = useCallback(() => {
    const elements: HTMLElement[] = [];
    
    // 1. Search input
    const searchInput = document.querySelector('[data-nav="search-input"]') as HTMLElement;
    if (searchInput) elements.push(searchInput);
    
    // 2. Cart items
    cart.forEach((item, index) => {
      const unitSelect = document.querySelector(`[data-nav="unit-select-${index}"]`) as HTMLElement;
      const qtyInput = document.querySelector(`[data-nav="qty-input-${index}"]`) as HTMLElement;
      const discountInput = document.querySelector(`[data-nav="discount-input-${index}"]`) as HTMLElement;
      
      if (unitSelect) elements.push(unitSelect);
      if (qtyInput) elements.push(qtyInput);
      if (discountInput) elements.push(discountInput);
    });
    
    // 3. Billing inputs
    const patientInput = document.querySelector('[data-nav="patient-input"]') as HTMLElement;
    if (patientInput) elements.push(patientInput);
    
    const feesInput = document.querySelector('[data-nav="additional-fees-input"]') as HTMLElement;
    if (feesInput) elements.push(feesInput);
    
    const discountPercentInput = document.querySelector('[data-nav="discount-percent-input"]') as HTMLElement;
    if (discountPercentInput) elements.push(discountPercentInput);
    
    // 4. Checkout button
    const checkoutBtn = document.querySelector('[data-nav="checkout-button"]') as HTMLElement;
    if (checkoutBtn) elements.push(checkoutBtn);
    
    return elements;
  }, [cart]);

  const handleNavigationKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    
    const elements = getNavElements();
    if (elements.length === 0) return;
    
    const activeEl = document.activeElement as HTMLElement;
    const index = elements.indexOf(activeEl);
    
    if (e.shiftKey) {
      // Shift + Tab: go backwards
      e.preventDefault();
      const prevIndex = index <= 0 ? elements.length - 1 : index - 1;
      elements[prevIndex].focus();
      if ('select' in elements[prevIndex]) {
        (elements[prevIndex] as any).select();
      }
    } else {
      // Tab: go forwards
      e.preventDefault();
      const nextIndex = index === -1 || index === elements.length - 1 ? 0 : index + 1;
      elements[nextIndex].focus();
      if ('select' in elements[nextIndex]) {
        (elements[nextIndex] as any).select();
      }
    }
  }, [getNavElements]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      handleNavigationKey(e);
    } else if (e.key === 'Enter') {
      const activeEl = document.activeElement as HTMLElement;
      const navAttr = activeEl.getAttribute('data-nav');
      if (navAttr && (
        navAttr.startsWith('qty-input-') || 
        navAttr.startsWith('discount-input-') || 
        navAttr === 'additional-fees-input' || 
        navAttr === 'discount-percent-input'
      )) {
        e.preventDefault();
        const searchInput = document.querySelector('[data-nav="search-input"]') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }
    }
  }, [handleNavigationKey]);

  useEffect(() => {
    async function loadUser() {
      const userObj = await getClientSession();
      if (!userObj) {
        setIsUserLoading(false);
        router.push('/login');
        return;
      }

      setIsAllowed(hasUserPermissionSync(userObj, 'can_access_pos') || userObj.role === 'pharmacist' || userObj.role === 'owner' || userObj.role === 'admin');

      const res = await getCurrentUserAction();
      if (res.success && res.user) {
        setCurrentUserName(res.user.full_name);
        setCurrentUser({ id: res.user.id, pharmacy_id: res.user.pharmacy_id });
      }
      setIsUserLoading(false);
    }
    loadUser();

    // Auto-focus barcode/drug search box on load
    setTimeout(() => {
      searchSidebarRef.current?.focus();
    }, 150);
  }, [router]);

  useEffect(() => {
    if (searchParams.get('tab') === 'drafts') {
      setShowDraftsModal(true);
    }
  }, [searchParams]);

  // Global Keydown for Delete
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedRowId !== null) {
        // Prevent deleting if typing in an input
        if (document.activeElement?.tagName === 'INPUT') return;
        setCart(prev => prev.filter(i => String(i.drug_id) !== String(selectedRowId)));
        setSelectedRowId(null);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [selectedRowId]);



  // Search Patients
  useEffect(() => {
    const searchPatients = async () => {
      if (patientSearch.length < 2) {
        setPatientResults([]);
        return;
      }

      try {
        const res = await searchPatientsAction(patientSearch);
        if (res.success) {
          setPatientResults(res.data || []);
        } else {
          setPatientResults([]);
        }
      } catch (error) {
        console.error('Patient search error:', error);
        setPatientResults([]);
      }
    };
    const timer = setTimeout(searchPatients, 300);
    return () => clearTimeout(timer);
  }, [patientSearch]);

  const addToCart = useCallback((drug: DrugItem) => {
    if (drug.is_expired) {
      toast.error(`⛔ الصنف "${drug.trade_name_en || drug.trade_name}" منتهي الصلاحية ولا يمكن بيعه`);
      return;
    }

    if (drug.total_stock <= 0) {
      setShowStockWarning(drug);
      return;
    }

    const drugId = String(drug.id);

    setCart(prev => {
      const existing = prev.find(i => String(i.drug_id) === drugId);
      if (existing) {
        return prev.map(i => String(i.drug_id) === drugId ? { ...i, qty: i.qty + 1 } : i);
      }
      return [...prev, { 
        drug_id: drugId, 
        trade_name: drug.trade_name, 
        trade_name_en: drug.trade_name_en,
        active_ingredient: drug.active_ingredient,
        qty: 1, 
        price: drug.min_price, 
        itemDiscountPercent: 0,
        basePrice: drug.min_price,
        selectedUnit: 'large',
        units: drug.units,
        total_stock: drug.total_stock,
        reorder_point: drug.reorder_point,
        nearest_expiry: drug.nearest_expiry,
        batches: drug.batches || [],
        inventory_id: null,
        needsRefill: false 
      }];
    });
  }, []);

  const handleUnitChange = useCallback((drugId: string | number, unit: string) => {
    setCart(prev => prev.map(item => {
      if (String(item.drug_id) !== String(drugId)) return item;
      
      let newPrice = item.basePrice;
      if (unit === item.units.medium || unit === 'medium') {
        newPrice = item.basePrice / (item.units.large_to_medium || 1);
      } else if (unit === item.units.small || unit === 'small') {
        newPrice = item.basePrice / ((item.units.large_to_medium || 1) * (item.units.medium_to_small || 1));
      }
      
      return { ...item, selectedUnit: unit as any, price: Number(newPrice.toFixed(2)) };
    }));
  }, []);

  const handleBatchChange = useCallback((drugId: string | number, inventoryId: string) => {
    setCart(prev => prev.map(item => {
      if (String(item.drug_id) !== String(drugId)) return item;
      
      const batchId = inventoryId === 'auto' ? null : inventoryId;
      let newPrice = item.price;
      
      if (batchId && item.batches) {
        const batch = item.batches.find((b: any) => String(b.inventory_id) === String(batchId));
        if (batch && batch.unit_price) {
          // Calculate price based on selected unit
          let basePrice = batch.unit_price;
          if (item.selectedUnit === item.units.medium || item.selectedUnit === 'medium') {
            basePrice = basePrice / (item.units.large_to_medium || 1);
          } else if (item.selectedUnit === item.units.small || item.selectedUnit === 'small') {
            basePrice = basePrice / ((item.units.large_to_medium || 1) * (item.units.medium_to_small || 1));
          }
          newPrice = basePrice;
        }
      }
      
      return { ...item, inventory_id: batchId, price: Number(newPrice.toFixed(2)) };
    }));
  }, []);

  const resetCart = useCallback(() => {
    if (cart.length > 0 && !confirm('هل أنت متأكد من مسح السلة وبدء فاتورة جديدة؟')) return;
    setCart([]);
    setSelectedPatient(null);
    setTotalDiscount(0);
    setDiscountPercent(0);
    setAdditionalFees(0);
    setPaymentMethod('cash');
  }, [cart]);

  const handleCheckout = async (status: 'completed' | 'draft' = 'completed', force = false) => {
    if (cart.length === 0) return;
    setIsProcessing(true);

    try {
      const token = localStorage.getItem('token');
      const currentShiftId = localStorage.getItem('current_shift_id');

      let interactionRes: any = { interactions: [] };
      let clinicalAlerts: any[] = [];

      if (status === 'completed' && !force) {
        const ingredients = cart.map(i => i.active_ingredient);
        
        const safetyRes = await checkDrugInteractions(ingredients, selectedPatient?.id);
        if (safetyRes.success && safetyRes.data) {
          interactionRes = { success: true, interactions: safetyRes.data.interactions };
          clinicalAlerts = safetyRes.data.allergies;
        }

        if ((interactionRes.interactions && interactionRes.interactions.length > 0) || clinicalAlerts.length > 0) {
          // Merge alerts into one view for the pharmacist
          const allAlerts = [
            ...(interactionRes.interactions || []).map((i: any) => ({ ...i, type: 'interaction' })),
            ...clinicalAlerts
          ];
          setPendingInteractions(allAlerts);
          setShowInteractionModal(true);
          setIsProcessing(false);
          return;
        }
      }

      const formattedCart = cart.map(item => ({
        drug_id: item.drug_id,
        inventory_id: item.inventory_id || null,
        quantity_sold: item.qty,
        unit_price: item.price,
        selected_unit: item.selectedUnit,
        is_negative: item.isNegative || false
      }));

      const result = await processCheckoutAction({
        items: formattedCart,
        patient_id: selectedPatient?.id,
        shift_id: currentShiftId || undefined,
        payment_method: paymentMethod,
        check_number: paymentMethod === 'check' ? checkNumber : undefined,
        status,
        total_discount: totalDiscount + percentDiscountValue,
        additional_fees: additionalFees,
      });

      if (result.success) {
        toast.success(status === 'draft' ? 'تم حفظ المسودة بنجاح' : 'تمت العملية بنجاح!');
        
        if (status === 'completed' && result.data) {
          const invoice = {
            id: result.data.sale_id,
            total_amount: total,
            created_at: new Date().toISOString(),
            payment_method: paymentMethod,
            profiles: { full_name: currentUserName },
            patients: selectedPatient ? { full_name: selectedPatient.full_name, phone: selectedPatient.phone } : null,
            sales_items: cart.map(item => ({
              quantity_sold: item.qty,
              unit_price: item.price,
              unit: item.selectedUnit,
              units: item.units,
              inventory: { master_drugs: { trade_name: item.trade_name, trade_name_en: item.trade_name_en } }
            }))
          };
          setCompletedInvoice(invoice);

          // Trigger financial snapshot update
          import('@/app/actions-client/finance').then(mod => mod.generateDailySnapshotAction());
        }
        
        setCart([]);
        setSelectedPatient(null);
        setPaymentMethod('cash');
        setCheckNumber('');
        setTotalDiscount(0);
        setDiscountPercent(0);
        setAdditionalFees(0);
      } else {
        toast.error(result.error || 'فشلت العملية');
      }
    } catch (error) {
      console.error('Checkout error:', error);
      toast.error('فشلت العملية');
    } finally {
      setIsProcessing(false);
    }
  };

  const fetchDrafts = async () => {
    setIsLoadingDrafts(true);
    try {
      const result = await fetchDraftsAction();
      if (result.success) {
        setDrafts(result.data || []);
      } else {
        toast.error(result.error || 'فشل تحميل المسودات');
      }
    } catch (error) {
      console.error('Fetch drafts error:', error);
    } finally {
      setIsLoadingDrafts(false);
    }
  };

  const loadDraft = (draft: any) => {
    if (cart.length > 0 && !confirm('سلة المبيعات ليست فارغة. هل تريد استبدالها بالمسودة؟')) return;

    setCart(draft.items.map((item: any) => ({
      ...item,
      drug_id: String(item.drug_id),
      itemDiscountPercent: item.itemDiscountPercent || 0,
      total_stock: item.total_stock || 0,
      reorder_point: item.reorder_point || 0,
      nearest_expiry: null,
      needsRefill: false
    })));

    if (draft.patient_id) {
      setSelectedPatient({
        id: draft.patient_id,
        full_name: draft.patient_name || 'مريض غير معروف',
        phone: ''
      });
    } else {
      setSelectedPatient(null);
    }

    setPaymentMethod(draft.payment_method);
    setTotalDiscount(draft.discount_amount || 0);
    setShowDraftsModal(false);
    toast.success('تم تحميل المسودة');
  };

  useBarcodeScanner(async (barcode) => {
    if (showReturnModal) return; // Let Return modal handle it
    try {
      const res = await barcodeLookupAction(barcode);
      if (res.success && res.data) {
        const drug = res.data;
        addToCart({
          ...drug,
          reorder_point: drug.reorder_point || 0,
          nearest_expiry: drug.nearest_expiry || null,
          total_stock: drug.quantity || 0,
          min_price: drug.unit_price || drug.official_price,
          is_expired: drug.is_expired
        });
      } else {
        toast.error('المنتج غير موجود');
      }
    } catch (error) {
      console.error('Barcode scan error:', error);
    }
  });

  const subtotal = useMemo(() => {
    return cart.reduce((s, i) => s + (i.price * i.qty * (1 - (i.itemDiscountPercent || 0) / 100)), 0);
  }, [cart]);

  const percentDiscountValue = useMemo(() => {
    return (subtotal * discountPercent) / 100;
  }, [subtotal, discountPercent]);

  const total = useMemo(() => {
    return subtotal - totalDiscount - percentDiscountValue + additionalFees;
  }, [subtotal, totalDiscount, percentDiscountValue, additionalFees]);

  const handleContextMenu = (e: React.MouseEvent, drugId: string | number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, drugId });
  };

  const closeContextMenu = () => setContextMenu(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2' && selectedRowId) {
        e.preventDefault();
        setShowDrugDetails(selectedRowId);
      }
      if (e.key === 'F9' && selectedRowId) {
        e.preventDefault();
        addToShortagesAction({ drug_id: selectedRowId }).then(res => {
          if (res.success) toast.success('تمت الإضافة إلى النواقص');
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedRowId]);

  useEffect(() => {
    const handleClick = () => closeContextMenu();
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  if (isUserLoading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!isAllowed) {
    return <AccessDenied />;
  }

  return (
    <div className="flex flex-1 min-h-0 gap-3 font-sans" dir="rtl">
      <Toaster position="top-center" />

      {/* LEFT SIDEBAR ACTIONS */}
      <div className="w-20 flex flex-col gap-2 bg-white dark:bg-slate-900 p-2 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xl overflow-y-auto shrink-0">
        <SidebarButton icon={Plus} label="جديد" color="bg-emerald-500" onClick={resetCart} />
        <SidebarButton icon={Save} label="حفظ" color="bg-blue-500" onClick={() => handleCheckout('draft')} />
        <SidebarButton icon={Printer} label="طباعة" color="bg-indigo-500" onClick={() => handleCheckout('completed')} />
        <SidebarButton 
          icon={ShieldAlert} 
          label="فحص التداخلات" 
          color="bg-rose-600" 
          onClick={async () => {
            if (cart.length < 2) {
              toast.error('يجب إضافة صنفين على الأقل للفحص');
              return;
            }
            setIsCheckingInteractions(true);
            const checkToast = toast.loading('جاري فحص السلامة الدوائية...');
            try {
              const ingredients = cart.map(i => i.active_ingredient);
              const safetyRes = await checkDrugInteractions(ingredients, selectedPatient?.id);
              
              const allAlerts: any[] = [];
              if (safetyRes.success && safetyRes.data) {
                allAlerts.push(...(safetyRes.data.interactions || []).map((i: any) => ({ ...i, type: 'interaction' })));
                allAlerts.push(...(safetyRes.data.allergies || []).map((i: any) => ({ ...i, type: 'allergy' })));
              }

              if (allAlerts.length > 0) {
                setPendingInteractions(allAlerts);
                setShowInteractionModal(true);
                toast.success('تم العثور على تنبيهات طبية', { id: checkToast });
              } else {
                toast.success('لا توجد تداخلات دوائية معروفة في هذه الفاتورة', { id: checkToast });
              }
            } catch (err) {
              toast.error('فشل عملية الفحص', { id: checkToast });
            } finally {
              setIsCheckingInteractions(false);
            }
          }} 
        />
        <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />
        <SidebarButton icon={FileText} label="فواتير معلقة" color="bg-amber-500" onClick={() => { fetchDrafts(); setShowDraftsModal(true); }} />
        <SidebarButton icon={RotateCcw} label="استرجاع" color="bg-rose-500" onClick={() => setShowReturnModal(true)} />
        <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />
        <SidebarButton icon={User} label="عميل جديد" color="bg-purple-500" onClick={() => setPatientSearch('')} />
        <SidebarButton icon={PlusCircle} label="إضافة صنف" color="bg-slate-700" onClick={() => { searchSidebarRef.current?.clear(); searchSidebarRef.current?.focus(); }} />
        <div className="mt-auto pt-3 border-t border-slate-100 dark:border-slate-800">
          <SidebarButton icon={Calculator} label="آلة حاسبة" color="bg-slate-600" onClick={() => window.open('https://www.google.com/search?q=calculator', '_blank')} />
          <SidebarButton icon={BarChart3} label="تقارير" color="bg-slate-600" onClick={() => router.push('/reports')} />
          <SidebarButton icon={Settings} label="خيارات" color="bg-slate-600" />
        </div>
      </div>
      
      {/* Main Center Area */}
      <div className="flex-1 flex flex-col gap-3 min-w-0 min-h-0">
        
        {/* Top Invoice Info Header */}
        <div className="bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-lg grid grid-cols-4 gap-4">
          <div className="col-span-1 space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">بيانات العميل</label>
            {selectedPatient ? (
              <div className="flex items-center justify-between bg-purple-50 dark:bg-purple-900/20 p-2 rounded-xl border border-purple-100 dark:border-purple-800">
                <span className="font-bold text-xs text-purple-700 dark:text-purple-300 truncate">👤 {selectedPatient.full_name}</span>
                <button onClick={() => setSelectedPatient(null)} className="text-purple-400 hover:text-purple-900">×</button>
              </div>
            ) : (
              <div className="relative">
                <input 
                  type="text" 
                  placeholder="بحث عن عميل..."
                  value={patientSearch}
                  onChange={(e) => setPatientSearch(e.target.value)}
                  data-nav="patient-input"
                  onKeyDown={handleInputKeyDown}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 dark:text-white rounded-xl px-3 py-2 text-xs font-bold outline-none focus:ring-2 focus:ring-purple-500"
                />
                {(patientResults.length > 0 || (patientSearch.length >= 2)) && (
                  <div className="absolute top-full left-0 right-0 bg-white dark:bg-slate-800 shadow-2xl rounded-2xl mt-2 z-50 border border-slate-100 dark:border-slate-700 p-2">
                    {patientResults.map(p => (
                      <button 
                        key={p.id}
                        onClick={() => { setSelectedPatient(p); setPatientResults([]); setPatientSearch(''); }}
                        className="w-full text-right p-3 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl text-xs font-bold"
                      >
                        {p.full_name} ({p.phone})
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="col-span-2 space-y-1">
             <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">نوع الفاتورة (طريقة الدفع)</label>
             <div className="flex gap-2">
                {[
                  { id: 'cash', label: 'كاش', icon: '💵', color: 'emerald' },
                  { id: 'credit', label: 'آجل', icon: '💳', color: 'blue' },
                  { id: 'visa', label: 'فيزا', icon: '🏧', color: 'indigo' },
                  { id: 'delivery', label: 'توصيل', icon: '🛵', color: 'rose' }
                ].map(method => (
                  <button 
                    key={method.id}
                    onClick={() => setPaymentMethod(method.id as any)}
                    className={`flex-1 py-2 rounded-xl font-black text-xs transition-all border ${
                      paymentMethod === method.id 
                        ? `bg-${method.color}-500 text-white border-${method.color}-600 shadow-lg` 
                        : 'bg-white dark:bg-slate-800 text-slate-600 border-slate-100 dark:border-slate-800'
                    }`}
                  >
                    {method.icon} {method.label}
                  </button>
                ))}
             </div>
          </div>

          <div className="col-span-1 grid grid-cols-2 gap-3">
             <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-400">م. إضافية</label>
                <input 
                  type="number"
                  value={additionalFees}
                  onChange={(e) => setAdditionalFees(Number(e.target.value))}
                  data-nav="additional-fees-input"
                  onKeyDown={handleInputKeyDown}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 p-2 rounded-xl text-xs font-black text-center"
                />
             </div>
             <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-400">خصم %</label>
                <input 
                  type="number"
                  value={discountPercent}
                  onChange={(e) => setDiscountPercent(Number(e.target.value))}
                  data-nav="discount-percent-input"
                  onKeyDown={handleInputKeyDown}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 p-2 rounded-xl text-xs font-black text-center text-rose-500"
                />
             </div>
          </div>
        </div>

        {/* Main Items Table */}
        <div className="flex-1 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden flex flex-col min-h-0">
          <div className="overflow-x-auto overflow-y-auto flex-1">
            <table className="w-full text-right border-collapse min-w-full">
              <thead className="border-b border-slate-200 dark:border-slate-700">
                <tr>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase w-10 text-center">ك. الصنف</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1.5 py-2 text-[9px] font-black text-slate-500 uppercase text-right">أسم الصنف</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase w-12 text-center">الوحدة</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase w-16 text-center">ت. الصلاحية</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase w-20 text-center">الكمية</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase w-12 text-center">س. البيع</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase w-10 text-center">الرصيد</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase w-10 text-center">حد الطلب</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase w-12 text-center">خصم</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[9px] font-black text-slate-500 uppercase text-left w-16">الإجمالي</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                {cart.map((item, index) => (
                  <tr 
                    key={`${item.drug_id}-${index}`} 
                    onClick={() => setSelectedRowId(String(item.drug_id))}
                    onContextMenu={(e) => handleContextMenu(e, String(item.drug_id))}
                    className={`group hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer ${String(selectedRowId) === String(item.drug_id) ? 'bg-blue-50/50 dark:bg-blue-900/20 ring-1 ring-inset ring-blue-500/20' : ''}`}
                  >
                    <td className="px-1 py-2 text-[9px] font-bold text-slate-400 text-center w-10">#{item.drug_id}</td>
                    <td className="px-1.5 py-2 text-right">
                      <p className="font-bold text-xs line-clamp-1">{item.trade_name_en || item.trade_name}</p>
                      <p className="text-[9px] text-slate-400 font-medium truncate max-w-[150px]">{item.active_ingredient}</p>
                    </td>
                    <td className="px-1 py-2 text-center w-12">
                      <select 
                        value={item.selectedUnit}
                        onChange={(e) => handleUnitChange(item.drug_id, e.target.value)}
                        data-nav={`unit-select-${index}`}
                        onKeyDown={handleInputKeyDown}
                        className="bg-transparent border-none text-[9px] font-black outline-none cursor-pointer text-blue-600 focus:ring-1 focus:ring-blue-500 rounded px-0.5"
                      >
                        <option value="large">{item.units.large || 'علبة'}</option>
                        {item.units.medium && <option value="medium">{item.units.medium}</option>}
                        {item.units.small && <option value="small">{item.units.small}</option>}
                      </select>
                    </td>
                    <td className="px-1 py-2 text-center w-24">
                      {item.batches && item.batches.length > 1 ? (
                        <select
                          value={item.inventory_id || 'auto'}
                          onChange={(e) => handleBatchChange(item.drug_id, e.target.value)}
                          className="w-full bg-slate-50 dark:bg-slate-800 border-none p-1 rounded text-[9px] font-bold focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="auto">تلقائي ({item.nearest_expiry || '---'})</option>
                          {item.batches.map((b: any) => (
                            <option key={b.inventory_id} value={b.inventory_id}>
                              {b.expiry_date || 'بدون'} (كمية: {b.quantity})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`text-[8px] font-bold px-1 py-0.5 rounded-full ${
                          item.nearest_expiry && new Date(item.nearest_expiry) < new Date() ? 'bg-red-100 text-red-600' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                        }`}>
                          {item.nearest_expiry || '---'}
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-center w-20">
                      <div className="flex items-center justify-center gap-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5 w-20 mx-auto font-sans">
                        <button tabIndex={-1} onClick={() => setCart(p => p.map(i => String(i.drug_id) === String(item.drug_id) ? {...i, qty: Math.max(1, i.qty-1)} : i))} className="w-4 h-4 flex items-center justify-center hover:bg-white dark:hover:bg-slate-700 rounded text-slate-500 font-bold text-xs">-</button>
                        <input 
                          type="number" 
                          value={item.qty} 
                          data-qty-input="true"
                          data-nav={`qty-input-${index}`}
                          onChange={(e) => {
                            const newQty = parseInt(e.target.value);
                            setCart(p => p.map(i => String(i.drug_id) === String(item.drug_id) ? {...i, qty: isNaN(newQty) ? 1 : Math.max(1, newQty)} : i))
                          }}
                          onKeyDown={handleInputKeyDown}
                          className="w-8 bg-transparent text-center font-bold text-xs outline-none focus:ring-1 focus:ring-blue-500 rounded p-0 text-[10px]"
                        />
                        <button tabIndex={-1} onClick={() => setCart(p => p.map(i => String(i.drug_id) === String(item.drug_id) ? {...i, qty: i.qty+1} : i))} className="w-4 h-4 flex items-center justify-center hover:bg-white dark:hover:bg-slate-700 rounded text-slate-500 font-bold text-xs">+</button>
                      </div>
                    </td>
                    <td className="px-1 py-2 text-center font-black text-[11px] w-12">{item.price}</td>
                    <td className="px-1 py-2 text-center w-10">
                       <span className={`text-[9px] font-black ${item.total_stock <= (item.reorder_point || 0) ? 'text-red-500' : 'text-slate-400'}`}>
                        {item.total_stock}
                       </span>
                    </td>
                    <td className="px-1 py-2 text-center text-[9px] font-bold text-slate-400 w-10">{item.reorder_point || 0}</td>
                    <td className="px-1 py-2 text-center w-12">
                      <input 
                        type="number"
                        value={item.itemDiscountPercent || 0}
                        onChange={(e) => setCart(p => p.map(i => String(i.drug_id) === String(item.drug_id) ? {...i, itemDiscountPercent: Number(e.target.value)} : i))}
                        data-nav={`discount-input-${index}`}
                        onKeyDown={handleInputKeyDown}
                        className="w-12 bg-slate-50 dark:bg-slate-800 border-none p-0.5 rounded text-[9px] font-black text-center text-rose-500 focus:ring-2 focus:ring-rose-500"
                        placeholder="%"
                      />
                    </td>
                    <td className="px-1 py-2 text-left font-black text-blue-600 text-[11px] w-16">
                      {(item.price * item.qty * (1 - (item.itemDiscountPercent || 0) / 100)).toFixed(2)}
                    </td>
                    <td className="px-1 py-2 text-left w-8">
                      <button tabIndex={-1} onClick={() => setCart(p => p.filter(i => String(i.drug_id) !== String(item.drug_id)))} className="p-1 text-red-300 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-all opacity-0 group-hover:opacity-100">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Table Totals Bar */}
          <div className="bg-slate-50 dark:bg-slate-800/50 p-4 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center">
              <div className="flex gap-8">
              <TotalLabel label="عدد الأصناف" value={cart.length} />
              <TotalLabel label="إجمالي الكميات" value={cart.reduce((s, i) => s + i.qty, 0)} />
              <TotalLabel label="إجمالي الخصم" value={(totalDiscount + percentDiscountValue + cart.reduce((s,i) => s + (i.price * i.qty * (i.itemDiscountPercent || 0) / 100), 0)).toFixed(2)} color="text-rose-500" />
            </div>
            <div className="flex items-center gap-4">
               <div className="text-right">
                  <p className="text-[10px] font-black text-slate-400">المبلغ الإجمالي</p>
                  <p className="text-2xl font-black text-emerald-500">{total.toLocaleString('en-US')} ج.م</p>
               </div>
               <button 
                 onClick={() => handleCheckout('completed')} 
                 disabled={isProcessing || cart.length === 0} 
                 data-nav="checkout-button"
                 onKeyDown={handleInputKeyDown}
                 className="px-10 py-4 bg-emerald-500 text-white rounded-2xl font-black text-lg hover:bg-emerald-400 transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-2"
               >
                 {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />}
                 إتمام وطباعة
               </button>
            </div>
          </div>
        </div>
      </div>

      {/* Right Search Area */}
      <div className="w-[300px] flex flex-col gap-4 shrink-0">
         <POSSearchSidebar ref={searchSidebarRef} addToCart={addToCart} onKeyDown={handleInputKeyDown} />

         {alternatives.length > 0 && (
            <div className="bg-indigo-50 dark:bg-indigo-900/20 p-5 rounded-3xl border border-indigo-100 dark:border-indigo-900/40">
              <h4 className="font-black text-indigo-900 dark:text-indigo-200 text-[10px] mb-3 flex items-center gap-2 uppercase tracking-widest">🧬 بدائل مقترحة</h4>
              <div className="space-y-2 max-h-[200px] overflow-auto">
                {[...alternatives].sort((a, b) => (b.total_stock || 0) - (a.total_stock || 0)).map(a => (
                  <button key={a.id} onClick={() => addToCart(a)} className="w-full flex justify-between items-center bg-white dark:bg-slate-800 p-2 rounded-xl text-[10px] font-black shadow-sm">
                    <div className="flex flex-col text-right">
                      <span className="dark:text-white truncate max-w-[150px]">{a.trade_name_en || a.trade_name}</span>
                      <span className="text-slate-400">{a.total_stock} in stock</span>
                    </div>
                    <span className="text-emerald-600">{a.min_price} EGP</span>
                  </button>
                ))}
              </div>
            </div>
         )}
      </div>

      {completedInvoice && (
        <ReceiptDetailsModal 
          invoice={completedInvoice} 
          onClose={() => setCompletedInvoice(null)} 
        />
      )}
      {showInteractionModal && (
        <DrugInteractionModal 
          alerts={pendingInteractions}
          onClose={() => setShowInteractionModal(false)}
          onConfirm={() => {
            setShowInteractionModal(false);
            handleCheckout('completed', true);
          }}
        />
      )}

      {showDraftsModal && <DraftsModal
        isOpen={showDraftsModal}
        onClose={() => setShowDraftsModal(false)}
        drafts={drafts}
        isLoadingDrafts={isLoadingDrafts}
        onLoadDraft={loadDraft}
      />}

      {!!showStockWarning && <StockWarningModal
        isOpen={!!showStockWarning}
        onClose={() => setShowStockWarning(null)}
        drug={showStockWarning}
        onNewPurchaseOrder={(drugId) => {
          toast.success('جاري الانتقال لإنشاء فاتورة شراء...');
          setShowStockWarning(null);
          router.push(`/purchases/new?drugId=${drugId}`);
        }}
        onNegativeSale={(drug) => {
          const drugId = String(drug.id);
          setCart(prev => {
            const existing = prev.find(i => String(i.drug_id) === drugId);
            if (existing) return prev.map(i => String(i.drug_id) === drugId ? { ...i, qty: i.qty + 1 } : i);
            return [...prev, {
              drug_id: drugId,
              trade_name: drug.trade_name,
              trade_name_en: drug.trade_name_en,
              active_ingredient: drug.active_ingredient,
              qty: 1,
              price: drug.min_price || drug.official_price,
              itemDiscountPercent: 0,
              basePrice: drug.min_price || drug.official_price,
              selectedUnit: 'large',
              units: drug.units,
              total_stock: 0,
              reorder_point: drug.reorder_point,
              nearest_expiry: drug.nearest_expiry,
              needsRefill: false,
              isNegative: true
            }];
          });
          setShowStockWarning(null);
          toast.success('تمت الإضافة (بيع بدون رصيد)');
        }}
      />}

      {showReturnModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
          <div className="bg-slate-50 dark:bg-slate-950 rounded-[40px] w-full max-w-[95vw] h-[90vh] shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-white dark:bg-slate-900">
              <div>
                <h3 className="text-2xl font-black flex items-center gap-3">
                  <RotateCcw className="w-7 h-7 text-rose-500" /> اختصار المرتجع السريع
                </h3>
                <p className="text-slate-500 font-bold text-sm">ابحث عن الفاتورة أو امسح الباركود للبدء</p>
              </div>
              <button 
                onClick={() => setShowReturnModal(false)} 
                className="p-3 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-2xl transition-all"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="flex-1 overflow-auto p-8">
               <ReturnsClient title="مرتجعات المبيعات" />
            </div>

            <div className="p-6 bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 text-center">
              <button 
                onClick={() => setShowReturnModal(false)}
                className="px-10 py-4 bg-slate-800 text-white rounded-2xl font-black hover:bg-slate-700 transition-all"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Item Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-[300] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden w-64 animate-in fade-in zoom-in duration-200"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className="p-2 space-y-1">
            <ContextMenuItem 
              icon={Info} 
              label="معلومات الصنف (F2)" 
              onClick={() => setShowDrugDetails(contextMenu.drugId)} 
            />
            <ContextMenuItem 
              icon={PlusCircle} 
              label="إضافة إلى النواقص (F9)" 
              onClick={async () => {
                const res = await addToShortagesAction({ drug_id: contextMenu.drugId });
                if (res.success) toast.success('تمت الإضافة إلى النواقص');
                else toast.error((res as any).error);
              }} 
            />
            <ContextMenuItem 
              icon={Settings} 
              label="تعديل كارت الصنف" 
              onClick={() => router.push(`/stores/items?edit=${contextMenu.drugId}`)} 
            />
            <div className="h-px bg-slate-100 dark:bg-slate-800 my-1 mx-2" />
            <ContextMenuItem 
              icon={Trash2} 
              label="حذف من الفاتورة (Del)" 
              color="text-red-500"
              onClick={() => setCart(p => p.filter(i => String(i.drug_id) !== String(contextMenu.drugId)))} 
            />
          </div>
        </div>
      )}

      {/* Drug Details Modal */}
      {showDrugDetails && (
        <DrugDetailsModal 
          drugId={showDrugDetails} 
          onClose={() => setShowDrugDetails(null)} 
        />
      )}
    </div>
  );
}

function ContextMenuItem({ icon: Icon, label, onClick, color = "text-slate-700 dark:text-slate-300" }: any) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-all text-right font-bold text-xs ${color}`}
    >
      <Icon className="w-4 h-4 opacity-50" />
      <span>{label}</span>
    </button>
  );
}

// Helper Components
function SidebarButton({ icon: Icon, label, color, onClick }: any) {
  return (
    <button 
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-0.5 p-1 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all group w-full"
    >
      <div className={`p-2 rounded-lg ${color} text-white shadow-sm group-hover:scale-110 transition-transform`}>
        <Icon className="w-4 h-4" />
      </div>
      <span className="text-[8px] font-black text-slate-500 dark:text-slate-400 text-center leading-tight truncate w-full">{label}</span>
    </button>
  );
}

function TotalLabel({ label, value, color = "text-slate-600 dark:text-slate-300" }: any) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-black ${color}`}>{value}</span>
    </div>
  );
}

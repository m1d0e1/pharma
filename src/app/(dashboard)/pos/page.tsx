'use client';

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useMemo, useCallback, memo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { toast, Toaster } from 'react-hot-toast';
import { ShoppingCart, Search, User, X, Loader2, FileText, Clock, Plus, Trash2, Maximize2, Minimize2, Calculator, BarChart3, RotateCcw, PlusCircle, Settings, Save, Info, ArrowLeftRight, Banknote, CreditCard, Wallet, Truck, Pill } from 'lucide-react';
import nextDynamic from 'next/dynamic';
import { useHotkeys } from 'react-hotkeys-hook';

const ReceiptDetailsModal = nextDynamic(() => import('@/components/receipts/ReceiptDetailsModal'), { ssr: false });
const DrugInteractionModal = nextDynamic(() => import('@/components/pos/DrugInteractionModal'), { ssr: false });
const DrugDetailsModal = nextDynamic(() => import('@/components/pos/DrugDetailsModal'), { ssr: false });
const ReturnsClient = nextDynamic(() => import('@/components/returns/ReturnsClient'), { ssr: false });
const DraftsModal = nextDynamic(() => import('@/components/pos/DraftsModal'), { ssr: false });
const StockWarningModal = nextDynamic(() => import('@/components/pos/StockWarningModal'), { ssr: false });
const PosDrawerHandoverModal = nextDynamic(() => import('@/components/pos/PosDrawerHandoverModal'), { ssr: false });
const AddPatientModal = nextDynamic(() => import('@/components/AddPatientModal'), { ssr: false });
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
import { usePOSStore } from '@/store/usePOSStore';
import { subscribeDrugIdentityChanges, subscribeInventoryChanges } from '@/lib/inventory/refresh';
import { EGP_PER_REDEEMED_POINT, MIN_REDEEM_POINTS, maxRedeemablePoints } from '@/lib/loyalty/policy';
import { useDialogFocusTrap } from '@/hooks/useDialogFocusTrap';



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

interface Patient {
  id: string;
  full_name: string;
  phone?: string | null;
  credit_limit?: number;
  wallet_balance?: number;
  opening_balance?: number;
  outstanding_balance?: number;
  points_balance?: number;
  payment_method?: 'cash' | 'credit' | 'visa' | 'wallet';
}

const PAYMENT_METHODS = [
  { id: 'cash', label: 'كاش', icon: Banknote, selectedClass: 'bg-emerald-700 text-white border-emerald-800' },
  { id: 'credit', label: 'آجل', icon: Clock, selectedClass: 'bg-blue-700 text-white border-blue-800' },
  { id: 'wallet', label: 'محفظة', icon: Wallet, selectedClass: 'bg-purple-700 text-white border-purple-800' },
  { id: 'visa', label: 'فيزا', icon: CreditCard, selectedClass: 'bg-indigo-700 text-white border-indigo-800' },
  { id: 'check', label: 'شيك', icon: FileText, selectedClass: 'bg-amber-700 text-white border-amber-800' },
  { id: 'delivery', label: 'توصيل', icon: Truck, selectedClass: 'bg-rose-700 text-white border-rose-800' },
] as const;

export interface POSSearchSidebarRef {
  clear: () => void;
  focus: () => void;
}

interface POSSearchSidebarProps {
  addToCart: (drug: DrugItem) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  showStock: boolean;
}

function permissionNumber(user: any, key: string, fallback = 0): number {
  let values = user?.permissions;
  try { if (typeof values === 'string') values = JSON.parse(values); } catch { return fallback; }
  const value = values && !Array.isArray(values) ? values[key] : undefined;
  return Number(value ?? (user?.role === 'owner' ? 100 : fallback)) || fallback;
}

const POSSearchSidebar = memo(forwardRef<POSSearchSidebarRef, POSSearchSidebarProps>(
  ({ addToCart, onKeyDown, showStock }, ref) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [searchByActive, setSearchByActive] = useState(false);
    const [searchResults, setSearchResults] = useState<DrugItem[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [searchError, setSearchError] = useState(false);
    const [searchRetry, setSearchRetry] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const searchRequestRef = useRef(0);

    useEffect(() => subscribeInventoryChanges(() => setSearchRetry(attempt => attempt + 1)), []);

    useImperativeHandle(ref, () => ({
      clear: () => {
        setSearchTerm('');
        setSearchResults([]);
        setSearchError(false);
      },
      focus: () => {
        inputRef.current?.focus();
      }
    }));

    useEffect(() => {
      const requestId = ++searchRequestRef.current;
      const searchDrugs = async () => {
        if (searchTerm.length < 2) {
          setSearchResults([]);
          setSearchError(false);
          setIsLoading(false);
          return;
        }

        setIsLoading(true);
        setSearchError(false);
        try {
          const res = await searchDrugsAction(searchTerm, 20, searchByActive);
          if (requestId !== searchRequestRef.current) return;
          if (res.success) {
            setSearchResults(res.data || []);
          } else {
            setSearchResults([]);
            setSearchError(true);
          }
        } catch (error: any) {
          if (requestId !== searchRequestRef.current) return;
          console.error('Drug search error:', error);
          setSearchResults([]);
          setSearchError(true);
        } finally {
          if (requestId === searchRequestRef.current) setIsLoading(false);
        }
      };

      const timer = setTimeout(searchDrugs, 150);
      return () => {
        searchRequestRef.current += 1;
        clearTimeout(timer);
      };
    }, [searchTerm, searchByActive, searchRetry]);

    return (
      <div className="bg-white dark:bg-slate-900 p-5 rounded-3xl border border-slate-200 dark:border-slate-800 flex flex-col min-h-0 flex-1">
        <div className="relative mb-2">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            data-nav="search-input"
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                const currentTerm = searchTerm.trim();
                if (currentTerm.length > 0) {
                  e.preventDefault();
                  try {
                    const res = await barcodeLookupAction(currentTerm);
                    if (!res.success) {
                      toast.error(res.error || 'فشل البحث بالباركود');
                      return;
                    }
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
                      setSearchTerm('');
                      setSearchResults([]);
                      toast.success(`تمت إضافة ${drug.trade_name} مباشرة`);
                      return;
                    }
                  } catch (err) {
                    console.error('Direct barcode lookup error:', err);
                    toast.error('فشل البحث بالباركود');
                    return;
                  }

                  if (searchResults.length > 0) {
                    addToCart(searchResults[0]);
                    setSearchTerm('');
                    setSearchResults([]);
                  } else {
                    try {
                      const searchRes = await searchDrugsAction(currentTerm, 20, searchByActive);
                      if (searchRes.success && searchRes.data && searchRes.data.length > 0) {
                        addToCart(searchRes.data[0]);
                        setSearchTerm('');
                        setSearchResults([]);
                      } else {
                        toast.error('المنتج غير موجود');
                      }
                    } catch (searchErr) {
                      toast.error('المنتج غير موجود');
                    }
                  }
                }
              } else if (onKeyDown) {
                onKeyDown(e);
              }
            }}
            placeholder="بحث (اسم أو كود)..."
            className="w-full pr-10 pl-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 font-bold text-sm"
          />
        </div>

        <div className="flex items-center gap-2 mb-4 px-1">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
            <input 
              type="checkbox" 
              checked={searchByActive} 
              onChange={(e) => setSearchByActive(e.target.checked)}
              className="rounded text-blue-600 focus:ring-blue-500 border-slate-300 w-4 h-4"
            />
            <span>البحث بالمادة الفعالة</span>
          </label>
        </div>
        
        <div className="flex-1 overflow-auto space-y-2">
          {isLoading ? (
            <div role="status" aria-live="polite" className="py-10 flex flex-col items-center justify-center gap-2 text-slate-700 dark:text-slate-200">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-400" aria-hidden="true" />
              <span className="text-xs font-bold">جاري البحث عن الأصناف...</span>
            </div>
          ) : searchError ? (
            <div className="py-8 text-center space-y-3">
              <p className="text-sm font-black text-rose-600">تعذر البحث عن الأصناف</p>
              <button
                type="button"
                onClick={() => setSearchRetry(value => value + 1)}
                className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-black"
              >
                إعادة البحث عن الأصناف
              </button>
            </div>
          ) : searchTerm.trim().length >= 2 && searchResults.length === 0 ? (
            <div role="status" className="py-8 text-center text-xs font-bold text-slate-600 dark:text-slate-300">
              لا توجد أصناف مطابقة
            </div>
          ) : searchResults.map(drug => (
            <button 
              key={drug.id} 
              onClick={() => {
                addToCart(drug);
                setSearchTerm('');
                setSearchResults([]);
              }} 
              className={`w-full flex justify-between items-center p-3 rounded-2xl border text-right transition-all hover:scale-[1.02] active:scale-95 ${
                drug.is_expired ? 'bg-red-50 dark:bg-red-900/10 border-red-100 opacity-60' :
                drug.total_stock === 0 ? 'bg-slate-50 dark:bg-slate-900/40 border-slate-100 dark:border-slate-800 opacity-40' :
                'bg-white dark:bg-slate-800 border-slate-100 dark:border-slate-700'
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="font-bold text-xs truncate text-slate-900 dark:text-white">{drug.trade_name}</p>
                {searchByActive && drug.active_ingredient && (
                  <p className="text-[11px] text-blue-600 dark:text-blue-400 font-semibold truncate">{drug.active_ingredient}</p>
                )}
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-[11px] text-slate-500 font-black">{showStock ? `${drug.total_stock} متاح | ` : ''}{drug.min_price} ج.م</p>
                  {drug.category && <span className="text-[10px] bg-slate-100 dark:bg-slate-700 px-1 rounded text-slate-500">{drug.category}</span>}
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
  const {
    cart, setCart,
    selectedPatient, setSelectedPatient,
    paymentMethod, setPaymentMethod,
    checkNumber, setCheckNumber,
    totalDiscount, setTotalDiscount,
    discountPercent, setDiscountPercent,
    additionalFees, setAdditionalFees,
    resetPOS
  } = usePOSStore();
  const [isProcessing, setIsProcessing] = useState(false);
  const checkoutLockRef = useRef(false);
  const [alternatives, setAlternatives] = useState<DrugItem[]>([]);
  const searchSidebarRef = useRef<POSSearchSidebarRef>(null);

  // Patient Selection
  const [patientSearch, setPatientSearch] = useState('');
  const [patientResults, setPatientResults] = useState<Patient[]>([]);
  const [patientSearchError, setPatientSearchError] = useState(false);
  const [patientSearchLoading, setPatientSearchLoading] = useState(false);
  const [patientSearchRetry, setPatientSearchRetry] = useState(0);
  const patientSearchRequestRef = useRef(0);
  const [pointsToRedeem, setPointsToRedeem] = useState(0);

  const [completedInvoice, setCompletedInvoice] = useState<any>(null);
  const [currentUserName, setCurrentUserName] = useState('صيدلي');
  const [currentUser, setCurrentUser] = useState<{ id: string; pharmacy_id: string } | null>(null);
  const [isAllowed, setIsAllowed] = useState(false);
  const [canChangePrice, setCanChangePrice] = useState(false);
  const [canViewStock, setCanViewStock] = useState(false);
  const [canSellCredit, setCanSellCredit] = useState(false);
  const [canDiscountSaleItem, setCanDiscountSaleItem] = useState(false);
  const [canGiveTotalDiscount, setCanGiveTotalDiscount] = useState(false);
  const [canShowDrafts, setCanShowDrafts] = useState(false);
  const [canSaveDraft, setCanSaveDraft] = useState(false);
  const [canSellNoStock, setCanSellNoStock] = useState(false);
  const [canHandover, setCanHandover] = useState(false);
  const [canViewReturns, setCanViewReturns] = useState(false);
  const [canViewRestock, setCanViewRestock] = useState(false);
  const [canViewPatients, setCanViewPatients] = useState(false);
  const [maxInvoiceDiscountPercent, setMaxInvoiceDiscountPercent] = useState(0);
  const [isUserLoading, setIsUserLoading] = useState(true);
  const [userLoadError, setUserLoadError] = useState(false);
  const [pendingInteractions, setPendingInteractions] = useState<any[]>([]);
  const [showInteractionModal, setShowInteractionModal] = useState(false);
  const [isCheckingInteractions, setIsCheckingInteractions] = useState(false);

  useEffect(() => subscribeDrugIdentityChanges(({ sourceIds }) => {
    if (!sourceIds.length) return;
    const staleIds = new Set(sourceIds.map(id => String(id)));
    const currentCart = usePOSStore.getState().cart;
    const removedCount = currentCart.filter(item => staleIds.has(String(item.drug_id))).length;
    if (!removedCount) return;

    setCart(previous => previous.filter(item => !staleIds.has(String(item.drug_id))));
    toast.error(
      removedCount === 1
        ? 'تم دمج صنف موجود في السلة. أعد إضافته لاستخدام بيانات الصنف المحدثة.'
        : `تم دمج ${removedCount} أصناف موجودة في السلة. أعد إضافتها لاستخدام البيانات المحدثة.`,
    );
  }), [setCart]);

  // Drafts State
  const [drafts, setDrafts] = useState<any[]>([]);
  const [showDraftsModal, setShowDraftsModal] = useState(false);
  const [isLoadingDrafts, setIsLoadingDrafts] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);

  // Selected Row for deletion
  const [selectedRowCartId, setSelectedRowCartId] = useState<string | null>(null);

  // Return/Stock Modal State
  const [showStockWarning, setShowStockWarning] = useState<DrugItem | null>(null);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [showAddPatientModal, setShowAddPatientModal] = useState(false);
  const [showDrugDetails, setShowDrugDetails] = useState<string | number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, drugId: string | number, cartItemId: string } | null>(null);
  const returnDialogRef = useDialogFocusTrap<HTMLDivElement>(showReturnModal);

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

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const activeEl = document.activeElement as HTMLElement;
      const navAttr = activeEl.getAttribute('data-nav');
      if (navAttr && (
        navAttr.startsWith('qty-input-') || 
        navAttr.startsWith('price-input-') ||
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
  }, []);

  const loadUser = useCallback(async () => {
    setIsUserLoading(true);
    setUserLoadError(false);
    try {
      const userObj = await getClientSession();
      if (!userObj) {
        router.push('/login');
        return;
      }

      setIsAllowed(hasUserPermissionSync(userObj, 'can_access_pos'));
      setCanChangePrice(hasUserPermissionSync(userObj, 'can_change_price_sale'));
      setCanViewStock(hasUserPermissionSync(userObj, 'can_view_stock_sale'));
      setCanSellCredit(hasUserPermissionSync(userObj, 'can_sell_credit'));
      const itemDiscountAllowed = hasUserPermissionSync(userObj, 'can_discount_sale_item');
      setCanDiscountSaleItem(itemDiscountAllowed);
      if (!itemDiscountAllowed) {
        setCart(previous => previous.some(item => item.itemDiscountPercent)
          ? previous.map(item => ({ ...item, itemDiscountPercent: 0 }))
          : previous);
      }
      setCanGiveTotalDiscount(hasUserPermissionSync(userObj, 'can_give_total_discount'));
      setCanShowDrafts(hasUserPermissionSync(userObj, 'show_suspended_invoices'));
      setCanSaveDraft(hasUserPermissionSync(userObj, 'suspended_can_save_invoice'));
      setCanSellNoStock(hasUserPermissionSync(userObj, 'can_sell_no_stock'));
      setCanHandover(hasUserPermissionSync(userObj, 'acc_can_view_handover'));
      setCanViewReturns(hasUserPermissionSync(userObj, 'can_view_returns'));
      setCanViewRestock(hasUserPermissionSync(userObj, 'can_view_restock'));
      setCanViewPatients(hasUserPermissionSync(userObj, 'can_view_patients'));
      setMaxInvoiceDiscountPercent(permissionNumber(userObj, 'max_invoice_discount_percent'));

      const res = await getCurrentUserAction();
      if (res.success && res.user) {
        setCurrentUserName(res.user.full_name);
        setCurrentUser({ id: res.user.id, pharmacy_id: res.user.pharmacy_id });
      }
    } catch (error) {
      console.error('Failed to load POS user:', error);
      setUserLoadError(true);
    } finally {
      setIsUserLoading(false);
    }
  }, [router, setCart]);

  useEffect(() => {
    void loadUser();

    // Auto-focus barcode/drug search box on load
    setTimeout(() => {
      searchSidebarRef.current?.focus();
    }, 150);
  }, [loadUser]);

  // Redirect if coming from drafts tab
  useEffect(() => {
    if (searchParams.get('tab') === 'drafts') {
      setShowDraftsModal(true);
    }
  }, [searchParams]);

  // Global Keydown for Delete
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedRowCartId !== null) {
        if (document.activeElement?.tagName === 'INPUT') return;
        setCart(prev => prev.filter(i => i.id !== selectedRowCartId));
        setSelectedRowCartId(null);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [selectedRowCartId, setCart]);

  // Handle Patient Search Debounce
  useEffect(() => {
    const requestId = ++patientSearchRequestRef.current;
    const searchPatients = async () => {
      if (patientSearch.length < 2) {
        setPatientResults([]);
        setPatientSearchError(false);
        setPatientSearchLoading(false);
        return;
      }
      setPatientSearchError(false);
      setPatientSearchLoading(true);
      try {
        const { searchPatientsAction } = await import('@/app/actions-client/patients');
        const res = await searchPatientsAction(patientSearch);
        if (requestId !== patientSearchRequestRef.current) return;
        if (res.success) {
          setPatientResults(res.data || []);
        } else {
          setPatientResults([]);
          setPatientSearchError(true);
        }
      } catch (error) {
        if (requestId !== patientSearchRequestRef.current) return;
        console.error('Patient search error:', error);
        setPatientResults([]);
        setPatientSearchError(true);
      } finally {
        if (requestId === patientSearchRequestRef.current) setPatientSearchLoading(false);
      }
    };
    const timer = setTimeout(searchPatients, 300);
    return () => {
      patientSearchRequestRef.current += 1;
      clearTimeout(timer);
    };
  }, [patientSearch, patientSearchRetry]);

  const loadAllPatients = useCallback(async () => {
    const requestId = ++patientSearchRequestRef.current;
    setPatientSearchError(false);
    setPatientSearchLoading(true);
    try {
      const { searchPatientsAction } = await import('@/app/actions-client/patients');
      const res = await searchPatientsAction('', true);
      if (requestId !== patientSearchRequestRef.current) return;
      if (res.success) {
        setPatientResults(res.data || []);
      } else {
        setPatientResults([]);
        setPatientSearchError(true);
      }
    } catch (error) {
      if (requestId !== patientSearchRequestRef.current) return;
      console.error('Load all patients error:', error);
      setPatientResults([]);
      setPatientSearchError(true);
    } finally {
      if (requestId === patientSearchRequestRef.current) setPatientSearchLoading(false);
    }
  }, []);

  // Refresh checkout-safe patient values whenever a persisted/draft selection is restored.
  // Loyalty, wallet and receivable balances can change while the POS draft remains persisted,
  // so a present (including zero) field is not proof that the snapshot is current.
  useEffect(() => {
    let active = true;
    const patientId = selectedPatient?.id;
    if (!patientId) return () => { active = false; };

    void import('@/app/actions-client/patients').then(async (mod) => {
      const res = await mod.getPatientForPosAction(patientId);
      if (active && res.success && res.data) {
        setSelectedPatient(prev => prev && prev.id === res.data.id ? { ...prev, ...res.data } : prev);
      }
    });

    return () => { active = false; };
  }, [selectedPatient?.id, setSelectedPatient]);

  useEffect(() => {
    setPointsToRedeem(0);
  }, [selectedPatient?.id]);

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
    const defaultUnit = 'large';

    setCart(prev => {
      const existing = prev.find(i => String(i.drug_id) === drugId && (i.selectedUnit === defaultUnit || i.selectedUnit === drug.units?.large) && !i.inventory_id);
      if (existing) {
        return prev.map(i => i.id === existing.id ? { ...i, qty: i.qty + 1 } : i);
      }
      const newItemId = `${drugId}-${defaultUnit}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      return [...prev, { 
        id: newItemId,
        drug_id: drugId, 
        trade_name: drug.trade_name, 
        trade_name_en: drug.trade_name_en,
        active_ingredient: drug.active_ingredient,
        qty: 1, 
        price: drug.min_price, 
        itemDiscountPercent: 0,
        basePrice: drug.min_price,
        selectedUnit: defaultUnit,
        units: drug.units,
        total_stock: drug.total_stock,
        reorder_point: drug.reorder_point,
        nearest_expiry: drug.nearest_expiry,
        batches: drug.batches || [],
        inventory_id: null,
        needsRefill: false 
      }];
    });
  }, [setCart]);

  const addAnotherUnitRow = useCallback((item: CartItem) => {
    const nextUnit = item.selectedUnit === 'large' && item.units.medium 
      ? 'medium' 
      : (item.selectedUnit === 'medium' && item.units.small ? 'small' : 'large');

    const selectedBatch = item.inventory_id
      ? item.batches?.find((batch: any) => String(batch.inventory_id) === String(item.inventory_id))
      : null;
    const largeToMedium = Number(selectedBatch?.strips_per_box) > 0
      ? Number(selectedBatch.strips_per_box)
      : (item.units.large_to_medium || 1);
    const mediumToSmall = Number(selectedBatch?.medium_to_small) > 0
      ? Number(selectedBatch.medium_to_small)
      : (item.units.medium_to_small || 1);
    let newPrice = selectedBatch?.unit_price || item.basePrice;
    if (nextUnit === item.units.medium || nextUnit === 'medium') {
      newPrice /= largeToMedium;
    } else if (nextUnit === item.units.small || nextUnit === 'small') {
      newPrice /= largeToMedium * mediumToSmall;
    }

    const newItemId = `${item.drug_id}-${nextUnit}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    setCart(prev => [...prev, {
      ...item,
      id: newItemId,
      qty: 1,
      selectedUnit: nextUnit,
      price: Number(newPrice.toFixed(2))
    }]);
    toast.success(`تمت إضافة وحدة جديدة (${nextUnit === 'medium' ? item.units.medium || 'شريط' : (nextUnit === 'small' ? item.units.small || 'قرص' : item.units.large || 'علبة')})`);
  }, [setCart]);

  const handleUnitChange = useCallback((cartItemId: string, unit: string) => {
    setCart(prev => prev.map(item => {
      if (item.id !== cartItemId) return item;
      
      const selectedBatch = item.inventory_id
        ? item.batches?.find((batch: any) => String(batch.inventory_id) === String(item.inventory_id))
        : null;
      const largeToMedium = Number(selectedBatch?.strips_per_box) > 0
        ? Number(selectedBatch.strips_per_box)
        : (item.units.large_to_medium || 1);
      const mediumToSmall = Number(selectedBatch?.medium_to_small) > 0
        ? Number(selectedBatch.medium_to_small)
        : (item.units.medium_to_small || 1);
      let newPrice = selectedBatch?.unit_price || item.basePrice;
      if (unit === item.units.medium || unit === 'medium') {
        newPrice /= largeToMedium;
      } else if (unit === item.units.small || unit === 'small') {
        newPrice /= largeToMedium * mediumToSmall;
      }
      
      return { ...item, selectedUnit: unit as any, price: Number(newPrice.toFixed(2)) };
    }));
  }, [setCart]);

  const handleBatchChange = useCallback((cartItemId: string, inventoryId: string) => {
    setCart(prev => prev.map(item => {
      if (item.id !== cartItemId) return item;
      
      const batchId = inventoryId === 'auto' ? null : inventoryId;
      let newPrice = item.price;
      
      if (batchId && item.batches) {
        const batch = item.batches.find((b: any) => String(b.inventory_id) === String(batchId));
        if (batch && batch.unit_price) {
          let basePrice = batch.unit_price;
          const largeToMedium = Number(batch.strips_per_box) > 0
            ? Number(batch.strips_per_box)
            : (item.units.large_to_medium || 1);
          const mediumToSmall = Number(batch.medium_to_small) > 0
            ? Number(batch.medium_to_small)
            : (item.units.medium_to_small || 1);
          if (item.selectedUnit === item.units.medium || item.selectedUnit === 'medium') {
            basePrice /= largeToMedium;
          } else if (item.selectedUnit === item.units.small || item.selectedUnit === 'small') {
            basePrice /= largeToMedium * mediumToSmall;
          }
          newPrice = basePrice;
        }
      }
      
      return { ...item, inventory_id: batchId, price: Number(newPrice.toFixed(2)) };
    }));
  }, [setCart]);

  const stockInSelectedUnit = (item: CartItem) => {
    const selectedBatches = item.inventory_id
      ? item.batches?.filter((batch: any) => String(batch.inventory_id) === String(item.inventory_id)) || []
      : item.batches || [];
    if (selectedBatches.length === 0) {
      const l2m = item.units.large_to_medium || 1;
      const m2s = item.units.medium_to_small || 1;
      if (item.selectedUnit === item.units.medium || item.selectedUnit === 'medium') return item.total_stock * l2m;
      if (item.selectedUnit === item.units.small || item.selectedUnit === 'small') return item.total_stock * l2m * m2s;
      return item.total_stock;
    }
    return selectedBatches.reduce((total: number, batch: any) => {
      const quantity = Number(batch.quantity) || 0;
      const l2m = Number(batch.strips_per_box) > 0 ? Number(batch.strips_per_box) : (item.units.large_to_medium || 1);
      const m2s = Number(batch.medium_to_small) > 0 ? Number(batch.medium_to_small) : (item.units.medium_to_small || 1);
      if (item.selectedUnit === item.units.medium || item.selectedUnit === 'medium') return total + quantity * l2m;
      if (item.selectedUnit === item.units.small || item.selectedUnit === 'small') return total + quantity * l2m * m2s;
      return total + quantity;
    }, 0);
  };

  const resetCart = useCallback(() => {
    if (cart.length > 0 && !confirm('هل أنت متأكد من مسح السلة وبدء فاتورة جديدة؟')) return;
    resetPOS();
    setActiveDraftId(null);
  }, [cart, resetPOS]);

  const hasInvalidStockQuantity = (() => {
    type SimulatedBatch = {
      remaining: number;
      strips_per_box?: number;
      medium_to_small?: number;
    };
    type SimulatedPool = {
      batches: Map<string, SimulatedBatch>;
      fallbackRemaining: number;
    };

    const pools = new Map<string, SimulatedPool>();
    for (const item of cart) {
      if (item.isNegative) continue;
      const key = String(item.drug_id);
      const pool = pools.get(key) || { batches: new Map<string, SimulatedBatch>(), fallbackRemaining: 0 };
      pool.fallbackRemaining = Math.max(pool.fallbackRemaining, Number(item.total_stock) || 0);
      for (const batch of item.batches || []) {
        const batchId = String(batch.inventory_id);
        if (!pool.batches.has(batchId)) {
          pool.batches.set(batchId, {
            remaining: Number(batch.quantity) || 0,
            strips_per_box: Number(batch.strips_per_box) || undefined,
            medium_to_small: Number(batch.medium_to_small) || undefined,
          });
        }
      }
      pools.set(key, pool);
    }

    const stockPerSelectedUnit = (item: CartItem, batch?: SimulatedBatch) => {
      const l2m = Number(batch?.strips_per_box) > 0
        ? Number(batch!.strips_per_box)
        : (item.units.large_to_medium || 1);
      const m2s = Number(batch?.medium_to_small) > 0
        ? Number(batch!.medium_to_small)
        : (item.units.medium_to_small || 1);
      if (item.selectedUnit === item.units.medium || item.selectedUnit === 'medium') return 1 / l2m;
      if (item.selectedUnit === item.units.small || item.selectedUnit === 'small') return 1 / (l2m * m2s);
      return 1;
    };

    for (const item of cart) {
      if (item.isNegative) continue;
      const pool = pools.get(String(item.drug_id));
      if (!pool) return true;
      let remainingUnits = Number(item.qty) || 0;

      if (pool.batches.size > 0) {
        const candidateIds = item.inventory_id
          ? [String(item.inventory_id)]
          : (item.batches || []).map((batch: any) => String(batch.inventory_id));
        const ids = candidateIds.length > 0 ? candidateIds : Array.from(pool.batches.keys());
        for (const batchId of ids) {
          if (remainingUnits <= 0.000001) break;
          const batch = pool.batches.get(batchId);
          if (!batch) continue;
          const stockPerUnit = stockPerSelectedUnit(item, batch);
          const capacity = batch.remaining / stockPerUnit;
          const consumeUnits = Math.min(remainingUnits, capacity);
          batch.remaining = Math.max(0, batch.remaining - consumeUnits * stockPerUnit);
          remainingUnits -= consumeUnits;
        }
        if (remainingUnits > 0.000001) return true;
      } else {
        const requiredBaseStock = remainingUnits * stockPerSelectedUnit(item);
        if (pool.fallbackRemaining + 0.000001 < requiredBaseStock) return true;
        pool.fallbackRemaining -= requiredBaseStock;
      }
    }
    return false;
  })();

  const handleCheckout = async (status: 'completed' | 'draft' = 'completed', force = false) => {
    if (cart.length === 0 || checkoutLockRef.current) return;
    if (status === 'completed' && paymentMethod === 'check' && !checkNumber.trim()) {
      toast.error('يرجى إدخال رقم الشيك');
      return;
    }
    checkoutLockRef.current = true;
    setIsProcessing(true);

    try {
      let interactionRes: any = { interactions: [] };
      let clinicalAlerts: any[] = [];

      if (status === 'completed' && !force) {
        const ingredients = cart.map(i => i.active_ingredient);
        
        const safetyRes = await checkDrugInteractions(ingredients, selectedPatient?.id);
        if (!safetyRes.success) {
          toast.error(safetyRes.error || 'فشل فحص التفاعلات الدوائية');
          return;
        }
        if (safetyRes.data) {
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
        unit_price: item.price * (1 - (item.itemDiscountPercent || 0) / 100),
        item_discount_percent: item.itemDiscountPercent || 0,
        selected_unit: item.selectedUnit,
        is_negative: item.isNegative || false
      }));

      const result = await processCheckoutAction({
        items: formattedCart,
        patient_id: selectedPatient?.id,
        payment_method: paymentMethod,
        check_number: paymentMethod === 'check' ? checkNumber.trim() : undefined,
        status,
        total_discount: totalDiscount + percentDiscountValue,
        additional_fees: additionalFees,
        points_to_redeem: status === 'completed' ? pointsToRedeem : 0,
        source_draft_id: activeDraftId,
      });

      if (result.success) {
        toast.success(status === 'draft' ? 'تم حفظ المسودة بنجاح' : 'تمت العملية بنجاح!');
        
        if (status === 'completed' && result.data) {
          const invoice = {
            id: result.data.sale_id,
            total_amount: result.data.total_amount,
            discount_amount: totalDiscount + percentDiscountValue + Number(result.data.loyalty_discount_amount || 0),
            points_redeemed: Number(result.data.points_redeemed || 0),
            loyalty_discount_amount: Number(result.data.loyalty_discount_amount || 0),
            additional_fees: additionalFees,
            created_at: result.data.created_at,
            payment_method: paymentMethod,
            profiles: { full_name: currentUserName },
            patients: selectedPatient ? { full_name: selectedPatient.full_name, phone: selectedPatient.phone } : null,
            sales_items: cart.map(item => ({
              quantity_sold: item.qty,
              unit_price: item.price * (1 - (item.itemDiscountPercent || 0) / 100),
              unit: item.selectedUnit,
              units: item.units,
              inventory: { master_drugs: { trade_name: item.trade_name, trade_name_en: item.trade_name_en } }
            }))
          };
          setCompletedInvoice(invoice);

          // Trigger financial snapshot update
          import('@/app/actions-client/finance').then(mod => mod.generateDailySnapshotAction());
        }
        
        resetPOS();
        setActiveDraftId(null);
      } else {
        const checkoutError = result.error || 'فشلت العملية';
        toast.error(checkoutError);
      }
    } catch (error) {
      console.error('Checkout error:', error);
      toast.error('فشلت العملية');
    } finally {
      checkoutLockRef.current = false;
      setIsProcessing(false);
    }
  };

  useHotkeys('ctrl+s', event => {
    event.preventDefault();
    if (cart.length === 0 || isProcessing) return;
    handleCheckout('completed');
  }, { enableOnFormTags: true }, [cart.length, isProcessing, handleCheckout]);

  useHotkeys('insert', event => {
    event.preventDefault();
    const searchInput = document.querySelector('[data-nav="search-input"]') as HTMLInputElement;
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }, { enableOnFormTags: true });

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
      toast.error('فشل تحميل المسودات');
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
      isNegative: Boolean(item.is_negative ?? item.isNegative),
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
    setCheckNumber(draft.check_number || '');
    setTotalDiscount(draft.discount_amount || 0);
    setDiscountPercent(0);
    setAdditionalFees(draft.additional_fees || 0);
    setActiveDraftId(String(draft.id));
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
      } else if (!res.success) {
        toast.error(res.error || 'فشل البحث بالباركود');
      } else {
        toast.error('المنتج غير موجود');
      }
    } catch (error) {
      console.error('Barcode scan error:', error);
      toast.error('فشل البحث بالباركود');
    }
  });

  const subtotal = useMemo(() => {
    return cart.reduce((s, i) => s + (i.price * i.qty * (1 - (i.itemDiscountPercent || 0) / 100)), 0);
  }, [cart]);

  const percentDiscountValue = useMemo(() => {
    return (subtotal * discountPercent) / 100;
  }, [subtotal, discountPercent]);

  const eligibleMerchandiseAfterManualDiscount = useMemo(() => {
    return Math.max(0, subtotal - totalDiscount - percentDiscountValue);
  }, [subtotal, totalDiscount, percentDiscountValue]);

  const maximumRedeemablePoints = useMemo(() => {
    return selectedPatient
      ? maxRedeemablePoints(Number(selectedPatient.points_balance || 0), eligibleMerchandiseAfterManualDiscount)
      : 0;
  }, [selectedPatient, eligibleMerchandiseAfterManualDiscount]);

  useEffect(() => {
    setPointsToRedeem((current) => {
      if (current <= 0) return 0;
      if (maximumRedeemablePoints < MIN_REDEEM_POINTS) return 0;
      const clamped = Math.min(current, maximumRedeemablePoints);
      return clamped < MIN_REDEEM_POINTS ? 0 : clamped;
    });
  }, [maximumRedeemablePoints]);

  const loyaltyDiscountValue = useMemo(() => {
    return pointsToRedeem * EGP_PER_REDEEMED_POINT;
  }, [pointsToRedeem]);

  const total = useMemo(() => {
    return Math.max(0, subtotal - totalDiscount - percentDiscountValue - loyaltyDiscountValue + additionalFees);
  }, [subtotal, totalDiscount, percentDiscountValue, loyaltyDiscountValue, additionalFees]);

  const handleContextMenu = (e: React.MouseEvent, drugId: string | number, cartItemId: string) => {
    e.preventDefault();
    const menuWidth = 220;
    const menuHeight = 260;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 12;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 12;
    if (x < 12) x = 12;
    if (y < 12) y = 12;
    setContextMenu({ x, y, drugId, cartItemId });
  };

  const closeContextMenu = () => setContextMenu(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2' && selectedRowCartId) {
        e.preventDefault();
        const selectedItem = cart.find(i => i.id === selectedRowCartId);
        if (selectedItem) setShowDrugDetails(selectedItem.drug_id);
      }
      if (e.key === 'F9' && selectedRowCartId) {
        e.preventDefault();
        const selectedItem = cart.find(i => i.id === selectedRowCartId);
        if (selectedItem) {
          if (!canViewRestock) {
            toast.error('غير مصرح');
            return;
          }
          addToShortagesAction({ drug_id: selectedItem.drug_id }).then(res => {
            if (res.success) toast.success('تمت الإضافة إلى النواقص');
            else toast.error((res as any).error || 'فشل إضافة الصنف إلى النواقص');
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedRowCartId, cart, canViewRestock]);

  useEffect(() => {
    const handleClick = () => closeContextMenu();
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  if (isUserLoading) {
    return (
      <div role="status" aria-live="polite" className="flex flex-col justify-center items-center gap-3 py-12 text-slate-700 dark:text-slate-200" dir="rtl">
        <div aria-hidden="true" className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        <p className="font-bold">جاري تحميل نقطة البيع...</p>
      </div>
    );
  }

  if (userLoadError) {
    return (
      <div className="flex flex-col justify-center items-center py-12 gap-4" dir="rtl">
        <p className="font-black text-rose-600">تعذر تحميل نقطة البيع</p>
        <button
          type="button"
          onClick={() => void loadUser()}
          className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!isAllowed) {
    return <AccessDenied />;
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto font-sans xl:flex-row xl:overflow-hidden" dir="rtl">
      <Toaster position="top-center" />

      {/* LEFT SIDEBAR ACTIONS */}
      <div className="flex w-full shrink-0 gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900 xl:w-20 xl:flex-col xl:overflow-y-auto">
        <SidebarButton icon={Plus} label="جديد" color="bg-emerald-500" onClick={resetCart} />
        {canSaveDraft && <SidebarButton icon={Save} label="حفظ" color="bg-blue-500" onClick={() => handleCheckout('draft')} />}
        <SidebarButton icon={ShoppingCart} label="بيع" color="bg-indigo-500" onClick={() => handleCheckout('completed')} />
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
              if (!safetyRes.success) {
                toast.error(safetyRes.error || 'فشل عملية الفحص', { id: checkToast });
                return;
              }
              
              const allAlerts: any[] = [];
              if (safetyRes.data) {
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
        <div className="hidden h-px bg-slate-100 dark:bg-slate-800 my-1 xl:block" />
        {canShowDrafts && <SidebarButton icon={FileText} label="فواتير معلقة" color="bg-amber-500" onClick={() => { fetchDrafts(); setShowDraftsModal(true); }} />}
        {canViewReturns && <SidebarButton icon={RotateCcw} label="استرجاع" color="bg-rose-500" onClick={() => setShowReturnModal(true)} />}
        {canHandover && <SidebarButton icon={ArrowLeftRight} label="تسليم الدرج" color="bg-blue-600" onClick={() => setShowHandoverModal(true)} />}
        <div className="hidden h-px bg-slate-100 dark:bg-slate-800 my-1 xl:block" />
        {canViewPatients && (
          <SidebarButton icon={User} label="عميل جديد" color="bg-purple-500" onClick={() => setShowAddPatientModal(true)} />
        )}
        <SidebarButton icon={PlusCircle} label="إضافة صنف" color="bg-slate-700" onClick={() => { searchSidebarRef.current?.clear(); searchSidebarRef.current?.focus(); }} />
        <div className="flex shrink-0 gap-2 xl:mt-auto xl:flex-col xl:gap-0 xl:border-t xl:border-slate-100 xl:pt-3 dark:xl:border-slate-800">
          <SidebarButton icon={Calculator} label="آلة حاسبة" color="bg-slate-600" onClick={() => window.open('https://www.google.com/search?q=calculator', '_blank')} />
          <SidebarButton icon={BarChart3} label="تقارير" color="bg-slate-600" onClick={() => router.push('/reports')} />
          <SidebarButton icon={Settings} label="خيارات" color="bg-slate-600" onClick={() => router.push('/settings')} />
        </div>
      </div>
      
      {/* Main Center Area */}
      <div className="flex-1 flex flex-col gap-3 min-w-0 min-h-0">
        
        {/* Top Invoice Info Header */}
        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 md:grid-cols-2 xl:grid-cols-4 xl:gap-4">
          <div className="col-span-1 space-y-1">
            <div className="text-xs font-black text-slate-500">بيانات العميل</div>
            {selectedPatient ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between bg-purple-50 dark:bg-purple-900/20 p-2 rounded-xl border border-purple-100 dark:border-purple-800">
                  <span className="flex items-center gap-1.5 font-bold text-xs text-purple-700 dark:text-purple-300 break-words leading-relaxed" title={selectedPatient.full_name}><User aria-hidden="true" className="h-4 w-4 shrink-0" />{selectedPatient.full_name}</span>
                  <button type="button" aria-label={`إلغاء اختيار العميل ${selectedPatient.full_name}`} onClick={() => { setSelectedPatient(null); if (paymentMethod === 'credit' || paymentMethod === 'wallet') setPaymentMethod('cash'); }} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-purple-700 hover:bg-purple-100 hover:text-purple-900 dark:text-purple-300 dark:hover:bg-purple-900/30">×</button>
                </div>
                {paymentMethod === 'credit' && (
                  <div className="text-[11px] font-black px-1 flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">الائتمان المتبقي:</span>
                    <span className={((selectedPatient.credit_limit || 0) - (selectedPatient.outstanding_balance || 0)) < total ? "text-rose-700 dark:text-rose-400 font-bold" : "text-emerald-700 dark:text-emerald-400 font-bold"}>
                      {((selectedPatient.credit_limit || 0) - (selectedPatient.outstanding_balance || 0)).toFixed(2)} ج.م
                    </span>
                  </div>
                )}
                {paymentMethod === 'wallet' && (
                  <div className="text-[11px] font-black px-1 flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">رصيد المحفظة:</span>
                    <span className={(selectedPatient.wallet_balance || 0) < total ? "text-rose-700 dark:text-rose-400 font-bold" : "text-emerald-700 dark:text-emerald-400 font-bold"}>
                      {Number(selectedPatient.wallet_balance || 0).toFixed(2)} ج.م
                    </span>
                  </div>
                )}
                <div className="text-[11px] font-black px-1 flex items-center justify-between gap-2">
                  <span className="text-slate-600 dark:text-slate-300">نقاط الولاء:</span>
                  <span className="text-amber-700 dark:text-amber-300">{Math.floor(Number(selectedPatient.points_balance || 0))}</span>
                </div>
                {Number(selectedPatient.points_balance || 0) >= MIN_REDEEM_POINTS && maximumRedeemablePoints >= MIN_REDEEM_POINTS && (
                  <div className="grid grid-cols-[1fr_auto] items-end gap-2 rounded-lg bg-amber-50/70 dark:bg-amber-900/10 p-2 border border-amber-100 dark:border-amber-900/30">
                    <label className="text-[11px] font-black text-amber-700 dark:text-amber-300">
                      نقاط مستخدمة
                      <input
                        aria-label="نقاط الولاء المستخدمة"
                        type="number"
                        min={0}
                        max={maximumRedeemablePoints}
                        step={1}
                        value={pointsToRedeem}
                        onChange={(event) => {
                          const requested = Math.max(0, Math.floor(Number(event.target.value) || 0));
                          setPointsToRedeem(Math.min(maximumRedeemablePoints, requested));
                        }}
                        className="mt-1 w-full rounded-md border border-amber-200 bg-white dark:bg-slate-800 dark:border-amber-900/40 px-2 py-1 text-center text-xs font-black text-slate-800 dark:text-white"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setPointsToRedeem(pointsToRedeem > 0 ? 0 : maximumRedeemablePoints)}
                      className="rounded-md bg-amber-500 px-2 py-1.5 text-[11px] font-black text-white hover:bg-amber-600"
                    >
                      {pointsToRedeem > 0 ? 'إلغاء' : 'استخدام الحد الأقصى'}
                    </button>
                    <p className="col-span-2 text-[11px] font-bold text-amber-700/90 dark:text-amber-300/90">
                      الحد الأدنى {MIN_REDEEM_POINTS} نقطة · الخصم الحالي {loyaltyDiscountValue.toFixed(2)} ج.م
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="relative">
                <input 
                  type="text" 
                  aria-label="البحث عن عميل"
                  placeholder="بحث باسم أو هاتف العميل..."
                  value={patientSearch}
                  onChange={(e) => setPatientSearch(e.target.value)}
                  onDoubleClick={() => void loadAllPatients()}
                  data-nav="patient-input"
                  onKeyDown={handleInputKeyDown}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 dark:text-white rounded-xl pr-3 pl-24 py-3 text-xs font-bold outline-none focus:ring-2 focus:ring-purple-500"
                />
                <button
                  type="button"
                  onClick={() => void loadAllPatients()}
                  className="absolute left-1 top-1/2 inline-flex min-h-11 -translate-y-1/2 items-center justify-center rounded-lg px-3 text-[11px] font-black text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/30"
                >
                  عرض الكل
                </button>
                {(patientSearchLoading || patientResults.length > 0 || patientSearchError || patientSearch.length >= 2) && (
                  <div className="absolute top-full left-0 right-0 max-h-64 overflow-y-auto bg-white dark:bg-slate-800 shadow-2xl rounded-2xl mt-2 z-50 border border-slate-100 dark:border-slate-700 p-2">
                    {patientSearchLoading ? (
                      <div role="status" aria-live="polite" className="py-5 text-center text-xs font-bold text-slate-600 dark:text-slate-300">جاري البحث عن العملاء...</div>
                    ) : patientSearchError ? (
                      <div className="py-5 text-center space-y-3">
                        <p className="text-xs font-black text-rose-600">تعذر البحث عن العملاء</p>
                        <button
                          type="button"
                          onClick={() => setPatientSearchRetry(value => value + 1)}
                          className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-black"
                        >
                          إعادة البحث عن العملاء
                        </button>
                      </div>
                    ) : patientResults.length === 0 ? (
                      <div role="status" className="py-5 text-center text-xs font-bold text-slate-600 dark:text-slate-300">لا توجد نتائج مطابقة</div>
                    ) : patientResults.map(p => (
                      <button 
                        key={p.id}
                        onClick={() => {
                          setSelectedPatient(p);
                          if (p.payment_method && ['cash', 'credit', 'visa', 'wallet'].includes(p.payment_method)) {
                            setPaymentMethod(p.payment_method);
                          }
                          setPatientResults([]);
                          setPatientSearch('');
                        }}
                        className="w-full text-right p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-xl text-xs font-bold transition-colors border-b last:border-b-0 border-slate-50 dark:border-slate-700/30"
                      >
                        <span className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-white break-words" title={p.full_name}>
                            <User aria-hidden="true" className="h-4 w-4 shrink-0" />{p.full_name} {p.phone ? `(${p.phone})` : ''}
                          </span>
                          <span className={`shrink-0 text-[11px] ${Number(p.outstanding_balance || 0) > 0 ? 'text-rose-600 dark:text-rose-400 font-black' : 'text-emerald-600 dark:text-emerald-400 font-bold'}`}>
                            مديونية: {Math.max(0, Number(p.outstanding_balance || 0)).toFixed(2)} ج.م
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="col-span-1 space-y-1 md:col-span-2">
             <div id="pos-payment-method-label" className="text-xs font-black text-slate-500">نوع الفاتورة (طريقة الدفع)</div>
             <div role="group" aria-labelledby="pos-payment-method-label" className="flex flex-wrap gap-2">
                {PAYMENT_METHODS.filter(method => method.id !== 'credit' || canSellCredit).map(method => {
                  const PaymentIcon = method.icon;
                  return (
                    <button
                      type="button"
                      key={method.id}
                      onClick={() => setPaymentMethod(method.id as any)}
                      aria-pressed={paymentMethod === method.id}
                      className={`flex min-h-11 min-w-20 flex-1 items-center justify-center gap-1.5 rounded-xl border px-2 py-2 font-black text-xs transition-colors ${
                        paymentMethod === method.id
                          ? method.selectedClass
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <PaymentIcon aria-hidden="true" className="h-4 w-4" />
                      {method.label}
                    </button>
                  );
                })}
             </div>
             {paymentMethod === 'check' && (
               <label className="block space-y-1">
                 <span className="text-xs font-black text-slate-500">رقم الشيك</span>
                 <input
                   type="text"
                   aria-label="رقم الشيك"
                   value={checkNumber}
                   onChange={(e) => setCheckNumber(e.target.value)}
                   className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 p-2 rounded-xl text-xs font-black"
                 />
               </label>
             )}
          </div>

          <div className="col-span-1 grid grid-cols-2 gap-3">
             <div className="space-y-1">
                <label htmlFor="pos-additional-fees" className="text-[11px] font-black text-slate-500">م. إضافية</label>
                <input 
                  id="pos-additional-fees"
                  type="number"
                  value={additionalFees}
                  onChange={(e) => setAdditionalFees(Number(e.target.value))}
                  data-nav="additional-fees-input"
                  onKeyDown={handleInputKeyDown}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 p-2 rounded-xl text-xs font-black text-center"
                />
             </div>
             <div className="space-y-1">
                <label htmlFor="pos-discount-percent" className="text-[11px] font-black text-slate-500">خصم %</label>
                <input 
                  id="pos-discount-percent"
                  type="number"
                  value={discountPercent}
                  min={0}
                  max={maxInvoiceDiscountPercent}
                  disabled={!canGiveTotalDiscount}
                  onChange={(e) => setDiscountPercent(Math.min(maxInvoiceDiscountPercent, Math.max(0, Number(e.target.value))))}
                  data-nav="discount-percent-input"
                  onKeyDown={handleInputKeyDown}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 p-2 rounded-xl text-xs font-black text-center text-rose-700 dark:text-rose-400"
                />
             </div>
          </div>
        </div>

        {/* Main Items Table */}
        <div className="flex-1 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col min-h-0">
          <div className="overflow-x-auto overflow-y-auto flex-1">
            <table className="w-full text-right border-collapse min-w-full">
              <thead className="border-b border-slate-200 dark:border-slate-700">
                <tr>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 w-10 text-center">ك. الصنف</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1.5 py-2 text-[11px] font-black text-slate-600 text-right">اسم الصنف</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 w-12 text-center">الوحدة</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 w-16 text-center">الصلاحية</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 w-20 text-center">الكمية</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 w-12 text-center">س. البيع</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 w-10 text-center">الرصيد</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 w-10 text-center">حد الطلب</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 w-12 text-center">خصم</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 text-[11px] font-black text-slate-600 text-left w-16">الإجمالي</th>
                  <th className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10 px-1 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                {cart.map((item, index) => (
                  <tr 
                    key={item.id} 
                    onClick={() => setSelectedRowCartId(item.id)}
                    onFocus={(event) => {
                      if (event.target === event.currentTarget) setSelectedRowCartId(item.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        setSelectedRowCartId(item.id);
                      }
                    }}
                    onContextMenu={(e) => handleContextMenu(e, item.drug_id, item.id)}
                    tabIndex={0}
                    aria-selected={selectedRowCartId === item.id}
                    className={`group hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${selectedRowCartId === item.id ? 'bg-blue-50/50 dark:bg-blue-900/20 ring-1 ring-inset ring-blue-500/20' : ''}`}
                  >
                    <td className="px-1 py-2 text-[10px] font-bold text-slate-500 text-center w-10">#{item.drug_id}</td>
                    <td className="px-1.5 py-2 text-right">
                      <p className="font-bold text-xs line-clamp-1">{item.trade_name_en || item.trade_name}</p>
                      <p className="text-[11px] text-slate-500 font-medium truncate max-w-[150px]">{item.active_ingredient}</p>
                    </td>
                    <td className="px-1 py-2 text-center w-12">
                      <select 
                        value={item.selectedUnit}
                        onChange={(e) => handleUnitChange(item.id, e.target.value)}
                        data-nav={`unit-select-${index}`}
                        onKeyDown={handleInputKeyDown}
                        className="bg-transparent border-none text-[11px] font-black outline-none cursor-pointer text-blue-600 focus:ring-1 focus:ring-blue-500 rounded px-0.5"
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
                          onChange={(e) => handleBatchChange(item.id, e.target.value)}
                        className="w-full bg-slate-50 dark:bg-slate-800 border-none p-1 rounded text-[11px] font-bold focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="auto">تلقائي ({item.nearest_expiry || '---'})</option>
                          {item.batches.map((b: any) => (
                            <option key={b.inventory_id} value={b.inventory_id}>
                              {b.expiry_date || 'بدون'} (كمية: {b.quantity})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`text-[11px] font-bold px-1 py-0.5 rounded-full ${
                          item.nearest_expiry && new Date(item.nearest_expiry) < new Date() ? 'bg-red-100 text-red-600' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                        }`}>
                          {item.nearest_expiry || '---'}
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-center w-20">
                      <div className="flex min-w-[9rem] items-center justify-center gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1 mx-auto font-sans">
                        <button type="button" aria-label={`تقليل كمية ${item.trade_name_en || item.trade_name}`} onClick={() => setCart(p => p.map(i => i.id === item.id ? {...i, qty: Math.max(1, i.qty-1)} : i))} className="inline-flex h-11 w-11 items-center justify-center rounded text-slate-700 hover:bg-white dark:text-slate-200 dark:hover:bg-slate-700 font-bold text-base">-</button>
                        <input 
                          type="number" 
                          min={1}
                          max={item.isNegative ? undefined : Math.max(1, Math.floor(stockInSelectedUnit(item)))}
                          value={item.qty} 
                          data-qty-input="true"
                          data-nav={`qty-input-${index}`}
                          onChange={(e) => {
                            const newQty = parseInt(e.target.value);
                            const maxQty = item.isNegative ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(stockInSelectedUnit(item)));
                            setCart(p => p.map(i => i.id === item.id ? {...i, qty: isNaN(newQty) ? 1 : Math.min(maxQty, Math.max(1, newQty))} : i))
                          }}
                          onKeyDown={handleInputKeyDown}
                          className="w-12 bg-transparent text-center font-bold text-xs outline-none focus:ring-1 focus:ring-blue-500 rounded p-0"
                        />
                        <button
                          type="button"
                          aria-label={`زيادة كمية ${item.trade_name_en || item.trade_name}`}
                          disabled={!item.isNegative && item.qty >= Math.floor(stockInSelectedUnit(item) + 1e-9)}
                          onClick={() => setCart(p => p.map(i => i.id === item.id ? {...i, qty: i.isNegative ? i.qty + 1 : Math.min(i.qty + 1, Math.max(1, Math.floor(stockInSelectedUnit(i))))} : i))}
                          className="inline-flex h-11 w-11 items-center justify-center rounded text-slate-700 hover:bg-white dark:text-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 font-bold text-base"
                        >+</button>
                      </div>
                    </td>
                    <td className="px-1 py-2 text-center w-14">
                      {canChangePrice ? (
                        <input 
                          type="number"
                          step="0.01"
                          min="0"
                          value={item.price}
                          data-nav={`price-input-${index}`}
                          onKeyDown={handleInputKeyDown}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            setCart(p => p.map(i => i.id === item.id ? { ...i, price: isNaN(val) ? 0 : val } : i));
                          }}
                          className="w-12 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded p-0.5 text-[11px] font-black text-center text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none shadow-inner"
                          title="تعديل سعر البيع (متاح للصلاحيات)"
                        />
                      ) : (
                        <span className="font-black text-[11px] text-slate-900 dark:text-white" title="تعديل السعر يتطلب صلاحية">
                          {item.price}
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-center w-10">
                       <span className={`text-[11px] font-black ${item.total_stock <= (item.reorder_point || 0) ? 'text-red-500' : 'text-slate-500'}`}>
                        {canViewStock ? Number(stockInSelectedUnit(item).toFixed(2)) : '—'}
                       </span>
                    </td>
                    <td className="px-1 py-2 text-center text-[11px] font-bold text-slate-500 w-10">{item.reorder_point || 0}</td>
                    <td className="px-1 py-2 text-center w-12">
                      {canDiscountSaleItem ? (
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={item.itemDiscountPercent || 0}
                          onChange={(e) => setCart(p => p.map(i => i.id === item.id ? { ...i, itemDiscountPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } : i))}
                          data-nav={`discount-input-${index}`}
                          onKeyDown={handleInputKeyDown}
                          aria-label={`خصم الصنف ${item.trade_name_en || item.trade_name}`}
                          className="w-12 bg-slate-50 dark:bg-slate-800 border-none p-0.5 rounded text-[11px] font-black text-center text-rose-700 dark:text-rose-400 focus:ring-2 focus:ring-rose-500"
                          placeholder="%"
                        />
                      ) : (
                        <span className="text-[11px] font-black text-slate-500" title="تعديل خصم الصنف يتطلب صلاحية">0%</span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-left font-black text-blue-600 text-[11px] w-16">
                      {(item.price * item.qty * (1 - (item.itemDiscountPercent || 0) / 100)).toFixed(2)}
                    </td>
                    <td className="px-1 py-2 text-left w-8">
                      <button
                        type="button"
                        data-nav={`remove-item-${index}`}
                        aria-label={`حذف ${item.trade_name_en || item.trade_name} من الفاتورة`}
                        onKeyDown={handleInputKeyDown}
                        onClick={() => setCart(p => p.filter(i => i.id !== item.id))}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 rounded transition-colors opacity-80 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus:opacity-100"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Table Totals Bar */}
          <div className="flex flex-col gap-4 border-t border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/50 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-wrap gap-4 md:gap-8">
              <TotalLabel label="عدد الأصناف" value={cart.length} />
              <TotalLabel label="إجمالي الكميات" value={cart.reduce((s, i) => s + i.qty, 0)} />
              <TotalLabel label="إجمالي الخصم" value={(totalDiscount + percentDiscountValue + cart.reduce((s,i) => s + (i.price * i.qty * (i.itemDiscountPercent || 0) / 100), 0)).toFixed(2)} color="text-rose-700 dark:text-rose-400" />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 md:justify-end">
               <div className="text-right">
                  <p className="text-[11px] font-black text-slate-500">المبلغ الإجمالي</p>
                  <p className="text-2xl font-black text-emerald-500">{total.toLocaleString('en-US')} ج.م</p>
               </div>
               <button 
                 onClick={() => handleCheckout('completed')}
                 disabled={isProcessing || cart.length === 0 || hasInvalidStockQuantity}
                 data-nav="checkout-button"
                 onKeyDown={handleInputKeyDown}
                 className="flex min-h-11 items-center gap-2 rounded-2xl bg-emerald-700 px-8 py-3 font-black text-white shadow-md transition-colors hover:bg-emerald-600"
               >
                 {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <ShoppingCart className="w-5 h-5" />}
                 إتمام البيع
               </button>
            </div>
          </div>
        </div>
      </div>

      {/* Right Search Area */}
      <div className="flex w-full shrink-0 flex-col gap-4 xl:w-[300px]">
         <POSSearchSidebar ref={searchSidebarRef} addToCart={addToCart} onKeyDown={handleInputKeyDown} showStock={canViewStock} />

         {alternatives.length > 0 && (
            <div className="bg-indigo-50 dark:bg-indigo-900/20 p-5 rounded-3xl border border-indigo-100 dark:border-indigo-900/40">
              <h4 className="font-black text-indigo-900 dark:text-indigo-200 text-xs mb-3 flex items-center gap-2"><Pill aria-hidden="true" className="h-4 w-4" />بدائل مقترحة</h4>
              <div className="space-y-2 max-h-[200px] overflow-auto">
                {[...alternatives].sort((a, b) => (b.total_stock || 0) - (a.total_stock || 0)).map(a => (
                  <button key={a.id} onClick={() => addToCart(a)} className="w-full flex justify-between items-center bg-white dark:bg-slate-800 p-2 rounded-xl text-[11px] font-black shadow-sm">
                    <div className="flex flex-col text-right">
                      <span className="dark:text-white truncate max-w-[150px]">{a.trade_name_en || a.trade_name}</span>
                      <span className="text-slate-600 dark:text-slate-300">{a.total_stock} in stock</span>
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
        allowNegativeSale={canSellNoStock}
        onNewPurchaseOrder={(drugId) => {
          toast.dismiss(); // dismiss any existing toasts so they don't pile up
          toast('جاري الانتقال لإنشاء فاتورة شراء...', { duration: 1500, icon: '🔄' });
          setShowStockWarning(null);
          router.push(`/purchases/new?drugId=${drugId}`);
        }}
        onNegativeSale={(drug) => {
          const drugId = String(drug.id);
          const defaultUnit = 'large';
          setCart(prev => {
            const existing = prev.find(i => String(i.drug_id) === drugId && i.selectedUnit === defaultUnit);
            if (existing) return prev.map(i => i.id === existing.id ? { ...i, qty: i.qty + 1 } : i);
            const newItemId = `${drugId}-${defaultUnit}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
            return [...prev, {
              id: newItemId,
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
          <div ref={returnDialogRef} role="dialog" aria-modal="true" aria-labelledby="pos-return-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') setShowReturnModal(false); }} className="bg-slate-50 dark:bg-slate-950 rounded-3xl w-full max-w-[95vw] h-[90vh] shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-white dark:bg-slate-900">
              <div>
                <h3 id="pos-return-title" className="text-2xl font-black flex items-center gap-3">
                  <RotateCcw className="w-7 h-7 text-rose-500" /> اختصار المرتجع السريع
                </h3>
                <p className="text-slate-500 font-bold text-sm">ابحث عن الفاتورة أو امسح الباركود للبدء</p>
              </div>
              <button 
                type="button"
                aria-label="إغلاق المرتجع السريع"
                onClick={() => setShowReturnModal(false)} 
                className="p-3 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-2xl transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="flex-1 overflow-auto p-8">
               <ReturnsClient title="مرتجعات المبيعات" />
            </div>

            <div className="p-6 bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 text-center">
              <button 
                type="button"
                onClick={() => setShowReturnModal(false)}
                className="px-10 py-4 bg-slate-800 text-white rounded-2xl font-black hover:bg-slate-700 transition-all"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      <PosDrawerHandoverModal 
        isOpen={showHandoverModal} 
        onClose={() => setShowHandoverModal(false)} 
      />

      {showAddPatientModal && currentUser && (
        <AddPatientModal
          pharmacyId={currentUser.pharmacy_id}
          onClose={() => setShowAddPatientModal(false)}
          onSuccess={(patient) => {
            if (patient) {
              setSelectedPatient(patient);
              if (patient.payment_method && ['cash', 'credit', 'visa', 'wallet'].includes(patient.payment_method)) {
                setPaymentMethod(patient.payment_method);
              }
            }
            setPatientResults([]);
            setPatientSearch('');
            setShowAddPatientModal(false);
          }}
        />
      )}

      {/* Item Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-[300] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden w-64 animate-in fade-in zoom-in duration-200"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className="p-2 space-y-1">
            <ContextMenuItem 
              icon={PlusCircle} 
              label="إضافة وحدة أخرى (شريط / علبة)" 
              onClick={() => {
                const item = cart.find(i => i.id === contextMenu.cartItemId);
                if (item) addAnotherUnitRow(item);
              }} 
            />
            <ContextMenuItem 
              icon={Info} 
              label="معلومات الصنف (F2)" 
              onClick={() => setShowDrugDetails(contextMenu.drugId)} 
            />
            {canViewRestock && <ContextMenuItem
              icon={PlusCircle} 
              label="إضافة إلى النواقص (F9)" 
              onClick={async () => {
                const res = await addToShortagesAction({ drug_id: contextMenu.drugId });
                if (res.success) toast.success('تمت الإضافة إلى النواقص');
                else toast.error((res as any).error);
              }} 
            />}
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
              onClick={() => setCart(p => p.filter(i => i.id !== contextMenu.cartItemId))} 
            />
          </div>
        </div>
      )}

      {/* Drug Details Modal */}
      {showDrugDetails && (
        <DrugDetailsModal 
          drugId={showDrugDetails} 
          onClose={() => setShowDrugDetails(null)} 
          onDrugUpdated={(updatedDrug) => {
            if (Number(updatedDrug.stop_dealing || 0) === 1) {
              setCart(prev => prev.filter(item => String(item.drug_id) !== String(updatedDrug.id)));
              return;
            }
            setCart(prev => prev.map(item => String(item.drug_id) === String(updatedDrug.id) ? {
              ...item,
              trade_name: updatedDrug.trade_name,
              trade_name_en: updatedDrug.trade_name_en,
              active_ingredient: updatedDrug.active_ingredient,
              basePrice: updatedDrug.official_price || updatedDrug.min_price || item.basePrice,
              price: item.selectedUnit === 'medium' ? (updatedDrug.official_price || item.basePrice) / (updatedDrug.large_to_medium || 1) :
                     item.selectedUnit === 'small' ? (updatedDrug.official_price || item.basePrice) / ((updatedDrug.large_to_medium || 1) * (updatedDrug.medium_to_small || 1)) :
                     (updatedDrug.official_price || item.basePrice),
              units: {
                ...item.units,
                large: updatedDrug.large_unit || item.units.large,
                medium: updatedDrug.medium_unit || item.units.medium,
                small: updatedDrug.small_unit || item.units.small,
                large_to_medium: updatedDrug.large_to_medium,
                medium_to_small: updatedDrug.medium_to_small
              }
            } : item));
          }}
          onDrugDeleted={(deletedId) => {
            setCart(prev => prev.filter(item => String(item.drug_id) !== String(deletedId)));
          }}
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
      type="button"
      onClick={onClick}
      className="group flex min-h-11 min-w-16 flex-col items-center justify-center gap-0.5 rounded-xl p-1 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 xl:w-full xl:min-w-0"
    >
      <div className={`p-2 rounded-lg ${color} text-white`}>
        <Icon className="w-4 h-4" />
      </div>
      <span className="text-[11px] font-black text-slate-600 dark:text-slate-300 text-center leading-tight truncate w-full">{label}</span>
    </button>
  );
}

function TotalLabel({ label, value, color = "text-slate-600 dark:text-slate-300" }: any) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] font-black text-slate-500">{label}</span>
      <span className={`text-sm font-black ${color}`}>{value}</span>
    </div>
  );
}

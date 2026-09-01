'use client';
import { useHotkeys } from 'react-hotkeys-hook';


import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  DollarSign, Landmark, Receipt, FileStack, AlertCircle, 
  CreditCard, TrendingUp, Wallet, ArrowRightLeft, PieChart,
  Plus, Search, Filter, Printer, X, Save, Activity, ArrowRight,
  Monitor, Settings, Database, Trash2, Edit, BarChart3, ShieldCheck,
  FileText, Download, CheckCircle, ChevronDown, ChevronLeft, FolderOpen,
  Clock
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { FinancialNoticeForm } from './FinancialComponents';
import TrialBalanceSettingsClient from './TrialBalanceSettingsClient';
import TrialBalanceReport from '@/components/reports/TrialBalanceReport';
import CashTransactionsClient from './CashTransactionsClient';
import { getExpensesAction, addExpenseAction } from '@/app/actions-client/expenses';
import { getClientSession } from '@/lib/auth/local';
import { 
  createCashMovementAction, 
  getCashMovementsAction, 
  getPointsOfSaleAction,
  addPointOfSaleAction,
  updatePointOfSaleAction,
  deletePointOfSaleAction,
  getExpenseDefinitionsAction,
  addExpenseDefinitionAction,
  updateExpenseDefinitionAction,
  deleteExpenseDefinitionAction,
  getBanksAction,
  addBankAction,
  updateBankAction,
  deleteBankAction,
  getPapersAction,
  addPaperAction,
  updatePaperStatusAction,
  deletePaperAction,
  getCardsAction,
  addCardAction,
  updateCardAction,
  deleteCardAction,
  getAccountsAction,
  getJournalsAction,
  createManualJournalAction,
  addAccountAction,
  updateAccountAction,
  deleteAccountAction,
  getJournalDetailsAction,
  getFinancialNoticesAction,
  getActivityLogsAction,
  getTreasuryDashboardAction,
  type TreasuryMetricKey
} from '@/app/actions-client/finance';
import { format, isValid } from 'date-fns';
import { toast } from 'react-hot-toast';

const safeFormat = (dateStr: string | null | undefined, fmt: string) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return isValid(d) ? format(d, fmt) : '-';
};

const hasConfiguredPermission = (user: any, permission: string) => {
  if (user?.role === 'owner') return true;
  let values = user?.permissions;
  try { if (typeof values === 'string') values = JSON.parse(values); } catch { return false; }
  if (Array.isArray(values)) return values.includes(permission);
  return values?.[permission] === true || values?.[permission] === 'true' || values?.[permission] == 1;
};

const ACCOUNT_TABS = [
  // 1. Core Financials
  { group: 'المحاسبة العامة', items: [
    { id: 'chart_of_accounts', label: 'شجرة الحسابات', icon: Database, color: 'text-slate-600', bg: 'bg-slate-50', permission: 'acc_can_view_general' },
    { id: 'daily_journals', label: 'القيود اليومية', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50', permission: 'acc_can_make_daily_entries' },
    { id: 'trial_balance', label: 'ميزان المراجعة', icon: BarChart3, color: 'text-purple-600', bg: 'bg-purple-50', permission: 'acc_can_view_reports' },
    { id: 'trial_balance_settings', label: 'إعدادات الميزان', icon: Settings, color: 'text-blue-600', bg: 'bg-blue-50', permission: 'acc_can_view_general' },
  ]},
  
  // 2. Cash Management
  { group: 'إدارة النقدية', items: [
    { id: 'treasury', label: 'الخزينة والتوريدات', icon: Wallet, color: 'text-emerald-600', bg: 'bg-emerald-50', permission: 'acc_can_view_general' },
    { id: 'cash_movement', label: 'حركة النقدية', icon: ArrowRightLeft, color: 'text-blue-600', bg: 'bg-blue-50', permission: 'acc_can_process_cash_flow' },
    { id: 'pos_management', label: 'نقط البيع', icon: Monitor, color: 'text-purple-600', bg: 'bg-purple-50', permission: 'acc_can_view_pos' },
  ]},

  // 3. Banks & Credit
  { group: 'البنوك والائتمان', items: [
    { id: 'banks', label: 'الحسابات البنكية', icon: Landmark, color: 'text-blue-600', bg: 'bg-blue-50', permission: 'acc_can_view_bank_accounts' },
    { id: 'papers', label: 'الأوراق المالية', icon: FileStack, color: 'text-purple-600', bg: 'bg-purple-50', permission: 'acc_can_view_securities' },
    { id: 'cards', label: 'البطاقات الائتمانية', icon: CreditCard, color: 'text-indigo-600', bg: 'bg-indigo-50', permission: 'acc_can_collect_credit_cards' },
  ]},

  // 4. Expenses
  { group: 'المصروفات', items: [
    { id: 'expense_definitions', label: 'تعريف المصروفات', icon: Settings, color: 'text-amber-600', bg: 'bg-amber-50', permission: 'acc_can_define_expenses' },
    { id: 'expenses', label: 'المصاريف التشغيلية', icon: Receipt, color: 'text-rose-600', bg: 'bg-rose-50', permission: 'can_view_expenses' },
  ]},

  // 5. Adjustments & Audit
  { group: 'التسويات والرقابة', items: [
    { id: 'notices', label: 'الإشعارات والتسويات', icon: AlertCircle, color: 'text-amber-600', bg: 'bg-amber-50', permission: 'acc_can_view_notifications' },
    { id: 'daily_reports', label: 'تقارير الوردية', icon: BarChart3, color: 'text-rose-600', bg: 'bg-rose-50', permission: 'can_view_shifts' },
    { id: 'audit_logs', label: 'سجل الرقابة', icon: ShieldCheck, color: 'text-slate-600', bg: 'bg-slate-50', permission: 'can_view_audit' },
  ]},
];

export default function AccountsManagementClient({ initialTab = 'treasury' }: { initialTab?: string }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [showCashForm, setShowCashForm] = useState<{ show: boolean, type: 'disbursement' | 'receipt' }>({ show: false, type: 'disbursement' });
  const [treasurySearch, setTreasurySearch] = useState('');
  const [treasuryView, setTreasuryView] = useState<'all' | 'handovers' | 'disbursements' | 'receipts'>('all');
  const [treasurySummary, setTreasurySummary] = useState({
    treasuryBalance: 0,
    todayReceipts: 0,
    todayExpenses: 0,
    totalShiftHandovers: 0,
    counts: { treasury: 0, receipts: 0, expenses: 0, handovers: 0 },
  });
  const [selectedTreasuryMetric, setSelectedTreasuryMetric] = useState<TreasuryMetricKey | null>(null);
  const [treasuryDetails, setTreasuryDetails] = useState<any[]>([]);
  const [treasuryDetailCount, setTreasuryDetailCount] = useState(0);
  const [loadingTreasuryDetails, setLoadingTreasuryDetails] = useState(false);
  const [movements, setMovements] = useState<any[]>([]);
  const [pointsOfSale, setPointsOfSale] = useState<any[]>([]);
  const [expenseDefinitions, setExpenseDefinitions] = useState<any[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [papers, setPapers] = useState<any[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [journals, setJournals] = useState<any[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [coaViewMode, setCoaViewMode] = useState<'table' | 'tree'>('tree');
  const [showAddAccount, setShowAddAccount] = useState<{ show: boolean, parentId: number | null }>({ show: false, parentId: null });
  const [editingAccount, setEditingAccount] = useState<any | null>(null);

  const handleDeleteAccount = async (acc: any) => {
    if (!window.confirm(`هل أنت متأكد من حذف الحساب "${acc.name_ar}" (كود: ${acc.code})؟`)) return;
    const res = await deleteAccountAction(acc.id);
    if (res.success) {
      toast.success('تم حذف الحساب بنجاح');
      loadTabData();
    } else {
      toast.error(res.error || 'فشل حذف الحساب');
    }
  };
  const [selectedJournalId, setSelectedJournalId] = useState<string | null>(null);

  const [showAddExpenseModal, setShowAddExpenseModal] = useState(false);
  const [editingExpenseDef, setEditingExpenseDef] = useState<any | null>(null);
  const [expenseDefSearch, setExpenseDefSearch] = useState('');

  const handleDeleteExpenseDef = async (exp: any) => {
    if (!window.confirm(`هل أنت متأكد من حذف تعريف المصروف "${exp.name_ar}" (كود: ${exp.code})؟`)) return;
    const res = await deleteExpenseDefinitionAction(exp.id);
    if (res.success) {
      toast.success('تم حذف تعريف المصروف بنجاح');
      loadTabData();
    } else {
      toast.error(res.error || 'فشل حذف تعريف المصروف');
    }
  };

  const [noticesList, setNoticesList] = useState<any[]>([]);
  const [noticeSearch, setNoticeSearch] = useState('');
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [auditSearch, setAuditSearch] = useState('');
  const [expensesList, setExpensesList] = useState<any[]>([]);
  const [expenseSearch, setExpenseSearch] = useState('');
  const [showRecordExpenseModal, setShowRecordExpenseModal] = useState(false);

  // Banks State & Handlers
  const [showAddBankModal, setShowAddBankModal] = useState(false);
  const [editingBank, setEditingBank] = useState<any | null>(null);
  const handleDeleteBank = async (bank: any) => {
    if (!window.confirm(`هل أنت متأكد من حذف الحساب البنكي "${bank.name_ar}"؟`)) return;
    const res = await deleteBankAction(bank.id);
    if (res.success) {
      toast.success('تم حذف الحساب البنكي بنجاح');
      loadTabData();
    } else {
      toast.error(res.error || 'فشل حذف الحساب البنكي');
    }
  };

  // Cards State & Handlers
  const [showAddCardModal, setShowAddCardModal] = useState(false);
  const [editingCard, setEditingCard] = useState<any | null>(null);
  const handleDeleteCard = async (card: any) => {
    if (!window.confirm(`هل أنت متأكد من حذف ماكينة الدفع "${card.name_ar}"؟`)) return;
    const res = await deleteCardAction(card.id);
    if (res.success) {
      toast.success('تم حذف ماكينة الدفع بنجاح');
      loadTabData();
    } else {
      toast.error(res.error || 'فشل حذف ماكينة الدفع');
    }
  };

  // POS State & Handlers
  const [showAddPosModal, setShowAddPosModal] = useState(false);
  const [editingPos, setEditingPos] = useState<any | null>(null);
  const handleDeletePos = async (pos: any) => {
    if (!window.confirm(`هل أنت متأكد من حذف نقطة البيع "${pos.name_ar}"؟`)) return;
    const res = await deletePointOfSaleAction(pos.id);
    if (res.success) {
      toast.success('تم حذف نقطة البيع بنجاح');
      loadTabData();
    } else {
      toast.error(res.error || 'فشل حذف نقطة البيع');
    }
  };

  // Commercial Papers State & Handlers
  const [showAddPaperModal, setShowAddPaperModal] = useState<{ show: boolean; type: 'check' | 'promissory_note'; direction: 'in' | 'out' }>({ show: false, type: 'check', direction: 'out' });
  const [paperSearch, setPaperSearch] = useState('');
  const handleDeletePaper = async (paper: any) => {
    if (!window.confirm(`هل أنت متأكد من حذف الورقة المالية رقم "${paper.paper_number}"؟`)) return;
    const res = await deletePaperAction(paper.id);
    if (res.success) {
      toast.success('تم حذف الورقة المالية بنجاح');
      loadTabData();
    } else {
      toast.error(res.error || 'فشل حذف الورقة المالية');
    }
  };
  const handleUpdatePaperStatus = async (paper: any, newStatus: 'pending' | 'cashed' | 'bounced' | 'cancelled') => {
    const statusNames: Record<string, string> = {
      cashed: paper.direction === 'in' ? 'تحصيل الشيك وإيداعه في الخزينة' : 'صرف الشيك وخصمه من الخزينة',
      bounced: 'ارتداد الشيك (مرفوض)',
      cancelled: 'إلغاء الشيك',
      pending: 'إرجاع لحالة الانتظار'
    };
    if (!window.confirm(`تأكيد عملية: ${statusNames[newStatus]}؟`)) return;
    const res = await updatePaperStatusAction(paper.id, newStatus);
    if (res.success) {
      toast.success('تم تحديث حالة الورقة المالية بنجاح');
      loadTabData();
    } else {
      toast.error(res.error || 'فشل تحديث حالة الورقة المالية');
    }
  };

  // Manual Journal Modal
  const [showAddJournalModal, setShowAddJournalModal] = useState(false);

  useHotkeys('f4', (e) => {
    e.preventDefault();
    if (activeTab === 'expenses' && hasConfiguredPermission(sessionUser, 'acc_can_define_expenses')) {
      setShowRecordExpenseModal(true);
    }
  }, { enableOnFormTags: true });

  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [sessionUser, setSessionUser] = useState<any>(null);
  const [isMounted, setIsMounted] = useState(false);

  const visibleAccountTabs = ACCOUNT_TABS
    .map(group => ({
      ...group,
      items: group.items.filter(tab => sessionUser && hasConfiguredPermission(sessionUser, tab.permission)),
    }))
    .filter(group => group.items.length > 0);

  useEffect(() => {
     setIsMounted(true);
     if (!sessionUser) return;
     const allowed = visibleAccountTabs.some(group => group.items.some(tab => tab.id === activeTab));
     if (!allowed) {
       const firstAllowed = visibleAccountTabs[0]?.items[0]?.id;
       if (firstAllowed) setActiveTab(firstAllowed);
       return;
     }
     loadTabData();
     // The active tab is the loader's only changing input.
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, sessionUser]);

  useEffect(() => {
     getClientSession().then(user => {
       setSessionUser(user);
       setUserRole(user?.role || 'pharmacist');
     });
  }, []);

  const loadTabData = async () => {
     setLoadingData(true);
     try {
        if (activeTab === 'treasury') {
           const [summaryRes, movementsRes, posRes, banksRes] = await Promise.all([
             getTreasuryDashboardAction(),
             getCashMovementsAction(),
             getPointsOfSaleAction(),
             getBanksAction(),
           ]);
           if (summaryRes.success && summaryRes.data) setTreasurySummary(summaryRes.data as typeof treasurySummary);
           if (movementsRes.success) setMovements(movementsRes.data as any[]);
           if (posRes.success) setPointsOfSale(posRes.data as any[]);
           if (banksRes.success) setBanks(banksRes.data as any[]);
        } else if (activeTab === 'cash_movement') {
           const res = await getCashMovementsAction();
           if (res.success) setMovements(res.data as any[]);
        } else if (activeTab === 'pos_management') {
           const res = await getPointsOfSaleAction();
           if (res.success) setPointsOfSale(res.data as any[]);
        } else if (activeTab === 'expense_definitions') {
           const res = await getExpenseDefinitionsAction();
           if (res.success) setExpenseDefinitions(res.data as any[]);
        } else if (activeTab === 'banks') {
           const res = await getBanksAction();
           if (res.success) setBanks(res.data as any[]);
        } else if (activeTab === 'papers') {
           const [papersRes, banksRes] = await Promise.all([getPapersAction(), getBanksAction()]);
           if (papersRes.success) setPapers(papersRes.data as any[]);
           if (banksRes.success) setBanks(banksRes.data as any[]);
        } else if (activeTab === 'cards') {
           const [cardsRes, banksRes] = await Promise.all([getCardsAction(), getBanksAction()]);
           if (cardsRes.success) setCards(cardsRes.data as any[]);
           if (banksRes.success) setBanks(banksRes.data as any[]);
        } else if (activeTab === 'chart_of_accounts') {
           const res = await getAccountsAction();
           if (res.success) setAccounts(res.data as any[]);
        } else if (activeTab === 'daily_journals') {
           const [journalsRes, accountsRes] = await Promise.all([getJournalsAction(), getAccountsAction()]);
           if (journalsRes.success) setJournals(journalsRes.data as any[]);
           if (accountsRes.success) setAccounts(accountsRes.data as any[]);
        } else if (activeTab === 'expenses') {
            const [res, defsRes] = await Promise.all([
               getExpensesAction(),
               getExpenseDefinitionsAction()
            ]);
            if (res.success) setExpensesList(res.data as any[]);
            if (defsRes.success) setExpenseDefinitions(defsRes.data as any[]);
        } else if (activeTab === 'notices') {
           const res = await getFinancialNoticesAction();
           if (res.success) setNoticesList(res.data as any[]);
        } else if (activeTab === 'audit_logs') {
           const res = await getActivityLogsAction();
           if (res.success) setActivityLogs(res.data as any[]);
        }
     } catch (error) {
        console.error('Load data error:', error);
     }
     setLoadingData(false);
  };

  const {
    treasuryBalance,
    todayReceipts,
    todayExpenses,
    totalShiftHandovers,
  } = treasurySummary;

  const openTreasuryMetric = async (metric: TreasuryMetricKey) => {
    setSelectedTreasuryMetric(metric);
    setTreasuryDetails([]);
    setLoadingTreasuryDetails(true);
    const result = await getTreasuryDashboardAction(metric);
    if (result.success && result.data) {
      setTreasurySummary(result.data as typeof treasurySummary);
      setTreasuryDetails(result.data.details || []);
      setTreasuryDetailCount(Number(result.data.detailCount || 0));
    } else {
      toast.error(result.error || 'فشل جلب تفاصيل الرقم');
    }
    setLoadingTreasuryDetails(false);
  };

  const totalLiquidity = treasuryBalance + 
     pointsOfSale.reduce((sum, pos) => sum + (Number(pos.current_balance) || 0), 0) + 
     banks.reduce((sum, b) => sum + (Number(b.current_balance ?? b.balance) || 0), 0);

  const filteredTreasuryMovements = movements.filter(m => {
     if (treasuryView === 'handovers' && m.category !== 'handover') return false;
     if (!treasurySearch.trim()) return true;
     const q = treasurySearch.toLowerCase().trim();
     const notes = String(m.notes || '').toLowerCase();
     const cat = String(m.category || '').toLowerCase();
     const sub = String(m.sub_category || '').toLowerCase();
     const target = String(m.target_name || '').toLowerCase();
     const user = String(m.user_name || m.user_id || '').toLowerCase();
     const shift = String(m.shift_id || '').toLowerCase();
     const src = String(m.source_type || '').toLowerCase();
     const amt = String(m.amount || '');
     return notes.includes(q) || cat.includes(q) || sub.includes(q) || target.includes(q) || user.includes(q) || shift.includes(q) || src.includes(q) || amt.includes(q);
  });

  // Compute Expenses Stats Dynamically
  const currentMonthStr = format(new Date(), 'yyyy-MM');
  const totalMonthExpenses = expensesList
     .filter(e => e.date && e.date.startsWith(currentMonthStr))
     .reduce((sum, e) => sum + e.amount, 0);

  const categoryTotals = expensesList.reduce((acc: any, curr) => {
      acc[curr.category] = (acc[curr.category] || 0) + curr.amount;
      return acc;
  }, {});
   
  let largestCategory = 'لا يوجد';
  let maxAmount = 0;
  Object.entries(categoryTotals).forEach(([cat, amt]) => {
      if ((amt as number) > maxAmount) {
         maxAmount = amt as number;
         largestCategory = cat;
      }
  });
   
  const categoryTranslations: Record<string, string> = {
      'salaries': 'أجور ومرتبات',
      'rent': 'إيجارات',
      'electricity': 'كهرباء وإنارة',
      'water': 'مياه',
      'internet': 'إنترنت واتصالات',
      'transport': 'نقل ومواصلات',
      'supplies': 'مستلزمات ومواد',
      'operating_expenses': 'مصروفات تشغيلية',
      'personal': 'مسحوبات شخصية',
      'other': 'مصاريف متنوعة'
  };

  const getCategoryDisplayName = (cat: string) => {
     if (!cat) return '-';
     const foundDef = expenseDefinitions.find(
        d => (d.code && String(d.code).toLowerCase() === String(cat).toLowerCase()) ||
             (d.name_ar && d.name_ar === cat) ||
             (d.name_en && d.name_en.toLowerCase() === String(cat).toLowerCase())
     );
     if (foundDef) return foundDef.name_ar;
     if (categoryTranslations[String(cat).toLowerCase()]) return categoryTranslations[String(cat).toLowerCase()];
     return cat;
  };

  const largestCategoryLabel = largestCategory === 'لا يوجد' ? 'لا يوجد' : getCategoryDisplayName(largestCategory);
  const canProcessCash = hasConfiguredPermission(sessionUser, 'acc_can_process_cash_flow');
  const canManageExpenses = hasConfiguredPermission(sessionUser, 'acc_can_define_expenses');
  const filteredActivityLogs = activityLogs.filter(log => {
    if (!auditSearch.trim()) return true;
    const q = auditSearch.trim().toLowerCase();
    return [log.action, log.details, log.user_name, log.created_at]
      .some(value => String(value || '').toLowerCase().includes(q));
  });

  if (!isMounted) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8" dir="rtl">
       {/* Sidebar Navigation */}
       <div className="lg:col-span-3 space-y-4">
          <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 p-4 shadow-sm">
             <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-6 mb-4">قائمة الحسابات</p>
             <div className="space-y-6">
                {visibleAccountTabs.map((group) => (
                   <div key={group.group} className="space-y-2">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-6 mb-2">{group.group}</p>
                      <div className="space-y-1">
                         {group.items.map((tab) => (
                            <button
                              key={tab.id}
                              onClick={() => setActiveTab(tab.id)}
                              className={cn(
                                "w-full flex items-center gap-4 px-6 py-4 rounded-[20px] font-black transition-all group",
                                activeTab === tab.id 
                                  ? "bg-slate-900 text-white shadow-xl translate-x-[-8px]" 
                                  : "text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800"
                              )}
                            >
                               <div className={cn(
                                 "w-9 h-9 rounded-xl flex items-center justify-center transition-all",
                                 activeTab === tab.id ? "bg-white/20" : tab.bg
                               )}>
                                  <tab.icon className={cn("w-4.5 h-4.5", activeTab === tab.id ? "text-white" : tab.color)} />
                               </div>
                               <span className="text-sm truncate">{tab.label}</span>
                            </button>
                         ))}
                      </div>
                   </div>
                ))}
             </div>
          </div>

          <div className="bg-gradient-to-br from-indigo-600 to-purple-700 rounded-[40px] p-8 text-white shadow-2xl">
             <TrendingUp className="w-12 h-12 mb-6 opacity-50" />
             <h4 className="text-xl font-black mb-2">إجمالي السيولة</h4>
             <p className="text-4xl font-black mb-1">
                {totalLiquidity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 
                <span className="text-sm opacity-70"> ج.م</span>
             </p>
             <p className="text-sm font-bold opacity-60">محدث الآن من الخزينة ونقاط البيع والبنوك</p>
          </div>
       </div>

       {/* Content Area */}
       <div className="lg:col-span-9 space-y-8">
          {activeTab === 'treasury' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black text-slate-800 dark:text-white">سجل توريدات وحركات النقدية</h2>
                      <p className="text-slate-500 font-bold">متابعة جميع المبالغ الداخلة والخارجة من الخزينة ونقاط البيع</p>
                   </div>
                   <div className="flex flex-wrap items-center gap-3">
                     <Link
                       href="/shifts"
                       className="px-5 py-4 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-[20px] font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-all flex items-center gap-2 text-sm"
                     >
                       <Clock className="w-4 h-4 text-blue-500" />
                       الورديات
                     </Link>
                     <Link
                       href="/finance/handover"
                       className="px-5 py-4 bg-blue-600 text-white rounded-[20px] font-black hover:bg-blue-700 transition-all shadow-xl shadow-blue-500/20 text-sm"
                     >
                       تسليم الدرج
                     </Link>
                     <button onClick={() => window.print()} className="p-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-[20px] hover:bg-slate-200 transition-all no-print">
                       <Printer className="w-5 h-5" />
                     </button>
                      {canProcessCash && <button
                        onClick={() => {
                           setActiveTab('cash_movement');
                           setShowCashForm({ show: true, type: 'disbursement' });
                       }}
                       className="px-6 py-4 bg-rose-600 text-white rounded-[20px] font-black hover:bg-rose-700 transition-all shadow-xl shadow-rose-500/20 flex items-center gap-2 text-sm"
                      >
                         <Plus className="w-4 h-4" /> صرف نقدية
                      </button>}
                      {canProcessCash && <button
                        onClick={() => {
                           setActiveTab('cash_movement');
                           setShowCashForm({ show: true, type: 'receipt' });
                       }}
                       className="px-6 py-4 bg-emerald-600 text-white rounded-[20px] font-black hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-2 text-sm"
                      >
                         <Plus className="w-4 h-4" /> إضافة توريد جديد
                      </button>}
                   </div>
                </div>

                 <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                    <StatCard label="رصيد الخزينة" value={treasuryBalance.toLocaleString('en-US')} color="emerald" icon={Wallet} onClick={() => openTreasuryMetric('treasury')} active={selectedTreasuryMetric === 'treasury'} />
                    <StatCard label="توريدات اليوم" value={todayReceipts.toLocaleString('en-US')} color="blue" icon={ArrowRightLeft} onClick={() => openTreasuryMetric('receipts')} active={selectedTreasuryMetric === 'receipts'} />
                    <StatCard label="المصروفات اليومية" value={todayExpenses.toLocaleString('en-US')} color="rose" icon={Receipt} onClick={() => openTreasuryMetric('expenses')} active={selectedTreasuryMetric === 'expenses'} />
                    <StatCard label="إجمالي تسليمات الورديات" value={totalShiftHandovers.toLocaleString('en-US')} color="blue" icon={ShieldCheck} onClick={() => openTreasuryMetric('handovers')} active={selectedTreasuryMetric === 'handovers'} />
                 </div>

                 {selectedTreasuryMetric && (
                    <TreasuryMetricDetails
                      metric={selectedTreasuryMetric}
                      total={{ treasury: treasuryBalance, receipts: todayReceipts, expenses: todayExpenses, handovers: totalShiftHandovers }[selectedTreasuryMetric]}
                      details={treasuryDetails}
                      detailCount={treasuryDetailCount}
                      loading={loadingTreasuryDetails}
                      onClose={() => setSelectedTreasuryMetric(null)}
                    />
                 )}

                 <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                     <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex flex-wrap justify-between items-center gap-4">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="bg-slate-100 dark:bg-slate-800 p-1 rounded-xl flex gap-1">
                            <button onClick={() => setTreasuryView('all')} className={cn('px-4 py-2 rounded-lg text-xs font-black', treasuryView === 'all' ? 'bg-white dark:bg-slate-700 shadow text-blue-600' : 'text-slate-500')}>كل الحركات</button>
                            <button onClick={() => setTreasuryView('handovers')} className={cn('px-4 py-2 rounded-lg text-xs font-black', treasuryView === 'handovers' ? 'bg-white dark:bg-slate-700 shadow text-blue-600' : 'text-slate-500')}>سجل التسليمات</button>
                          </div>
                          <div className="relative w-96 max-w-full">
                          <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                          <input 
                             type="text" 
                             placeholder="بحث في السجل (البيان، المستلم، المستخدم، القيمة)..." 
                             value={treasurySearch}
                             onChange={(e) => setTreasurySearch(e.target.value)}
                             className="w-full pr-14 pl-10 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none font-bold text-xs" 
                          />
                          {treasurySearch && (
                             <button onClick={() => setTreasurySearch('')} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                <X className="w-4 h-4" />
                             </button>
                          )}
                       </div>
                        <span className="text-xs font-black text-slate-400">عدد الحركات: ({filteredTreasuryMovements.length})</span>
                     </div>
                     </div>
                     <table className="w-full text-right">
                       <thead className="bg-slate-50 dark:bg-slate-800/50">
                          <tr>
                             <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">التاريخ</th>
                             <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">البيان / التصنيف</th>
                             <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">المبلغ</th>
                             <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">الحساب المتأثر / الوردية</th>
                          </tr>
                       </thead>
                       <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {loadingData ? (
                             <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                          ) : filteredTreasuryMovements.length === 0 ? (
                             <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic font-bold">{treasurySearch ? 'لا توجد نتائج مطابقة للبحث' : 'لا توجد حركات نقدية مسجلة'}</td></tr>
                          ) : filteredTreasuryMovements.slice(0, 50).map(m => (
                             <tr key={`treasury-mov-${m.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                                <td className="px-8 py-5 font-bold text-slate-500 text-xs" dir="ltr">{safeFormat(m.created_at || m.date, 'yyyy/MM/dd HH:mm')}</td>
                                <td className="px-8 py-5">
                                   <p className="font-black text-slate-800 dark:text-white text-sm">
                                      {m.category === 'operating_expenses' ? 'مصروفات تشغيل' : 
                                       m.category === 'salaries' ? 'أجور ومرتبات' :
                                       m.category === 'rent' ? 'إيجار' :
                                       m.category === 'electricity' ? 'كهرباء' :
                                       m.category === 'personal' ? 'مسحوبات شخصية' :
                                       m.category === 'patient' ? 'توريد من عميل' : 
                                       m.category === 'supplier' ? 'توريد من مورد' : 
                                       m.category === 'pharmacy' ? 'توريد للصيدلية' :
                                       m.category === 'handover' ? 'تسليم درج' : m.category || (m.type === 'receipt' ? 'توريد نقدية' : 'صرف نقدية')}
                                   </p>
                                   <p className="text-[11px] text-slate-400 font-bold mt-0.5">
                                      {[m.sub_category, m.target_name, m.notes].filter(Boolean).join(' • ') || '—'}
                                   </p>
                                </td>
                                <td className={cn("px-8 py-5 font-black text-lg", m.type === 'receipt' ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                                   {m.type === 'receipt' ? `+${Number(m.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : `-${Number(m.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`} <span className="text-xs">ج.م</span>
                                </td>
                                <td className="px-8 py-5">
                                   <div className="flex flex-col gap-1">
                                      <span className="bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 px-3 py-1 rounded-full text-xs font-black w-fit">
                                         {m.source_type === 'pos' ? 'نقطة البيع' : m.source_type === 'main_safe' ? 'خزينة المحل' : m.source_type === 'admin' ? 'خزينة الإدارة' : m.source_type === 'user_drawer' ? `درج ${m.user_name || 'المستخدم'}` : m.source_type === 'user_drawer_received' ? `درج ${m.user_name || 'المستلم'}` : m.source_type || 'الخزينة'}
                                      </span>
                                      {m.shift_id && (
                                         <Link href="/shifts" className="text-[10px] font-mono text-slate-400 hover:text-blue-500">
                                            وردية #{String(m.shift_id).slice(0, 8)}
                                         </Link>
                                      )}
                                   </div>
                                </td>
                             </tr>
                          ))}
                       </tbody>
                    </table>
                  </div>
               </div>
           )}

          {activeTab === 'cash_movement' && (
             <div className="animate-in fade-in slide-in-from-left-4">
                <CashTransactionsClient 
                  initialShowForm={showCashForm} 
                  onFormClose={() => setShowCashForm({ show: false, type: 'disbursement' })} 
                />
             </div>
          )}

          {activeTab === 'pos_management' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black">إدارة نقاط البيع</h2>
                      <p className="text-slate-500 font-bold">تعريف ومتابعة أرصدة نقاط البيع المختلفة</p>
                   </div>
                   <div className="flex items-center gap-4">
                     <button onClick={() => window.print()} className="p-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-[24px] hover:bg-slate-200 transition-all no-print">
                       <Printer className="w-6 h-6" />
                     </button>
                     <button
                       onClick={() => setShowAddPosModal(true)}
                       className="px-10 py-5 bg-purple-600 text-white rounded-[24px] font-black hover:bg-purple-700 transition-all shadow-xl shadow-purple-500/20 flex items-center gap-3 active:scale-95"
                     >
                        <Plus className="w-6 h-6" /> إضافة نقطة بيع
                     </button>
                   </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                            <th className="px-8 py-6">كود</th>
                            <th className="px-8 py-6">الإسم (Ar)</th>
                            <th className="px-8 py-6">الإسم (En)</th>
                            <th className="px-8 py-6">الرصيد الحالي</th>
                            <th className="px-8 py-6 text-center">الموقع / الكمبيوتر</th>
                            <th className="px-8 py-6 text-center">إجراءات</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={6} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                         ) : pointsOfSale.length === 0 ? (
                            <tr><td colSpan={6} className="py-20 text-center text-slate-400 italic font-bold">لا توجد نقاط بيع مسجلة. اضغط &quot;إضافة نقطة بيع&quot; للبدء.</td></tr>
                         ) : pointsOfSale.map(pos => (
                            <tr key={`pos-${pos.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                               <td className="px-8 py-6 font-mono font-black text-blue-600">#{pos.id}</td>
                               <td className="px-8 py-6 font-black">{pos.name_ar}</td>
                               <td className="px-8 py-6 font-bold text-slate-400 italic">{pos.name_en || '-'}</td>
                               <td className="px-8 py-6 font-black text-lg text-emerald-600 font-mono">{pos.current_balance?.toLocaleString('en-US') ?? '0'} ج.م</td>
                               <td className="px-8 py-6 text-center">
                                  <div className="flex flex-col items-center">
                                     <span className="font-bold text-slate-700 dark:text-slate-300 text-xs">{pos.location || 'نقطة رئيسية'}</span>
                                     <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{pos.computer_name || 'Terminal'}</span>
                                  </div>
                               </td>
                               <td className="px-8 py-6 text-center">
                                  <div className="flex justify-center gap-2">
                                     <button
                                       onClick={() => setEditingPos(pos)}
                                       title="تعديل نقطة البيع"
                                       className="p-3 bg-slate-100 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-slate-600 hover:text-blue-600 rounded-xl transition-all"
                                     >
                                        <Edit className="w-4 h-4" />
                                     </button>
                                     <button
                                       onClick={() => handleDeletePos(pos)}
                                       title="حذف نقطة البيع"
                                       className="p-3 bg-slate-100 dark:bg-slate-800 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-600 hover:text-rose-600 rounded-xl transition-all"
                                     >
                                        <Trash2 className="w-4 h-4" />
                                     </button>
                                  </div>
                               </td>
                            </tr>
                         ))}
                      </tbody>
                   </table>
                </div>
             </div>
          )}

          {activeTab === 'expense_definitions' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex flex-wrap justify-between items-center gap-4 bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black">تعريف المصروفات</h2>
                      <p className="text-slate-500 font-bold">تكويد وتصنيف أنواع المصاريف المختلفة</p>
                   </div>
                   <div className="flex flex-wrap items-center gap-3">
                      <Link
                         href="/expenses"
                         className="px-6 py-4 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-[20px] font-black text-sm flex items-center gap-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
                      >
                         <FileText className="w-5 h-5 text-amber-600" />
                         <span>سجل المصروفات التشغيلية</span>
                      </Link>
                      <button
                         onClick={() => setShowAddExpenseModal(true)}
                         className="px-8 py-4 bg-amber-600 hover:bg-amber-700 text-white rounded-[20px] font-black text-sm flex items-center gap-2 shadow-lg shadow-amber-600/20 active:scale-95 transition-all"
                      >
                         <Plus className="w-5 h-5" />
                         <span>إضافة نوع مصروف</span>
                      </button>
                   </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                   <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 bg-slate-50/50 dark:bg-slate-800/30">
                      <div className="relative flex-1 min-w-[280px]">
                         <Search className="w-5 h-5 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
                         <input
                            type="text"
                            value={expenseDefSearch}
                            onChange={e => setExpenseDefSearch(e.target.value)}
                            placeholder="بحث بالكود، أو اسم المصروف بالعربي أو الإنجليزي..."
                            className="w-full pl-6 pr-12 py-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm focus:border-amber-500 transition-all text-slate-900 dark:text-white"
                         />
                      </div>
                      <div className="text-xs font-black text-slate-400 px-2">
                         العدد: <span className="text-amber-600 font-mono text-sm">{expenseDefinitions.length}</span> تعريف
                      </div>
                   </div>

                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                            <th className="px-8 py-6">الكود</th>
                            <th className="px-8 py-6">الإسم (ع)</th>
                            <th className="px-8 py-6">الإسم (En)</th>
                            <th className="px-8 py-6">تاريخ الإنشاء</th>
                            <th className="px-8 py-6 text-center">إجراءات</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                         ) : expenseDefinitions.filter(exp => {
                            if (!expenseDefSearch.trim()) return true;
                            const q = expenseDefSearch.toLowerCase();
                            return (
                               (exp.code && String(exp.code).toLowerCase().includes(q)) ||
                               (exp.name_ar && exp.name_ar.toLowerCase().includes(q)) ||
                               (exp.name_en && exp.name_en.toLowerCase().includes(q))
                            );
                         }).length === 0 ? (
                            <tr>
                               <td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">
                                  {expenseDefSearch.trim() ? 'لا توجد نتائج مطابقة لبحثك.' : 'لا توجد تعريفات مسجلة.'}
                               </td>
                            </tr>
                         ) : expenseDefinitions.filter(exp => {
                            if (!expenseDefSearch.trim()) return true;
                            const q = expenseDefSearch.toLowerCase();
                            return (
                               (exp.code && String(exp.code).toLowerCase().includes(q)) ||
                               (exp.name_ar && exp.name_ar.toLowerCase().includes(q)) ||
                               (exp.name_en && exp.name_en.toLowerCase().includes(q))
                            );
                         }).map(exp => (
                             <tr key={`exp-${exp.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors group">
                                <td className="px-8 py-6 font-mono font-black text-amber-600">{exp.code}</td>
                                <td className="px-8 py-6 font-black text-slate-800 dark:text-white group-hover:text-amber-600 transition-colors">{exp.name_ar}</td>
                                <td className="px-8 py-6 font-bold text-slate-400 italic">{exp.name_en || '-'}</td>
                                <td className="px-8 py-6 font-bold text-slate-400">{safeFormat(exp.created_at, 'yyyy/MM/dd')}</td>
                                <td className="px-8 py-6 text-center">
                                   <div className="flex items-center justify-center gap-2">
                                      <button
                                        onClick={() => setEditingExpenseDef(exp)}
                                        title="تعديل تعريف المصروف"
                                        className="p-3 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/60 rounded-xl transition-all shadow-sm"
                                      >
                                         <Edit className="w-4 h-4" />
                                      </button>
                                      <button
                                        onClick={() => handleDeleteExpenseDef(exp)}
                                        title="حذف تعريف المصروف"
                                        className="p-3 bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/60 rounded-xl transition-all shadow-sm"
                                      >
                                         <Trash2 className="w-4 h-4" />
                                      </button>
                                   </div>
                                </td>
                             </tr>
                          ))}
                       </tbody>
                    </table>
                 </div>
              </div>
          )}

          {activeTab === 'notices' && (() => {
             const filteredNotices = noticesList.filter(n => {
                if (!noticeSearch.trim()) return true;
                const q = noticeSearch.toLowerCase();
                return (
                   (n.reason || '').toLowerCase().includes(q) ||
                   (n.notes || '').toLowerCase().includes(q) ||
                   (n.target_name || '').toLowerCase().includes(q) ||
                   (n.user_name || '').toLowerCase().includes(q) ||
                   (n.amount ? String(n.amount) : '').includes(q)
                );
             });

             const totalDebits = noticesList.filter(n => n.type === 'debit').reduce((sum, n) => sum + (n.amount || 0), 0);
             const totalCredits = noticesList.filter(n => n.type === 'credit').reduce((sum, n) => sum + (n.amount || 0), 0);
             const netEffect = totalDebits - totalCredits;

             return (
              <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                 <FinancialNoticeForm onSuccess={loadTabData} />
                 
                 {/* Summary Badges */}
                 <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center justify-between">
                       <div>
                          <p className="text-slate-400 font-bold text-xs uppercase tracking-wider">إجمالي الإشعارات المدينة (Debit)</p>
                          <p className="text-2xl font-black text-emerald-600 mt-1 font-mono">{totalDebits.toLocaleString()} <span className="text-xs">ج.م</span></p>
                       </div>
                       <div className="w-12 h-12 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 flex items-center justify-center font-black text-lg">+</div>
                    </div>
                    <div className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center justify-between">
                       <div>
                          <p className="text-slate-400 font-bold text-xs uppercase tracking-wider">إجمالي الإشعارات الدائنة (Credit)</p>
                          <p className="text-2xl font-black text-rose-600 mt-1 font-mono">{totalCredits.toLocaleString()} <span className="text-xs">ج.م</span></p>
                       </div>
                       <div className="w-12 h-12 rounded-2xl bg-rose-50 dark:bg-rose-900/20 text-rose-600 flex items-center justify-center font-black text-lg">-</div>
                    </div>
                    <div className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center justify-between">
                       <div>
                          <p className="text-slate-400 font-bold text-xs uppercase tracking-wider">صافي أثر التسويات</p>
                          <p className={cn("text-2xl font-black mt-1 font-mono", netEffect >= 0 ? "text-blue-600" : "text-amber-600")}>
                             {netEffect.toLocaleString()} <span className="text-xs">ج.م</span>
                          </p>
                       </div>
                       <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-900/20 text-blue-600 flex items-center justify-center font-black text-lg">∑</div>
                    </div>
                 </div>

                 <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                    <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
                       <div>
                          <h4 className="text-xl font-black text-slate-800 dark:text-white">سجل الإشعارات والتسويات الأخيرة</h4>
                          <p className="text-slate-400 font-bold text-xs">إجمالي {filteredNotices.length} إشعار مسجل في النظام</p>
                       </div>
                       <div className="flex items-center gap-3">
                          <div className="relative min-w-[260px]">
                              <Search className="w-4 h-4 absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" />
                              <input
                                 type="text"
                                 value={noticeSearch}
                                 onChange={e => setNoticeSearch(e.target.value)}
                                 placeholder="بحث بالسبب، الجهة، أو الملاحظات..."
                                 className="w-full pl-4 pr-10 py-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-xs focus:border-slate-500 transition-all text-slate-900 dark:text-white"
                              />
                           </div>
                           <button onClick={() => window.print()} className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-2xl hover:bg-slate-200 transition-all no-print">
                              <Printer className="w-5 h-5" />
                           </button>
                          </div>
                        </div>
                     <table className="w-full text-right">
                        <thead className="bg-slate-50 dark:bg-slate-800/50">
                           <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                              <th className="px-8 py-6">التاريخ</th>
                              <th className="px-8 py-6">النوع</th>
                              <th className="px-8 py-6">الجهة المستهدفة</th>
                              <th className="px-8 py-6">القيمة</th>
                              <th className="px-8 py-6">سبب الإشعار</th>
                              <th className="px-8 py-6">بواسطة</th>
                              <th className="px-8 py-6">ملاحظات</th>
                           </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                           {loadingData ? (
                              <tr><td colSpan={7} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                           ) : filteredNotices.length === 0 ? (
                              <tr><td colSpan={7} className="py-20 text-center text-slate-400 italic font-bold">لا توجد إشعارات مسجلة تطابق البحث</td></tr>
                           ) : filteredNotices.map(n => (
                              <tr key={`notice-${n.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                                 <td className="px-8 py-6 font-bold text-slate-500 font-mono text-xs">{safeFormat(n.date || n.created_at, 'yyyy/MM/dd')}</td>
                                 <td className="px-8 py-6">
                                    <span className={cn(
                                       "px-3 py-1.5 rounded-xl text-xs font-black inline-flex items-center gap-1",
                                       n.type === 'credit' ? "bg-rose-50 dark:bg-rose-950/30 text-rose-600" : "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600"
                                    )}>
                                       {n.type === 'credit' ? 'خصم (Credit)' : 'إضافة (Debit)'}
                                    </span>
                                 </td>
                                 <td className="px-8 py-6">
                                    <div className="flex items-center gap-2">
                                       <span className={cn(
                                          "px-2 py-0.5 rounded-lg text-[10px] font-black",
                                          n.target_type === 'customer' ? "bg-blue-50 dark:bg-blue-950/30 text-blue-600" : n.target_type === 'supplier' ? "bg-amber-50 dark:bg-amber-950/30 text-amber-600" : "bg-purple-50 dark:bg-purple-950/30 text-purple-600"
                                       )}>
                                          {n.target_type === 'customer' ? 'عميل' : n.target_type === 'supplier' ? 'مورد' : 'صيدلية'}
                                       </span>
                                       <span className="font-black text-slate-800 dark:text-white text-sm">
                                          {n.target_name || (n.target_type === 'customer' ? 'عميل' : n.target_type === 'supplier' ? 'مورد' : 'الصيدلية')}
                                       </span>
                                    </div>
                                 </td>
                                 <td className={cn("px-8 py-6 font-black text-lg font-mono", n.type === 'credit' ? "text-rose-600" : "text-emerald-600")}>
                                    {n.amount.toLocaleString()} ج.م
                                 </td>
                                 <td className="px-8 py-6 font-black text-slate-700 dark:text-slate-300">{n.reason}</td>
                                 <td className="px-8 py-6 font-bold text-slate-600 dark:text-slate-400 text-xs">{n.user_name || 'غير معروف'}</td>
                                 <td className="px-8 py-6 font-bold text-slate-500 text-xs">{n.notes || '-'}</td>
                              </tr>
                           ))}
                        </tbody>
                     </table>
                   </div>
                </div>
              );
           })()}

          {activeTab === 'banks' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black text-slate-800 dark:text-white">الحسابات البنكية</h2>
                      <p className="text-slate-500 font-bold">متابعة أرصدة وحركات الحسابات البنكية</p>
                   </div>
                   <div className="flex items-center gap-4">
                     <button onClick={() => window.print()} className="p-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-[24px] hover:bg-slate-200 transition-all no-print">
                       <Printer className="w-6 h-6" />
                     </button>
                     <button
                       onClick={() => setShowAddBankModal(true)}
                       className="px-10 py-5 bg-blue-600 text-white rounded-[24px] font-black hover:bg-blue-700 transition-all shadow-xl shadow-blue-500/20 flex items-center gap-3 active:scale-95"
                     >
                        <Plus className="w-6 h-6" /> إضافة حساب بنكي
                     </button>
                   </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                   {loadingData ? (
                      <div className="col-span-2 py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات البنكية...</div>
                   ) : banks.length === 0 ? (
                      <div className="col-span-2 py-20 text-center text-slate-400 italic font-bold">لا توجد حسابات بنكية مسجلة. اضغط &quot;إضافة حساب بنكي&quot; للبدء.</div>
                   ) : banks.map((bank: any) => (
                      <div key={`bank-${bank.id}`} className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm hover:border-blue-500 transition-all group relative">
                         <div className="flex justify-between items-start mb-6">
                            <div className="w-16 h-16 bg-blue-50 dark:bg-blue-900/20 rounded-[24px] flex items-center justify-center text-blue-600 group-hover:scale-110 transition-transform">
                               <Landmark className="w-8 h-8" />
                            </div>
                            <div className="text-left">
                               <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">الرصيد الحالي</p>
                               <p className="text-3xl font-black text-slate-900 dark:text-white font-mono">{Number(bank.current_balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} <span className="text-sm">ج.م</span></p>
                            </div>
                         </div>
                         <h4 className="text-xl font-black text-slate-800 dark:text-white mb-1">{bank.name_ar}</h4>
                         <p className="text-slate-400 font-bold mb-4 italic text-xs">{bank.name_en || '—'}</p>
                         <div className="pt-6 border-t border-slate-50 dark:border-slate-800 flex justify-between items-center">
                            <span className="text-xs font-black text-slate-500 uppercase tracking-widest font-mono">رقم الحساب: {bank.account_number || '—'} {bank.branch ? `(${bank.branch})` : ''}</span>
                            <div className="flex gap-2">
                               <button 
                                 onClick={() => setEditingBank(bank)}
                                 title="تعديل الحساب"
                                 className="p-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-blue-50 text-slate-600 hover:text-blue-600 rounded-xl transition-all"
                               >
                                  <Edit className="w-4 h-4" />
                               </button>
                               <button 
                                 onClick={() => handleDeleteBank(bank)}
                                 title="حذف الحساب"
                                 className="p-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-rose-50 text-slate-600 hover:text-rose-600 rounded-xl transition-all"
                               >
                                  <Trash2 className="w-4 h-4" />
                               </button>
                            </div>
                         </div>
                      </div>
                   ))}
                </div>
             </div>
          )}

          {activeTab === 'papers' && (() => {
             const filteredPapers = papers.filter(p => {
                if (!paperSearch.trim()) return true;
                const q = paperSearch.toLowerCase();
                return (
                   (p.paper_number || '').toLowerCase().includes(q) ||
                   (p.target_name || '').toLowerCase().includes(q) ||
                   (p.notes || '').toLowerCase().includes(q) ||
                   String(p.amount || '').includes(q)
                );
             });

             return (
              <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                 <div className="flex flex-wrap justify-between items-center gap-4 bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                    <div>
                       <h2 className="text-2xl font-black text-slate-800 dark:text-white">الأوراق المالية (شيكات / كمبيالات)</h2>
                       <p className="text-slate-500 font-bold">متابعة استحقاقات وتحصيل وصرف الشيكات والكمبيالات</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                       <button onClick={() => window.print()} className="p-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-[24px] hover:bg-slate-200 transition-all no-print">
                          <Printer className="w-6 h-6" />
                       </button>
                       <button
                         onClick={() => setShowAddPaperModal({ show: true, type: 'check', direction: 'out' })}
                         className="px-6 py-4 bg-purple-600 text-white rounded-2xl font-black hover:bg-purple-700 transition-all shadow-lg shadow-purple-500/20 flex items-center gap-2 active:scale-95 text-xs"
                       >
                          <Plus className="w-4 h-4" /> تسجيل شيك صادر
                       </button>
                       <button
                         onClick={() => setShowAddPaperModal({ show: true, type: 'check', direction: 'in' })}
                         className="px-6 py-4 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-500/20 flex items-center gap-2 active:scale-95 text-xs"
                       >
                          <Plus className="w-4 h-4" /> تسجيل شيك وارد
                       </button>
                    </div>
                 </div>

                 <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                    <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 bg-slate-50/50 dark:bg-slate-800/30">
                       <div className="relative flex-1 min-w-[280px]">
                          <Search className="w-5 h-5 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
                          <input
                             type="text"
                             value={paperSearch}
                             onChange={e => setPaperSearch(e.target.value)}
                             placeholder="بحث برقم الشيك، اسم الساحب/الجهة، البيان، أو المبلغ..."
                             className="w-full pl-6 pr-12 py-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm focus:border-purple-500 transition-all text-slate-900 dark:text-white"
                          />
                       </div>
                       <div className="text-xs font-black text-slate-400 px-2">
                          إجمالي الأوراق: <span className="text-purple-600 font-mono text-sm">{filteredPapers.length}</span>
                       </div>
                    </div>

                    <table className="w-full text-right">
                       <thead className="bg-slate-50 dark:bg-slate-800/50">
                          <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                             <th className="px-8 py-6">رقم الورقة</th>
                             <th className="px-8 py-6">النوع</th>
                             <th className="px-8 py-6">الجهة / الساحب</th>
                             <th className="px-8 py-6">تاريخ الاستحقاق</th>
                             <th className="px-8 py-6 text-center">المبلغ</th>
                             <th className="px-8 py-6 text-center">الحالة</th>
                          </tr>
                       </thead>
                       <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {loadingData ? (
                             <tr><td colSpan={7} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل الأوراق المالية...</td></tr>
                          ) : filteredPapers.length === 0 ? (
                             <tr><td colSpan={7} className="py-20 text-center text-slate-400 italic font-bold">{paperSearch ? 'لا توجد نتائج مطابقة لبحثك' : 'لا توجد أوراق مالية مسجلة'}</td></tr>
                          ) : filteredPapers.map((p: any) => (
                             <tr key={`paper-${p.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors group">
                                <td className="px-8 py-6 font-mono font-black text-slate-800 dark:text-white">{p.paper_number}</td>
                                <td className="px-8 py-6 font-bold">
                                   <span className={cn("px-4 py-1.5 rounded-full text-xs font-black", p.direction === 'in' ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400" : "bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-400")}>
                                      {p.type === 'check' ? 'شيك' : 'كمبيالة'} {p.direction === 'in' ? 'وارد' : 'صادر'}
                                   </span>
                                </td>
                                <td className="px-8 py-6 font-black text-sm">{p.target_name}</td>
                                <td className="px-8 py-6 font-bold text-rose-500 font-mono text-xs">{safeFormat(p.due_date, 'yyyy/MM/dd')}</td>
                                <td className="px-8 py-6 text-center font-black text-lg font-mono text-slate-900 dark:text-white">{Number(p.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} ج.م</td>
                                <td className="px-8 py-6 text-center">
                                   <span className={cn(
                                     "px-3.5 py-1 rounded-full text-[11px] font-black",
                                     p.status === 'cashed' ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" :
                                     p.status === 'bounced' ? "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400" :
                                     p.status === 'cancelled' ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" :
                                     "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                                   )}>
                                      {p.status === 'cashed' ? 'تم الصرف / التحصيل' :
                                       p.status === 'bounced' ? 'مرتد (مرفوض)' :
                                       p.status === 'cancelled' ? 'ملغي' : 'قيد الانتظار'}
                                   </span>
                                </td>
                                <td className="px-8 py-6 text-center">
                                   <div className="flex items-center justify-center gap-1.5">
                                      {p.status === 'pending' && (
                                         <>
                                            <button
                                              onClick={() => handleUpdatePaperStatus(p, 'cashed')}
                                              title={p.direction === 'in' ? 'تحصيل وإيداع بالخزينة' : 'صرف وخصم من الخزينة'}
                                              className="px-2.5 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-xl text-xs font-black transition-all"
                                            >
                                               {p.direction === 'in' ? 'تحصيل' : 'صرف'}
                                            </button>
                                            <button
                                              onClick={() => handleUpdatePaperStatus(p, 'bounced')}
                                              title="تسجيل ارتداد الشيك"
                                              className="px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-xl text-xs font-black transition-all"
                                            >
                                               ارتداد
                                            </button>
                                         </>
                                      )}
                                      <button
                                        onClick={() => handleDeletePaper(p)}
                                        title="حذف الورقة المالية"
                                        className="p-2 text-slate-400 hover:text-rose-600 rounded-lg transition-all"
                                      >
                                         <Trash2 className="w-4 h-4" />
                                      </button>
                                   </div>
                                </td>
                             </tr>
                          ))}
                       </tbody>
                    </table>
                 </div>
              </div>
             );
          })()}

          {activeTab === 'cards' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black text-slate-800 dark:text-white">ماكينات وبطاقات الائتمان</h2>
                      <p className="text-slate-500 font-bold">إدارة عُهد ونقاط التحصيل الإلكتروني والماكينات</p>
                   </div>
                   <div className="flex items-center gap-4">
                     <button onClick={() => window.print()} className="p-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-[24px] hover:bg-slate-200 transition-all no-print">
                       <Printer className="w-6 h-6" />
                     </button>
                     <button
                       onClick={() => setShowAddCardModal(true)}
                       className="px-10 py-5 bg-indigo-600 text-white rounded-[24px] font-black hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-500/20 flex items-center gap-3 active:scale-95"
                     >
                        <Plus className="w-6 h-6" /> إضافة ماكينة / كارت
                     </button>
                   </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                   {loadingData ? (
                      <div className="col-span-3 py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</div>
                   ) : cards.length === 0 ? (
                      <div className="col-span-3 py-20 text-center text-slate-400 italic font-bold">لا توجد ماكينات مسجلة. اضغط &quot;إضافة ماكينة / كارت&quot; للبدء.</div>
                   ) : cards.map((c: any) => (
                      <div key={`card-${c.id}`} className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden group">
                         <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-500/5 rounded-full group-hover:scale-150 transition-transform" />
                         <div className="flex justify-between items-start mb-6">
                            <CreditCard className="w-10 h-10 text-indigo-600" />
                            <div className="flex gap-1">
                               <button 
                                 onClick={() => setEditingCard(c)}
                                 title="تعديل الماكينة"
                                 className="p-2 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 rounded-xl transition-all"
                               >
                                  <Edit className="w-4 h-4" />
                               </button>
                               <button 
                                 onClick={() => handleDeleteCard(c)}
                                 title="حذف الماكينة"
                                 className="p-2 bg-slate-100 dark:bg-slate-800 hover:bg-rose-50 text-slate-600 hover:text-rose-600 rounded-xl transition-all"
                               >
                                  <Trash2 className="w-4 h-4" />
                               </button>
                            </div>
                         </div>
                         <h4 className="text-lg font-black mb-1 text-slate-900 dark:text-white">{c.name_ar}</h4>
                         <p className="text-xs font-bold text-slate-400 uppercase mb-6">{c.name_en || '—'}</p>
                         <div className="flex justify-between items-end pt-4 border-t border-slate-100 dark:border-slate-800">
                            <div>
                               <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">الرصيد الحالي</p>
                               <p className="text-2xl font-black text-indigo-600 font-mono">{Number(c.current_balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} ج.م</p>
                            </div>
                            <div className="text-left">
                               <p className="text-[10px] font-black text-rose-500 uppercase tracking-widest">العمولة</p>
                               <p className="font-black text-rose-500 font-mono">{c.commission_pct}%</p>
                            </div>
                         </div>
                      </div>
                   ))}
                </div>
             </div>
           )}

          {activeTab === 'expenses' && (() => {
             const filteredExpenses = expensesList.filter(exp => {
                if (!expenseSearch.trim()) return true;
                const q = expenseSearch.toLowerCase();
                const catName = (getCategoryDisplayName(exp.category) || '').toLowerCase();
                const rawCat = (exp.category || '').toLowerCase();
                const user = (exp.user_name || '').toLowerCase();
                const notes = (exp.notes || exp.description || '').toLowerCase();
                const amt = String(exp.amount || '');
                const d = (exp.date || '').toLowerCase();
                return catName.includes(q) || rawCat.includes(q) || user.includes(q) || notes.includes(q) || amt.includes(q) || d.includes(q);
             });

             return (
              <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                 <div className="flex flex-wrap justify-between items-center gap-4 bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                    <div>
                       <h2 className="text-2xl font-black text-slate-800 dark:text-white">المصاريف التشغيلية</h2>
                       <p className="text-slate-500 font-bold">سجل المصروفات الفعلي وتحليل التكاليف</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                       <Link
                          href="/expenses"
                          className="px-6 py-4 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-[20px] font-black text-sm flex items-center gap-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
                       >
                          <FileText className="w-5 h-5 text-rose-600" />
                          <span>شاشة المصروفات الكاملة</span>
                       </Link>
                       {canManageExpenses && <button
                         onClick={() => setShowRecordExpenseModal(true)}
                         className="px-8 py-4 bg-rose-600 hover:bg-rose-700 text-white rounded-[20px] font-black text-sm shadow-xl shadow-rose-500/20 flex items-center gap-2 active:scale-95 transition-all"
                       >
                          <Plus className="w-5 h-5" /> إضافة مصروف (F4)
                       </button>}
                    </div>
                 </div>

                 <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="p-8 bg-rose-50 dark:bg-rose-900/10 rounded-[40px] border border-rose-100 dark:border-rose-900/20">
                       <p className="text-xs font-black text-rose-600 uppercase tracking-widest mb-2">إجمالي الشهر</p>
                       <p className="text-4xl font-black text-rose-700 font-mono">{totalMonthExpenses.toLocaleString()} <span className="text-sm">ج.م</span></p>
                    </div>
                    <div className="p-8 bg-blue-50 dark:bg-blue-900/10 rounded-[40px] border border-blue-100 dark:border-blue-900/20">
                       <p className="text-xs font-black text-blue-600 uppercase tracking-widest mb-2">أكبر تصنيف</p>
                       <p className="text-2xl font-black text-blue-700">{largestCategoryLabel}</p>
                    </div>
                    <div className="p-8 bg-amber-50 dark:bg-amber-900/10 rounded-[40px] border border-amber-100 dark:border-amber-900/20">
                       <p className="text-xs font-black text-amber-600 uppercase tracking-widest mb-2">عدد العمليات</p>
                       <p className="text-4xl font-black text-amber-700 font-mono">{expensesList.length} <span className="text-sm">عملية</span></p>
                    </div>
                 </div>

                 <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                    <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 bg-slate-50/50 dark:bg-slate-800/30">
                       <div className="relative flex-1 min-w-[280px]">
                          <Search className="w-5 h-5 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
                          <input
                             type="text"
                             value={expenseSearch}
                             onChange={e => setExpenseSearch(e.target.value)}
                             placeholder="بحث بالتصنيف، المبلغ، التاريخ، المسؤول، أو الملاحظات..."
                             className="w-full pl-6 pr-12 py-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm focus:border-rose-500 transition-all text-slate-900 dark:text-white"
                          />
                       </div>
                       <div className="flex items-center gap-3">
                          <button onClick={() => window.print()} className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-2xl hover:bg-slate-200 transition-all no-print">
                             <Printer className="w-5 h-5" />
                          </button>
                          <div className="text-xs font-black text-slate-400 px-2">
                             العدد: <span className="text-rose-600 font-mono text-sm">{filteredExpenses.length}</span> مصروف
                          </div>
                       </div>
                    </div>

                    <table className="w-full text-right">
                       <thead className="bg-slate-50 dark:bg-slate-800/50">
                          <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                             <th className="px-8 py-6">التاريخ</th>
                             <th className="px-8 py-6">التصنيف</th>
                             <th className="px-8 py-6">القيمة</th>
                             <th className="px-8 py-6">بواسطة</th>
                             <th className="px-8 py-6">ملاحظات</th>
                             <th className="px-8 py-6 text-center">إجراءات</th>
                          </tr>
                       </thead>
                       <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {loadingData ? (
                             <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل المصروفات...</td></tr>
                          ) : filteredExpenses.length === 0 ? (
                             <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">{expenseSearch.trim() ? 'لا توجد نتائج مطابقة لبحثك' : 'لا توجد مصروفات مسجلة'}</td></tr>
                          ) : filteredExpenses.map(exp => (
                             <tr key={`exp-list-${exp.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                                <td className="px-8 py-6 font-bold text-slate-500 font-mono text-xs">{safeFormat(exp.date || exp.created_at, 'yyyy/MM/dd')}</td>
                                <td className="px-8 py-6 font-black text-slate-800 dark:text-white">
                                   <span className="bg-rose-50 dark:bg-rose-950/30 text-rose-600 px-4 py-1.5 rounded-full text-xs font-black">
                                      {getCategoryDisplayName(exp.category)}
                                   </span>
                                </td>
                                <td className="px-8 py-6 font-black text-lg text-rose-600 font-mono">{exp.amount.toLocaleString()} ج.م</td>
                                <td className="px-8 py-6 font-bold text-slate-700 dark:text-slate-300 text-xs">{exp.user_name || 'غير معروف'}</td>
                                <td className="px-8 py-6 font-bold text-slate-500 text-xs">{exp.description || exp.notes || '-'}</td>
                             </tr>
                          ))}
                       </tbody>
                    </table>
                 </div>
              </div>
             );
          })()}

           {activeTab === 'daily_reports' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in slide-in-from-left-4">
                 <Link href="/shifts" className="p-8 bg-white dark:bg-slate-900 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm hover:border-blue-300 transition-all">
                    <BarChart3 className="w-10 h-10 text-blue-600 mb-5" />
                    <h3 className="text-xl font-black text-slate-800 dark:text-white">إدارة وتقارير الورديات</h3>
                    <p className="text-sm font-bold text-slate-500 mt-2">مراجعة الوردية المشتركة وحركات كل مستخدم داخلها.</p>
                 </Link>
                 <Link href="/finance/handover" className="p-8 bg-white dark:bg-slate-900 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm hover:border-emerald-300 transition-all">
                    <ArrowRightLeft className="w-10 h-10 text-emerald-600 mb-5" />
                    <h3 className="text-xl font-black text-slate-800 dark:text-white">تسليم الوردية المشتركة</h3>
                    <p className="text-sm font-bold text-slate-500 mt-2">مطابقة حركات المستخدم وتحويل النقدية مع بقاء الجلسة مفتوحة.</p>
                 </Link>
              </div>
           )}

           {activeTab === 'trial_balance' && (
              <div className="animate-in fade-in slide-in-from-left-4">
                 <TrialBalanceReport userRole={userRole} />
              </div>
           )}

           {activeTab === 'trial_balance_settings' && (
              <div className="animate-in fade-in slide-in-from-left-4">
                 <TrialBalanceSettingsClient />
              </div>
           )}

          {activeTab === 'audit_logs' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black text-slate-800 dark:text-white">سجل الرقابة والأحداث</h2>
                      <p className="text-slate-500 font-bold">تتبع جميع العمليات الحساسة التي تمت على النظام</p>
                   </div>
                   <div className="flex gap-4">
                      <div className="relative w-80 max-w-full">
                        <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                        <input value={auditSearch} onChange={e => setAuditSearch(e.target.value)} placeholder="بحث في سجل الرقابة..." className="w-full py-4 pr-12 pl-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 outline-none font-bold text-sm" />
                      </div>
                   </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                            <th className="px-8 py-6">الوقت والتاريخ</th>
                            <th className="px-8 py-6">نوع العملية</th>
                            <th className="px-8 py-6">التفاصيل</th>
                            <th className="px-8 py-6">المستخدم</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل سجل الرقابة...</td></tr>
                         ) : filteredActivityLogs.length === 0 ? (
                            <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic font-bold">السجل فارغ حالياً</td></tr>
                         ) : filteredActivityLogs.map(log => (
                            <tr key={`log-${log.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                               <td className="px-8 py-6 font-bold text-slate-500">{safeFormat(log.created_at, 'yyyy/MM/dd HH:mm:ss')}</td>
                               <td className="px-8 py-6 font-mono">
                                  <span className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-3 py-1 rounded-lg text-xs font-black">
                                     {log.action}
                                  </span>
                               </td>
                               <td className="px-8 py-6 font-black text-slate-800 dark:text-white">{log.details}</td>
                               <td className="px-8 py-6 font-bold text-blue-600">{log.user_name || 'غير معروف'}</td>
                            </tr>
                         ))}
                      </tbody>
                   </table>
                </div>
             </div>
          )}

          {activeTab === 'chart_of_accounts' && (
              <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                 <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                    <div>
                       <h2 className="text-2xl font-black text-slate-800 dark:text-white">شجرة الحسابات (Chart of Accounts)</h2>
                       <p className="text-slate-500 font-bold">هيكل الحسابات المالي للصيدلية</p>
                    </div>
                    <div className="flex gap-4">
                       <div className="bg-slate-100 dark:bg-slate-800 p-2 rounded-2xl flex gap-2">
                          <button 
                            onClick={() => setCoaViewMode('table')}
                            className={cn("px-6 py-2 rounded-xl text-xs font-black transition-all", coaViewMode === 'table' ? "bg-white dark:bg-slate-700 shadow-sm text-slate-900 dark:text-white" : "text-slate-400")}
                          >
                             جدول
                          </button>
                          <button 
                            onClick={() => setCoaViewMode('tree')}
                            className={cn("px-6 py-2 rounded-xl text-xs font-black transition-all", coaViewMode === 'tree' ? "bg-white dark:bg-slate-700 shadow-sm text-slate-900 dark:text-white" : "text-slate-400")}
                          >
                             شجرة مرئية
                          </button>
                       </div>
                       <button 
                         onClick={() => setShowAddAccount({ show: true, parentId: null })}
                         className="px-10 py-5 bg-slate-800 text-white rounded-[24px] font-black hover:bg-slate-900 transition-all shadow-xl flex items-center gap-3"
                       >
                          <Plus className="w-6 h-6" /> إضافة حساب رئيسي
                       </button>
                    </div>
                 </div>

                 {coaViewMode === 'table' ? (
                    <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                       <table className="w-full text-right">
                          <thead className="bg-slate-50 dark:bg-slate-800/50">
                             <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                                <th className="px-8 py-6">كود الحساب</th>
                                <th className="px-8 py-6">إسم الحساب</th>
                                <th className="px-8 py-6">النوع</th>
                                <th className="px-8 py-6">الرصيد</th>
                                <th className="px-8 py-6">إجراءات</th>
                             </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                             {loadingData ? (
                                <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                             ) : accounts.length === 0 ? (
                                <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">لا توجد حسابات مسجلة</td></tr>
                             ) : accounts.map(acc => (
                                <tr key={`acc-${acc.id}`} className={cn(
                                  "hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors",
                                  acc.is_group ? "bg-slate-50/50 dark:bg-slate-800/20" : ""
                                )}>
                                   <td className="px-8 py-6 font-mono font-black text-blue-600">{acc.code}</td>
                                   <td className="px-8 py-6 font-black" style={{ paddingRight: `${(acc.code.split('.').length - 1) * 20 + 32}px` }}>
                                      {acc.is_group ? '📁 ' : '📄 '}{acc.name_ar}
                                   </td>
                                   <td className="px-8 py-6">
                                      <span className={cn(
                                         "px-3 py-1 rounded-lg text-[10px] font-black uppercase",
                                         acc.type === 'asset' ? "bg-emerald-100 text-emerald-600" :
                                         acc.type === 'liability' ? "bg-rose-100 text-rose-600" :
                                         acc.type === 'equity' ? "bg-blue-100 text-blue-600" :
                                         acc.type === 'income' ? "bg-indigo-100 text-indigo-600" : "bg-amber-100 text-amber-600"
                                      )}>
                                         {acc.type === 'asset' ? 'أصول' : 
                                          acc.type === 'liability' ? 'خصوم' : 
                                          acc.type === 'equity' ? 'حقوق ملكية' : 
                                          acc.type === 'income' ? 'إيرادات' : 'مصروفات'}
                                      </span>
                                   </td>
                                   <td className="px-8 py-6 font-black">{acc.balance?.toLocaleString('en-US')} ج.م</td>
                                   <td className="px-8 py-6">
                                      <div className="flex gap-2">
                                         <button 
                                           onClick={() => setShowAddAccount({ show: true, parentId: acc.id })}
                                           className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-blue-600 transition-all"
                                           title="إضافة حساب فرعي"
                                         >
                                            <Plus className="w-4 h-4" />
                                         </button>
                                         <button
                                            onClick={() => setEditingAccount(acc)}
                                            title="تعديل الحساب"
                                            className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-all"
                                          >
                                             <Edit className="w-4 h-4" />
                                          </button>
                                          <button
                                            onClick={() => handleDeleteAccount(acc)}
                                            title="حذف الحساب"
                                            className="p-3 bg-rose-50 dark:bg-rose-950/30 text-rose-500 hover:bg-rose-600 hover:text-white rounded-xl transition-all"
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </button>
                                      </div>
                                   </td>
                                </tr>
                             ))}
                          </tbody>
                       </table>
                    </div>
                 ) : (
                    <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 p-8 min-h-[600px] shadow-sm overflow-hidden">
                       <div className="max-w-4xl mx-auto">
                          {buildAccountTree(accounts).map((root: any) => (
                             <AccountTreeNode 
                                key={`root-${root.id}`} 
                                node={root} 
                                onAddSub={(id) => setShowAddAccount({ show: true, parentId: id })} 
                                onEdit={(node) => setEditingAccount(node)}
                                onDelete={(node) => handleDeleteAccount(node)}
                                level={0}
                              />
                          ))}
                       </div>
                    </div>
                 )}
              </div>
           )}
           {activeTab === 'daily_journals' && (
              <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                 <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                    <div>
                       <h2 className="text-2xl font-black text-slate-800 dark:text-white">القيود اليومية (Daily Journals)</h2>
                       <p className="text-slate-500 font-bold">تسجيل الحركات المالية المزدوجة</p>
                    </div>
                    <button
                       onClick={() => setShowAddJournalModal(true)}
                       className="px-10 py-5 bg-blue-600 text-white rounded-[24px] font-black hover:bg-blue-700 flex items-center gap-3 shadow-xl shadow-blue-500/20"
                    >
                       <Plus className="w-6 h-6" /> قيد يومي جديد
                    </button>
                 </div>

                 <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                    <table className="w-full text-right">
                       <thead className="bg-slate-50 dark:bg-slate-800/50">
                          <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                             <th className="px-8 py-6">رقم القيد</th>
                             <th className="px-8 py-6">التاريخ</th>
                             <th className="px-8 py-6">البيان</th>
                             <th className="px-8 py-6">المبلغ الإجمالي</th>
                             <th className="px-8 py-6">إجراءات</th>
                          </tr>
                       </thead>
                       <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {loadingData ? (
                             <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                          ) : journals.length === 0 ? (
                             <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">لا توجد قيود مسجلة اليوم</td></tr>
                          ) : journals.map(j => (
                             <tr 
                                key={`journal-${j.id}`} 
                                onClick={() => setSelectedJournalId(j.id)}
                                className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer group"
                             >
                                <td className="px-8 py-6 font-mono font-black text-slate-800 dark:text-white group-hover:text-blue-600">#{j.id.slice(0, 8)}</td>
                                <td className="px-8 py-6 font-bold text-slate-500">{safeFormat(j.date, 'yyyy/MM/dd')}</td>
                                <td className="px-8 py-6 font-black">{j.description}</td>
                                <td className="px-8 py-6 font-black text-lg text-blue-600">{j.total_amount.toLocaleString()} ج.م</td>
                                <td className="px-8 py-6">
                                   <button onClick={(e) => { e.stopPropagation(); setSelectedJournalId(j.id); }} title="عرض تفاصيل القيد" className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-blue-600 transition-all"><ArrowRight className="w-4 h-4" /></button>
                                </td>
                             </tr>
                          ))}
                       </tbody>
                    </table>
                 </div>
              </div>
           )}

           {!ACCOUNT_TABS.flatMap(g => g.items).map(t => t.id).includes(activeTab) && (
              <div className="h-[60vh] flex flex-col items-center justify-center bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 border-dashed animate-in zoom-in duration-500">
                 <PieChart className="w-24 h-24 text-slate-200 mb-6" />
                 <h3 className="text-2xl font-black text-slate-300">قريباً: {ACCOUNT_TABS.flatMap(g => g.items).find(t => t.id === activeTab)?.label}</h3>
                 <p className="text-slate-400 font-bold">جاري العمل على تجهيز هذه الواحدة لتناسب النظام الجديد</p>
              </div>
           )}
       </div>

       <AddAccountModal 
          show={showAddAccount.show}
          parentId={showAddAccount.parentId}
          onClose={() => setShowAddAccount({ show: false, parentId: null })}
          onSuccess={loadTabData}
          accounts={accounts}
       />

       <EditAccountModal 
          show={!!editingAccount}
          account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSuccess={loadTabData}
       />

       <ExpenseDefinitionModal 
          show={showAddExpenseModal || !!editingExpenseDef}
          initialData={editingExpenseDef}
          onClose={() => {
             setShowAddExpenseModal(false);
             setEditingExpenseDef(null);
          }}
          onSuccess={loadTabData}
       />

       <RecordExpenseModal 
          show={showRecordExpenseModal}
          categories={expenseDefinitions}
          onClose={() => setShowRecordExpenseModal(false)}
          onSuccess={loadTabData}
       />

       <JournalDetailsModal 
          journalId={selectedJournalId}
          onClose={() => setSelectedJournalId(null)}
       />
       <ManualJournalModal
          show={showAddJournalModal}
          accounts={accounts}
          onClose={() => setShowAddJournalModal(false)}
          onSuccess={loadTabData}
       />
    </div>
  );
}


function StatCard({ label, value, color, icon: Icon, onClick, active }: any) {
  const colorMap = {
    emerald: 'text-emerald-600 bg-emerald-50 border-emerald-100 dark:bg-emerald-900/10 dark:border-emerald-900/20',
    blue: 'text-blue-600 bg-blue-50 border-blue-100 dark:bg-blue-900/10 dark:border-blue-900/20',
    rose: 'text-rose-600 bg-rose-50 border-rose-100 dark:bg-rose-900/10 dark:border-rose-900/20'
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      aria-label={`عرض تفاصيل ${label}`}
      className={cn(
        "w-full p-8 rounded-[40px] border transition-all hover:scale-105 hover:shadow-xl text-right",
        (colorMap as any)[color],
        onClick && "cursor-pointer select-none active:scale-95",
        active && "ring-2 ring-offset-2 ring-current shadow-md scale-[1.02]"
      )}
    >
       <div className="flex justify-between items-center mb-6">
          <div className="w-14 h-14 bg-white dark:bg-slate-900 rounded-2xl flex items-center justify-center shadow-sm">
             <Icon className="w-8 h-8" />
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest opacity-60">تقرير مباشر</span>
       </div>
       <p className="text-sm font-black opacity-70 mb-2">{label}</p>
       <p className="text-4xl font-black">{value} <span className="text-sm">ج.م</span></p>
       <p className="text-[10px] font-bold opacity-60 mt-3">اضغط لعرض التفاصيل</p>
    </button>
  );
}

function TreasuryMetricDetails({
  metric,
  total,
  details,
  detailCount,
  loading,
  onClose,
}: {
  metric: TreasuryMetricKey;
  total: number;
  details: any[];
  detailCount: number;
  loading: boolean;
  onClose: () => void;
}) {
  const labels: Record<TreasuryMetricKey, string> = {
    treasury: 'تفاصيل رصيد الخزينة',
    receipts: 'تفاصيل توريدات اليوم',
    expenses: 'تفاصيل المصروفات اليومية',
    handovers: 'تفاصيل تسليمات الورديات',
  };

  return (
    <section className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-lg" aria-live="polite">
      <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-xl font-black text-slate-800 dark:text-white">{labels[metric]}</h3>
          <p className="text-sm font-black text-blue-600 mt-1">
            {Number(total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
            <span className="text-xs text-slate-400 mr-2">({detailCount} حركة)</span>
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="إغلاق التفاصيل" className="p-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-rose-600 transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full text-right">
          <thead className="bg-slate-50 dark:bg-slate-800/50 sticky top-0">
            <tr>
              <th className="px-6 py-4 text-xs font-black text-slate-400">التاريخ</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400">البيان</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400">المستخدم</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400">المبلغ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading ? (
              <tr><td colSpan={4} className="py-16 text-center text-slate-400 font-bold">جاري تحميل التفاصيل...</td></tr>
            ) : details.length === 0 ? (
              <tr><td colSpan={4} className="py-16 text-center text-slate-400 font-bold">لا توجد حركات ضمن هذا الرقم</td></tr>
            ) : details.map(detail => (
              <tr key={`${metric}-${detail.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                <td className="px-6 py-4 text-xs font-bold text-slate-500" dir="ltr">{safeFormat(detail.created_at || detail.date, 'yyyy/MM/dd HH:mm')}</td>
                <td className="px-6 py-4">
                  <p className="font-black text-sm text-slate-800 dark:text-white">{detail.description || '—'}</p>
                  {detail.shift_id && <Link href="/shifts" className="text-[10px] font-mono text-blue-500">وردية #{String(detail.shift_id).slice(0, 8)}</Link>}
                </td>
                <td className="px-6 py-4 text-xs font-bold text-slate-500">{detail.user_name || '—'}</td>
                <td className={cn('px-6 py-4 font-black', detail.type === 'receipt' ? 'text-emerald-600' : 'text-rose-600')}>
                  {detail.type === 'receipt' ? '+' : '-'}{Number(detail.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detailCount > details.length && (
        <p className="px-6 py-3 text-[11px] font-bold text-slate-400 border-t border-slate-100 dark:border-slate-800">يتم عرض أحدث {details.length} حركة من أصل {detailCount} للحفاظ على سرعة الشاشة.</p>
      )}
    </section>
  );
}

function buildAccountTree(accounts: any[]) {
   const map = new Map();
   const codeMap = new Map();
   accounts.forEach(acc => {
      const node = { ...acc, children: [] };
      map.set(acc.id, node);
      codeMap.set(acc.code, node);
   });
   const roots: any[] = [];
   [...accounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).forEach(acc => {
      let parentNode = acc.parent_id ? map.get(acc.parent_id) : null;
      if (!parentNode) {
         if (acc.code.includes('.')) {
            const parts = acc.code.split('.');
            const parentCode = parts.slice(0, -1).join('.');
            parentNode = codeMap.get(parentCode);
         } else if (acc.code.length > 1) {
            parentNode = codeMap.get(acc.code.slice(0, -1)) || codeMap.get(acc.code.charAt(0));
         }
      }
      if (parentNode && parentNode.id !== acc.id) {
         parentNode.children.push(map.get(acc.id));
      } else {
         roots.push(map.get(acc.id));
      }
   });
   return roots;
}

function AccountTreeNode({ node, onAddSub, onEdit, onDelete, level = 0 }: { node: any, onAddSub: (id: number) => void, onEdit: (node: any) => void, onDelete: (node: any) => void, level?: number }) {
   const [isExpanded, setIsExpanded] = useState(level < 1); // Expand root levels by default

   const typeConfigs: Record<string, { color: string, bg: string, label: string }> = {
      asset: { color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/30', label: 'أصول' },
      liability: { color: 'text-rose-600', bg: 'bg-rose-100 dark:bg-rose-900/30', label: 'خصوم' },
      equity: { color: 'text-blue-600', bg: 'bg-blue-100 dark:bg-blue-900/30', label: 'حقوق ملكية' },
      income: { color: 'text-indigo-600', bg: 'bg-indigo-100 dark:bg-indigo-900/30', label: 'إيرادات' },
      expense: { color: 'text-amber-600', bg: 'bg-amber-100 dark:bg-amber-900/30', label: 'مصروفات' },
   };

   const config = typeConfigs[node.type] || { color: 'text-slate-600', bg: 'bg-slate-100', label: 'غير معروف' };

   return (
      <div className="select-none" dir="rtl">
         <div 
           className={cn(
             "group flex items-center justify-between py-3 px-4 rounded-2xl transition-all duration-200 cursor-pointer",
             level === 0 ? "bg-slate-50 dark:bg-slate-800/50 mb-1" : "hover:bg-slate-50 dark:hover:bg-slate-800/30",
             isExpanded && level === 0 && "mb-2"
           )}
           style={{ marginRight: `${level * 32}px` }}
           onClick={() => node.is_group && setIsExpanded(!isExpanded)}
         >
            <div className="flex items-center gap-4 flex-1 min-w-0">
               {/* Indentation & Toggle */}
               <div className="flex items-center gap-2 w-8 shrink-0">
                  {node.is_group ? (
                    <div className={cn(
                      "w-6 h-6 rounded-lg flex items-center justify-center transition-all",
                      isExpanded ? "bg-slate-200 dark:bg-slate-700 text-slate-600" : "bg-blue-50 dark:bg-blue-900/20 text-blue-600"
                    )}>
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                    </div>
                  ) : (
                    <div className="w-6 h-6 flex items-center justify-center opacity-20">
                       <div className="w-1 h-1 rounded-full bg-slate-400" />
                    </div>
                  )}
               </div>

               {/* Icon & Details */}
               <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", config.bg, config.color)}>
                  {node.is_group ? <FolderOpen className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
               </div>

               <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                     <span className="text-[10px] font-mono font-black text-slate-400 opacity-60 tracking-tighter">{node.code}</span>
                     <h4 className={cn(
                        "font-black truncate",
                        level === 0 ? "text-lg text-slate-900 dark:text-white" : "text-slate-700 dark:text-slate-300",
                        !node.is_group && "font-bold"
                     )}>
                        {node.name_ar}
                     </h4>
                  </div>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate">{node.name_en}</p>
               </div>

               {/* Balance Display */}
               <div className="px-6 text-left shrink-0">
                  <p className={cn(
                     "text-lg font-black",
                     node.balance > 0 ? "text-emerald-600" : "text-slate-400"
                  )}>
                     {node.balance?.toLocaleString('en-US') || 0}
                     <span className="text-[10px] mr-1">ج.م</span>
                  </p>
               </div>
            </div>

            {/* Hover Actions */}
            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-all duration-200 pr-4">
               {node.is_group ? (
                  <button 
                    onClick={(e) => {
                       e.stopPropagation();
                       onAddSub(node.id);
                    }}
                    className="p-2.5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 rounded-xl hover:bg-blue-600 hover:text-white transition-all shadow-sm"
                    title="إضافة حساب فرعي"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
               ) : null}
               <button 
                 onClick={(e) => { e.stopPropagation(); onEdit(node); }}
                 className="p-2.5 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:bg-slate-900 dark:hover:bg-white dark:hover:text-slate-900 transition-all shadow-sm"
                 title="تعديل الحساب"
               >
                 <Edit className="w-4 h-4" />
               </button>
               <button 
                 onClick={(e) => { e.stopPropagation(); onDelete(node); }}
                 className="p-2.5 bg-rose-50 dark:bg-rose-950/30 text-rose-600 rounded-xl hover:bg-rose-600 hover:text-white transition-all shadow-sm"
                 title="حذف الحساب"
               >
                 <Trash2 className="w-4 h-4" />
               </button>
            </div>
         </div>

         {/* Recursive Children */}
         {isExpanded && node.children.length > 0 && (
            <div className="relative border-r-2 border-slate-100 dark:border-slate-800/50 mr-3 pr-2 py-1">
               {node.children.map((child: any) => (
                  <AccountTreeNode 
                    key={`child-${child.id}`} 
                    node={child} 
                    onAddSub={onAddSub} 
                    onEdit={onEdit}
                    onDelete={onDelete}
                    level={level + 1} 
                  />
               ))}
            </div>
         )}
      </div>
   );
}

function EditAccountModal({ show, account, onClose, onSuccess }: any) {
   const [loading, setLoading] = useState(false);
   const [formData, setFormData] = useState({
      name_ar: '',
      name_en: '',
      code: '',
      type: 'expense',
      is_group: 0
   });

   useEffect(() => {
      if (account) {
         setFormData({
            name_ar: account.name_ar || '',
            name_en: account.name_en || '',
            code: account.code || '',
            type: account.type || 'expense',
            is_group: account.is_group ? 1 : 0
         });
      }
   }, [account]);

   useHotkeys('enter', (e) => { e.preventDefault(); handleSubmit(); }, { enableOnFormTags: ['input', 'select'] });
   useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

   if (!show || !account) return null;

   const handleSubmit = async () => {
      if (!formData.name_ar || !formData.code) return toast.error('يرجى إكمال البيانات الأساسية');
      setLoading(true);
      const res = await updateAccountAction(account.id, formData as any);
      if (res.success) {
         toast.success('تم تحديث الحساب بنجاح');
         onSuccess();
         onClose();
      } else {
         toast.error(res.error || 'فشل تحديث الحساب');
      }
      setLoading(false);
   };

   return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300" dir="rtl">
         <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col max-h-[90vh]">
            <div className="p-10 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
               <div>
                  <h3 className="text-2xl font-black text-slate-800 dark:text-white">تعديل بيانات الحساب</h3>
                  <p className="text-slate-500 font-bold">الحساب: <span className="text-blue-600 font-mono">#{account.code} - {account.name_ar}</span></p>
               </div>
               <button onClick={onClose} className="p-4 bg-white dark:bg-slate-800 text-slate-400 rounded-2xl hover:text-rose-500 transition-all shadow-sm"><X className="w-6 h-6" /></button>
            </div>
            
            <div className="p-10 space-y-8 overflow-y-auto custom-scrollbar">
               <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-3">
                     <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">كود الحساب</label>
                     <input 
                        type="text" 
                        value={formData.code}
                        onChange={e => setFormData({...formData, code: e.target.value})}
                        className="w-full px-8 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none font-black text-blue-600 focus:ring-4 ring-blue-500/10 transition-all border border-transparent focus:border-blue-500/20 font-mono"
                     />
                  </div>
                  <div className="space-y-3">
                     <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">نوع الحساب</label>
                     <select 
                        value={formData.type}
                        onChange={e => setFormData({...formData, type: e.target.value as any})}
                        className="w-full px-8 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none font-black focus:ring-4 ring-blue-500/10 transition-all border border-transparent focus:border-blue-500/20"
                     >
                        <option value="asset">أصول (Assets)</option>
                        <option value="liability">خصوم (Liabilities)</option>
                        <option value="equity">حقوق ملكية (Equity)</option>
                        <option value="income">إيرادات (Income)</option>
                        <option value="expense">مصروفات (Expenses)</option>
                     </select>
                  </div>
               </div>

               <div className="space-y-3">
                  <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">إسم الحساب (بالعربي)</label>
                  <input 
                     type="text" 
                     value={formData.name_ar}
                     onChange={e => setFormData({...formData, name_ar: e.target.value})}
                     className="w-full px-8 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none font-black focus:ring-4 ring-blue-500/10 transition-all border border-transparent focus:border-blue-500/20"
                  />
               </div>

               <div className="space-y-3">
                  <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">إسم الحساب (English)</label>
                  <input 
                     type="text" 
                     value={formData.name_en}
                     onChange={e => setFormData({...formData, name_en: e.target.value})}
                     className="w-full px-8 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none font-black focus:ring-4 ring-blue-500/10 transition-all border border-transparent focus:border-blue-500/20"
                  />
               </div>

               <div className="flex items-center gap-4 p-6 bg-blue-50 dark:bg-blue-900/10 rounded-3xl border border-blue-100 dark:border-blue-800">
                  <input 
                     type="checkbox" 
                     checked={formData.is_group === 1}
                     onChange={e => setFormData({...formData, is_group: e.target.checked ? 1 : 0})}
                     className="w-6 h-6 rounded-lg text-blue-600 focus:ring-blue-500 transition-all cursor-pointer"
                  />
                  <div>
                     <p className="font-black text-blue-700">هذا الحساب هو &quot;حساب رئيسي&quot; (Group)</p>
                     <p className="text-[10px] font-bold text-blue-600 opacity-70 italic">الحسابات الرئيسية لا تقبل قيود مباشرة، بل تحتوي على حسابات فرعية</p>
                  </div>
               </div>
            </div>

            <div className="p-10 bg-slate-50 dark:bg-slate-800/50 flex gap-4">
               <button 
                  onClick={handleSubmit}
                  disabled={loading}
                  className="flex-1 py-5 bg-slate-900 text-white rounded-3xl font-black text-xl hover:bg-slate-800 transition-all shadow-xl active:scale-95 disabled:opacity-50"
               >
                  {loading ? 'جاري الحفظ...' : 'حفظ التعديلات'}
               </button>
               <button onClick={onClose} className="px-10 py-5 bg-white dark:bg-slate-900 text-slate-500 rounded-3xl font-black text-xl border border-slate-100 dark:border-slate-700 hover:bg-slate-50 transition-all">إلغاء</button>
            </div>
         </div>
      </div>
   );
}

function AddAccountModal({ show, parentId, onClose, onSuccess, accounts }: any) {
   const [loading, setLoading] = useState(false);
   const parent = accounts.find((a: any) => a.id === parentId);
   const [formData, setFormData] = useState({
      name_ar: '',
      name_en: '',
      code: '',
      type: parent?.type || 'expense',
      is_group: 0
   });

   
  useHotkeys('enter', (e) => { e.preventDefault(); handleSubmit(); }, { enableOnFormTags: ['input', 'select'] });

  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });
if (!show) return null;

   const handleSubmit = async () => {
      if (!formData.name_ar || !formData.code) return toast.error('يرجى إكمال البيانات الأساسية');
      setLoading(true);
      const res = await addAccountAction({
         ...formData,
         parent_id: parentId
      });
      if (res.success) {
         toast.success('تم إضافة الحساب بنجاح');
         onSuccess();
         onClose();
      } else {
         toast.error(res.error || 'فشل إضافة الحساب');
      }
      setLoading(false);
   };

   return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300">
         <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col max-h-[90vh]">
            <div className="p-10 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
               <div>
                  <h3 className="text-2xl font-black text-slate-800 dark:text-white">إضافة حساب فرعي جديد</h3>
                  <p className="text-slate-500 font-bold">للحساب الرئيسي: <span className="text-blue-600">{parent?.name_ar || 'دليل الحسابات'}</span></p>
               </div>
               <button onClick={onClose} className="p-4 bg-white dark:bg-slate-800 text-slate-400 rounded-2xl hover:text-rose-500 transition-all shadow-sm"><X className="w-6 h-6" /></button>
            </div>
            
            <div className="p-10 space-y-8 overflow-y-auto custom-scrollbar">
               <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-3">
                     <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">كود الحساب</label>
                     <input 
                        type="text" 
                        value={formData.code}
                        onChange={e => setFormData({...formData, code: e.target.value})}
                        placeholder="مثال: 51101"
                        className="w-full px-8 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none font-black text-blue-600 focus:ring-4 ring-blue-500/10 transition-all border border-transparent focus:border-blue-500/20"
                     />
                  </div>
                  <div className="space-y-3">
                     <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">نوع الحساب</label>
                     <select 
                        value={formData.type}
                        onChange={e => setFormData({...formData, type: e.target.value as any})}
                        className="w-full px-8 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none font-black focus:ring-4 ring-blue-500/10 transition-all border border-transparent focus:border-blue-500/20"
                     >
                        <option value="asset">أصول (Assets)</option>
                        <option value="liability">خصوم (Liabilities)</option>
                        <option value="equity">حقوق ملكية (Equity)</option>
                        <option value="income">إيرادات (Income)</option>
                        <option value="expense">مصروفات (Expenses)</option>
                     </select>
                  </div>
               </div>

               <div className="space-y-3">
                  <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">إسم الحساب (بالعربي)</label>
                  <input 
                     type="text" 
                     value={formData.name_ar}
                     onChange={e => setFormData({...formData, name_ar: e.target.value})}
                     className="w-full px-8 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none font-black focus:ring-4 ring-blue-500/10 transition-all border border-transparent focus:border-blue-500/20"
                  />
               </div>

               <div className="space-y-3">
                  <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">إسم الحساب (English)</label>
                  <input 
                     type="text" 
                     value={formData.name_en}
                     onChange={e => setFormData({...formData, name_en: e.target.value})}
                     className="w-full px-8 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none font-black focus:ring-4 ring-blue-500/10 transition-all border border-transparent focus:border-blue-500/20"
                  />
               </div>

               <div className="flex items-center gap-4 p-6 bg-blue-50 dark:bg-blue-900/10 rounded-3xl border border-blue-100 dark:border-blue-800">
                  <input 
                     type="checkbox" 
                     checked={formData.is_group === 1}
                     onChange={e => setFormData({...formData, is_group: e.target.checked ? 1 : 0})}
                     className="w-6 h-6 rounded-lg text-blue-600 focus:ring-blue-500 transition-all cursor-pointer"
                  />
                  <div>
                     <p className="font-black text-blue-700">هذا الحساب هو &quot;حساب رئيسي&quot; (Group)</p>
                     <p className="text-[10px] font-bold text-blue-600 opacity-70 italic">الحسابات الرئيسية لا تقبل قيود مباشرة، بل تحتوي على حسابات فرعية</p>
                  </div>
               </div>
            </div>

            <div className="p-10 bg-slate-50 dark:bg-slate-800/50 flex gap-4">
               <button 
                  onClick={handleSubmit}
                  disabled={loading}
                  className="flex-1 py-5 bg-slate-900 text-white rounded-3xl font-black text-xl hover:bg-slate-800 transition-all shadow-xl active:scale-95 disabled:opacity-50"
               >
                  {loading ? 'جاري الحفظ...' : 'إضافة الحساب'}
               </button>
               <button onClick={onClose} className="px-10 py-5 bg-white dark:bg-slate-900 text-slate-500 rounded-3xl font-black text-xl border border-slate-100 dark:border-slate-700 hover:bg-slate-50 transition-all">إلغاء</button>
            </div>
         </div>
      </div>
   );
}

function JournalDetailsModal({ journalId, onClose }: { journalId: string | null, onClose: () => void }) {
   const [entries, setEntries] = useState<any[]>([]);
   const [loading, setLoading] = useState(false);

   useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

   useEffect(() => {
      if (journalId) {
         setLoading(true);
         getJournalDetailsAction(journalId).then(res => {
            if (res.success) setEntries(res.data);
            setLoading(false);
         });
      }
   }, [journalId]);

   if (!journalId) return null;

   const totalDebit = entries.reduce((sum, e) => sum + e.debit, 0);
   const totalCredit = entries.reduce((sum, e) => sum + e.credit, 0);

   return (
      <div className="fixed inset-0 z-[110] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300">
         <div className="bg-white dark:bg-slate-900 w-full max-w-4xl rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col max-h-[90vh]">
            <div className="p-10 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
               <div className="flex items-center gap-5">
                  <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-lg">
                     <FileText className="w-8 h-8" />
                  </div>
                  <div>
                     <h3 className="text-2xl font-black text-slate-800 dark:text-white">تفاصيل القيد المحاسبي</h3>
                     <p className="text-slate-500 font-bold tracking-widest font-mono">#{journalId.slice(0, 12).toUpperCase()}</p>
                  </div>
               </div>
               <button onClick={onClose} className="p-4 bg-white dark:bg-slate-800 text-slate-400 rounded-2xl hover:text-rose-500 transition-all shadow-sm"><X className="w-6 h-6" /></button>
            </div>

            <div className="p-10 overflow-y-auto custom-scrollbar flex-1">
               {loading ? (
                  <div className="py-20 text-center">
                     <Activity className="w-12 h-12 animate-spin text-blue-500 mx-auto mb-4" />
                     <p className="text-slate-400 font-bold italic">جاري تحميل تفاصيل القيد...</p>
                  </div>
               ) : (
                  <div className="space-y-8">
                     <div className="bg-slate-50 dark:bg-slate-800/50 p-8 rounded-[32px] border border-slate-100 dark:border-slate-700/50 flex justify-between">
                        <div>
                           <p className="text-[10px] font-black text-slate-400 uppercase mb-1">البيان / الوصف</p>
                           <p className="text-lg font-black text-slate-800 dark:text-white">{entries[0]?.description || 'بدون بيان'}</p>
                        </div>
                        <div className="text-left">
                           <p className="text-[10px] font-black text-slate-400 uppercase mb-1">تاريخ القيد</p>
                           <p className="text-lg font-black text-slate-800 dark:text-white">{safeFormat(entries[0]?.date, 'yyyy/MM/dd HH:mm')}</p>
                        </div>
                     </div>

                     <div className="rounded-[32px] border border-slate-100 dark:border-slate-800 overflow-hidden">
                        <table className="w-full text-right border-collapse">
                           <thead className="bg-slate-100 dark:bg-slate-800">
                              <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                 <th className="px-8 py-5">الحساب</th>
                                 <th className="px-8 py-5 text-center">مدين (Debit)</th>
                                 <th className="px-8 py-5 text-center">دائن (Credit)</th>
                                 <th className="px-8 py-5">ملاحظات</th>
                              </tr>
                           </thead>
                           <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                              {entries.map((entry, idx) => (
                                 <tr key={idx} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                                    <td className="px-8 py-5">
                                       <p className="font-black text-slate-800 dark:text-white">{entry.account_name}</p>
                                       <p className="text-[10px] font-mono font-bold text-blue-500">{entry.account_code}</p>
                                    </td>
                                    <td className="px-8 py-5 text-center font-black text-emerald-600 bg-emerald-50/10">
                                       {entry.debit > 0 ? entry.debit.toLocaleString() : '-'}
                                    </td>
                                    <td className="px-8 py-5 text-center font-black text-rose-600 bg-rose-50/10">
                                       {entry.credit > 0 ? entry.credit.toLocaleString() : '-'}
                                    </td>
                                    <td className="px-8 py-5 text-sm font-bold text-slate-400">{entry.notes || '-'}</td>
                                 </tr>
                              ))}
                           </tbody>
                           <tfoot className="bg-slate-50 dark:bg-slate-800/80 font-black">
                              <tr>
                                 <td className="px-8 py-6">الإجمالي</td>
                                 <td className="px-8 py-6 text-center text-emerald-600 text-lg">{totalDebit.toLocaleString()} ج.م</td>
                                 <td className="px-8 py-6 text-center text-rose-600 text-lg">{totalCredit.toLocaleString()} ج.م</td>
                                 <td className="px-8 py-6">
                                    {totalDebit === totalCredit ? (
                                       <div className="flex items-center gap-2 text-emerald-500">
                                          <CheckCircle className="w-4 h-4" />
                                          <span className="text-xs uppercase">متوازن</span>
                                       </div>
                                    ) : (
                                       <div className="flex items-center gap-2 text-rose-500">
                                          <AlertCircle className="w-4 h-4" />
                                          <span className="text-xs uppercase">غير متوازن</span>
                                       </div>
                                    )}
                                 </td>
                              </tr>
                           </tfoot>
                        </table>
                     </div>
                  </div>
               )}
            </div>

            <div className="p-10 bg-slate-50 dark:bg-slate-800/50 flex gap-4">
               <button onClick={() => window.print()} className="flex-1 py-5 bg-slate-900 text-white rounded-3xl font-black text-xl hover:bg-slate-800 transition-all flex items-center justify-center gap-3 active:scale-95 shadow-xl">
                  <Printer className="w-6 h-6" /> طباعة القيد
               </button>
               <button onClick={onClose} className="px-10 py-5 bg-white dark:bg-slate-900 text-slate-500 rounded-3xl font-black text-xl border border-slate-100 dark:border-slate-700 hover:bg-slate-50 transition-all">إغلاق</button>
            </div>
         </div>
      </div>
   );
}

function ExpenseDefinitionModal({
  show,
  initialData,
  onClose,
  onSuccess,
}: {
  show: boolean;
  initialData?: any;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isEditing = !!initialData;
  const [formData, setFormData] = useState({
    code: '',
    name_ar: '',
    name_en: '',
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialData) {
      setFormData({
        code: initialData.code || '',
        name_ar: initialData.name_ar || '',
        name_en: initialData.name_en || '',
      });
    } else {
      setFormData({
        code: '',
        name_ar: '',
        name_en: '',
      });
    }
  }, [initialData, show]);

  useHotkeys('esc', () => onClose(), { enabled: show, enableOnFormTags: true });

  if (!show) return null;

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!formData.code.trim()) {
      toast.error('يرجى إدخال كود المصروف');
      return;
    }
    if (!formData.name_ar.trim()) {
      toast.error('يرجى إدخال اسم المصروف بالعربي');
      return;
    }

    setLoading(true);
    let res: any;
    if (isEditing) {
      res = await updateExpenseDefinitionAction(initialData.id, formData);
    } else {
      res = await addExpenseDefinitionAction(formData);
    }

    if (res.success) {
      toast.success(isEditing ? 'تم تعديل تعريف المصروف بنجاح' : 'تم إضافة نوع المصروف بنجاح');
      onSuccess();
      onClose();
    } else {
      toast.error(res.error || 'فشل حفظ البيانات');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-amber-50/40 dark:bg-amber-950/20">
          <div>
            <h3 className="text-2xl font-black text-slate-800 dark:text-white">
              {isEditing ? 'تعديل تعريف المصروف' : 'إضافة نوع مصروف جديد'}
            </h3>
            <p className="text-slate-500 font-bold text-xs">
              {isEditing ? `المصروف: #${initialData.code} - ${initialData.name_ar}` : 'تكويد وتصنيف المصروفات التشغيلية'}
            </p>
          </div>
          <button onClick={onClose} className="p-3 bg-white dark:bg-slate-800 text-slate-400 rounded-2xl hover:text-rose-500 transition-all shadow-sm">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-2">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">كود المصروف *</label>
            <input
              type="text"
              autoFocus
              value={formData.code}
              onChange={e => setFormData({ ...formData, code: e.target.value })}
              placeholder="مثال: 501 أو 52"
              className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none font-mono font-black text-amber-600 focus:ring-4 ring-amber-500/10 transition-all border border-transparent focus:border-amber-500/20"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">اسم المصروف (بالعربي) *</label>
            <input
              type="text"
              value={formData.name_ar}
              onChange={e => setFormData({ ...formData, name_ar: e.target.value })}
              placeholder="مثال: كهرباء وإنارة أو صيانة ونظافة"
              className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none font-black focus:ring-4 ring-amber-500/10 transition-all border border-transparent focus:border-amber-500/20"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">اسم المصروف (English)</label>
            <input
              type="text"
              value={formData.name_en}
              onChange={e => setFormData({ ...formData, name_en: e.target.value })}
              placeholder="e.g. Electricity or Maintenance"
              className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none font-black focus:ring-4 ring-amber-500/10 transition-all border border-transparent focus:border-amber-500/20"
            />
          </div>

          <div className="pt-4 flex gap-4">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-4 bg-amber-600 text-white rounded-2xl font-black text-lg hover:bg-amber-700 transition-all flex items-center justify-center gap-2 active:scale-95 shadow-xl disabled:opacity-50"
            >
              <Save className="w-5 h-5" />
              {loading ? 'جاري الحفظ...' : isEditing ? 'حفظ التعديلات' : 'إضافة المصروف'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-4 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-2xl font-black hover:bg-slate-200 transition-all"
            >
              إلغاء
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RecordExpenseModal({
  show,
  categories,
  onClose,
  onSuccess,
}: {
  show: boolean;
  categories: any[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [formData, setFormData] = useState({
    category: '',
    amount: '',
    description: '',
    date: new Date().toISOString().split('T')[0],
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (show) {
      setFormData({
        category: categories.length > 0 ? (categories[0].code || categories[0].name_ar) : 'other',
        amount: '',
        description: '',
        date: new Date().toISOString().split('T')[0],
      });
    }
  }, [show, categories]);

  useHotkeys('esc', () => onClose(), { enabled: show, enableOnFormTags: true });

  if (!show) return null;

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const amt = parseFloat(formData.amount);
    if (!amt || amt <= 0) {
      toast.error('يرجى إدخال مبلغ صحيح للمصروف');
      return;
    }
    if (!formData.category) {
      toast.error('يرجى اختيار تصنيف المصروف');
      return;
    }

    setLoading(true);
    const res = await addExpenseAction({
      category: formData.category,
      amount: amt,
      description: formData.description.trim(),
      date: formData.date || new Date().toISOString().split('T')[0],
    });

    if (res.success) {
      toast.success('تم تسجيل المصروف وحركته النقدية بنجاح');
      onSuccess();
      onClose();
    } else {
      toast.error(res.error || 'فشل تسجيل المصروف');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-rose-50/40 dark:bg-rose-950/20">
          <div>
            <h3 className="text-2xl font-black text-slate-800 dark:text-white">إضافة مصروف تشغيلي جديد</h3>
            <p className="text-xs font-bold text-slate-400 mt-1">تسجيل مصروف فعلي مع خصم تلقائي من الخزينة وربط القيود المحاسبية</p>
          </div>
          <button onClick={onClose} className="p-3 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 mr-2">تصنيف المصروف *</label>
            <select
              value={formData.category}
              onChange={e => setFormData({ ...formData, category: e.target.value })}
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-rose-500 transition-all"
            >
              {categories.map((cat: any) => (
                <option key={cat.id || cat.code} value={cat.code || cat.name_ar}>
                  {cat.name_ar} {cat.code ? `(${cat.code})` : ''}
                </option>
              ))}
              {categories.length === 0 && (
                <>
                  <option value="salaries">أجور ومرتبات</option>
                  <option value="rent">إيجار</option>
                  <option value="electricity">كهرباء وإنارة</option>
                  <option value="operating_expenses">مصروفات تشغيلية</option>
                  <option value="other">مصروفات أخرى</option>
                </>
              )}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">قيمة المصروف (ج.م) *</label>
              <input
                type="number"
                step="any"
                min="0.01"
                required
                placeholder="0.00"
                value={formData.amount}
                onChange={e => setFormData({ ...formData, amount: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-black text-lg text-rose-600 focus:border-rose-500 transition-all font-mono"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">تاريخ المصروف *</label>
              <input
                type="date"
                required
                value={formData.date}
                onChange={e => setFormData({ ...formData, date: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-rose-500 transition-all font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 mr-2">ملاحظات / وصف المصروف</label>
            <textarea
              rows={3}
              placeholder="اكتب بيان أو سبب المصروف..."
              value={formData.description}
              onChange={e => setFormData({ ...formData, description: e.target.value })}
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-rose-500 transition-all resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-3.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300 rounded-2xl font-bold text-sm transition-all"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-8 py-3.5 bg-rose-600 hover:bg-rose-700 text-white rounded-2xl font-black text-sm transition-all shadow-lg shadow-rose-600/20 active:scale-95 disabled:opacity-50 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>{loading ? 'جاري الحفظ...' : 'حفظ المصروف'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// BankModal
// -------------------------------------------------------------
interface BankModalProps {
  show: boolean;
  initialData?: any | null;
  onClose: () => void;
  onSuccess: () => void;
}

function BankModal({ show, initialData, onClose, onSuccess }: BankModalProps) {
  const [formData, setFormData] = useState({
    name_ar: '',
    name_en: '',
    account_number: '',
    branch: '',
    current_balance: ''
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialData) {
      setFormData({
        name_ar: initialData.name_ar || '',
        name_en: initialData.name_en || '',
        account_number: initialData.account_number || '',
        branch: initialData.branch || '',
        current_balance: initialData.current_balance !== undefined ? String(initialData.current_balance) : ''
      });
    } else {
      setFormData({ name_ar: '', name_en: '', account_number: '', branch: '', current_balance: '' });
    }
  }, [initialData, show]);

  if (!show) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name_ar.trim()) {
      toast.error('يرجى إدخال اسم البنك بالعربي');
      return;
    }

    setLoading(true);
    let res;
    if (initialData?.id) {
      res = await updateBankAction(initialData.id, {
        name_ar: formData.name_ar.trim(),
        name_en: formData.name_en.trim() || undefined,
        account_number: formData.account_number.trim() || undefined,
        branch: formData.branch.trim() || undefined
      });
    } else {
      res = await addBankAction({
        name_ar: formData.name_ar.trim(),
        name_en: formData.name_en.trim() || undefined,
        account_number: formData.account_number.trim() || undefined,
        branch: formData.branch.trim() || undefined,
        current_balance: formData.current_balance ? parseFloat(formData.current_balance) : 0
      });
    }

    if (res.success) {
      toast.success(initialData ? 'تم تعديل الحساب البنكي بنجاح' : 'تمت إضافة الحساب البنكي بنجاح');
      onSuccess();
      onClose();
    } else {
      toast.error(res.error || 'فشل حفظ الحساب البنكي');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-blue-50/40 dark:bg-blue-950/20">
          <div>
            <h3 className="text-2xl font-black text-slate-800 dark:text-white">{initialData ? 'تعديل الحساب البنكي' : 'إضافة حساب بنكي جديد'}</h3>
            <p className="text-xs font-bold text-slate-400 mt-1">تسجيل وتحديث بيانات الحسابات المصرفية وأرصدتها</p>
          </div>
          <button onClick={onClose} className="p-3 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">اسم البنك (عربي) *</label>
              <input
                type="text"
                required
                placeholder="مثال: البنك الأهلي المصري"
                value={formData.name_ar}
                onChange={e => setFormData({ ...formData, name_ar: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-blue-500 transition-all"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">اسم البنك (إنجليزي)</label>
              <input
                type="text"
                placeholder="مثال: NBE"
                value={formData.name_en}
                onChange={e => setFormData({ ...formData, name_en: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-blue-500 transition-all"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">رقم الحساب / IBAN</label>
              <input
                type="text"
                placeholder="مثال: 123456789012"
                value={formData.account_number}
                onChange={e => setFormData({ ...formData, account_number: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-blue-500 transition-all font-mono"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">الفرع</label>
              <input
                type="text"
                placeholder="مثال: فرع المعادي"
                value={formData.branch}
                onChange={e => setFormData({ ...formData, branch: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-blue-500 transition-all"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 mr-2">{initialData ? 'الرصيد الحالي (للعرض فقط)' : 'الرصيد الافتتاحي (عند الإنشاء فقط)'}</label>
            <input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={formData.current_balance}
              disabled={!!initialData}
              onChange={e => setFormData({ ...formData, current_balance: e.target.value })}
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-lg text-slate-900 dark:text-white focus:border-blue-500 transition-all font-mono disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="px-6 py-3.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300 rounded-2xl font-bold text-sm transition-all">إلغاء</button>
            <button type="submit" disabled={loading} className="px-8 py-3.5 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black text-sm transition-all shadow-lg shadow-blue-600/20 active:scale-95 disabled:opacity-50 flex items-center gap-2">
              <Plus className="w-4 h-4" />
              <span>{loading ? 'جاري الحفظ...' : initialData ? 'حفظ التعديلات' : 'إضافة الحساب'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// CardModal
// -------------------------------------------------------------
interface CardModalProps {
  show: boolean;
  initialData?: any | null;
  banks: any[];
  onClose: () => void;
  onSuccess: () => void;
}

function CardModal({ show, initialData, banks, onClose, onSuccess }: CardModalProps) {
  const [formData, setFormData] = useState({
    name_ar: '',
    name_en: '',
    bank_id: '',
    commission_pct: '0',
    current_balance: '0'
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialData) {
      setFormData({
        name_ar: initialData.name_ar || '',
        name_en: initialData.name_en || '',
        bank_id: initialData.bank_id ? String(initialData.bank_id) : '',
        commission_pct: initialData.commission_pct !== undefined ? String(initialData.commission_pct) : '0',
        current_balance: initialData.current_balance !== undefined ? String(initialData.current_balance) : '0'
      });
    } else {
      setFormData({ name_ar: '', name_en: '', bank_id: '', commission_pct: '0', current_balance: '0' });
    }
  }, [initialData, show]);

  if (!show) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name_ar.trim()) {
      toast.error('يرجى إدخال اسم الماكينة / البطاقة');
      return;
    }

    setLoading(true);
    let res;
    if (initialData?.id) {
      res = await updateCardAction(initialData.id, {
        name_ar: formData.name_ar.trim(),
        name_en: formData.name_en.trim() || undefined,
        bank_id: formData.bank_id ? parseInt(formData.bank_id) : null,
        commission_pct: parseFloat(formData.commission_pct) || 0
      });
    } else {
      res = await addCardAction({
        name_ar: formData.name_ar.trim(),
        name_en: formData.name_en.trim() || undefined,
        bank_id: formData.bank_id ? parseInt(formData.bank_id) : null,
        commission_pct: parseFloat(formData.commission_pct) || 0,
        current_balance: parseFloat(formData.current_balance) || 0
      });
    }

    if (res.success) {
      toast.success(initialData ? 'تم تعديل ماكينة الدفع بنجاح' : 'تمت إضافة ماكينة الدفع بنجاح');
      onSuccess();
      onClose();
    } else {
      toast.error(res.error || 'فشل حفظ ماكينة الدفع');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-indigo-50/40 dark:bg-indigo-950/20">
          <div>
            <h3 className="text-2xl font-black text-slate-800 dark:text-white">{initialData ? 'تعديل ماكينة التحصيل / البطاقة' : 'إضافة ماكينة تحصيل / كارت'}</h3>
            <p className="text-xs font-bold text-slate-400 mt-1">ربط ماكينات الدفع الإلكتروني (POS Terminals) ونسب العمولة البنكية</p>
          </div>
          <button onClick={onClose} className="p-3 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">اسم الماكينة / الحساب *</label>
              <input
                type="text"
                required
                placeholder="مثال: فوري - كاشير 1"
                value={formData.name_ar}
                onChange={e => setFormData({ ...formData, name_ar: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-indigo-500 transition-all"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">الاسم بالإنجليزية</label>
              <input
                type="text"
                placeholder="مثال: Fawry POS 1"
                value={formData.name_en}
                onChange={e => setFormData({ ...formData, name_en: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-indigo-500 transition-all"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 mr-2">البنك المرتبط (اختياري)</label>
            <select
              value={formData.bank_id}
              onChange={e => setFormData({ ...formData, bank_id: e.target.value })}
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-indigo-500 transition-all"
            >
              <option value="">بدون ربط بنكي مباشر</option>
              {banks.map(b => (
                <option key={b.id} value={b.id}>{b.name_ar} {b.account_number ? `(${b.account_number})` : ''}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">نسبة العمولة (%)</label>
              <input
                type="number"
                step="0.01"
                placeholder="مثال: 1.5"
                value={formData.commission_pct}
                onChange={e => setFormData({ ...formData, commission_pct: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-indigo-500 transition-all font-mono"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">{initialData ? 'الرصيد الحالي (للعرض فقط)' : 'الرصيد الافتتاحي'}</label>
              <input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={formData.current_balance}
                disabled={!!initialData}
                onChange={e => setFormData({ ...formData, current_balance: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-indigo-500 transition-all font-mono disabled:opacity-60 disabled:cursor-not-allowed"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="px-6 py-3.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300 rounded-2xl font-bold text-sm transition-all">إلغاء</button>
            <button type="submit" disabled={loading} className="px-8 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black text-sm transition-all shadow-lg shadow-indigo-600/20 active:scale-95 disabled:opacity-50 flex items-center gap-2">
              <Plus className="w-4 h-4" />
              <span>{loading ? 'جاري الحفظ...' : initialData ? 'حفظ التعديلات' : 'إضافة الماكينة'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// PosModal
// -------------------------------------------------------------
interface PosModalProps {
  show: boolean;
  initialData?: any | null;
  onClose: () => void;
  onSuccess: () => void;
}

function PosModal({ show, initialData, onClose, onSuccess }: PosModalProps) {
  const [formData, setFormData] = useState({
    name_ar: '',
    name_en: '',
    location: '',
    computer_name: ''
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialData) {
      setFormData({
        name_ar: initialData.name_ar || '',
        name_en: initialData.name_en || '',
        location: initialData.location || '',
        computer_name: initialData.computer_name || ''
      });
    } else {
      setFormData({ name_ar: '', name_en: '', location: '', computer_name: '' });
    }
  }, [initialData, show]);

  if (!show) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name_ar.trim()) {
      toast.error('يرجى إدخال اسم نقطة البيع بالعربي');
      return;
    }

    setLoading(true);
    let res;
    if (initialData?.id) {
      res = await updatePointOfSaleAction(initialData.id, {
        name_ar: formData.name_ar.trim(),
        name_en: formData.name_en.trim() || undefined,
        location: formData.location.trim() || undefined,
        computer_name: formData.computer_name.trim() || undefined
      });
    } else {
      res = await addPointOfSaleAction({
        name_ar: formData.name_ar.trim(),
        name_en: formData.name_en.trim() || undefined,
        location: formData.location.trim() || undefined,
        computer_name: formData.computer_name.trim() || undefined
      });
    }

    if (res.success) {
      toast.success(initialData ? 'تم تعديل نقطة البيع بنجاح' : 'تمت إضافة نقطة البيع بنجاح');
      onSuccess();
      onClose();
    } else {
      toast.error(res.error || 'فشل حفظ نقطة البيع');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-purple-50/40 dark:bg-purple-950/20">
          <div>
            <h3 className="text-2xl font-black text-slate-800 dark:text-white">{initialData ? 'تعديل نقطة البيع (POS)' : 'إضافة نقطة بيع جديدة'}</h3>
            <p className="text-xs font-bold text-slate-400 mt-1">تعريف محطات وأجهزة الكاشير ونقاط البيع المختلفة</p>
          </div>
          <button onClick={onClose} className="p-3 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">اسم النقطة (عربي) *</label>
              <input
                type="text"
                required
                placeholder="مثال: كاشير 1 - الصالة"
                value={formData.name_ar}
                onChange={e => setFormData({ ...formData, name_ar: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">اسم النقطة (إنجليزي)</label>
              <input
                type="text"
                placeholder="مثال: POS-01"
                value={formData.name_en}
                onChange={e => setFormData({ ...formData, name_en: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">الموقع / القسم</label>
              <input
                type="text"
                placeholder="مثال: الصالة الرئيسية"
                value={formData.location}
                onChange={e => setFormData({ ...formData, location: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">اسم الكمبيوتر / الجهاز</label>
              <input
                type="text"
                placeholder="مثال: PC-PHARMA-01"
                value={formData.computer_name}
                onChange={e => setFormData({ ...formData, computer_name: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all font-mono"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="px-6 py-3.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300 rounded-2xl font-bold text-sm transition-all">إلغاء</button>
            <button type="submit" disabled={loading} className="px-8 py-3.5 bg-purple-600 hover:bg-purple-700 text-white rounded-2xl font-black text-sm transition-all shadow-lg shadow-purple-600/20 active:scale-95 disabled:opacity-50 flex items-center gap-2">
              <Plus className="w-4 h-4" />
              <span>{loading ? 'جاري الحفظ...' : initialData ? 'حفظ التعديلات' : 'إضافة النقطة'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// PaperModal (Commercial Papers / Cheques)
// -------------------------------------------------------------
interface PaperModalProps {
  show: boolean;
  type: 'check' | 'promissory_note';
  direction: 'in' | 'out';
  banks: any[];
  onClose: () => void;
  onSuccess: () => void;
}

function PaperModal({ show, type, direction, banks, onClose, onSuccess }: PaperModalProps) {
  const [formData, setFormData] = useState({
    paper_number: '',
    target_name: '',
    amount: '',
    due_date: new Date().toISOString().split('T')[0],
    bank_id: '',
    notes: ''
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (show) {
      setFormData({
        paper_number: '',
        target_name: '',
        amount: '',
        due_date: new Date().toISOString().split('T')[0],
        bank_id: '',
        notes: ''
      });
    }
  }, [show]);

  if (!show) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(formData.amount);
    if (!formData.paper_number.trim()) { toast.error('يرجى إدخال رقم الورقة / الشيك'); return; }
    if (isNaN(amt) || amt <= 0) { toast.error('يرجى إدخال مبلغ صحيح أكبر من صفر'); return; }
    if (!formData.target_name.trim()) { toast.error('يرجى إدخال اسم الجهة / الساحب'); return; }

    setLoading(true);
    const res = await addPaperAction({
      type: type || 'check',
      direction: direction || 'in',
      paper_number: formData.paper_number.trim(),
      bank_id: formData.bank_id ? parseInt(formData.bank_id) : null,
      amount: amt,
      due_date: formData.due_date,
      target_name: formData.target_name.trim(),
      notes: formData.notes.trim() || undefined
    });

    if (res.success) {
      toast.success('تم تسجيل الورقة المالية بنجاح');
      onSuccess();
      onClose();
    } else {
      toast.error(res.error || 'فشل تسجيل الورقة المالية');
    }
    setLoading(false);
  };

  const isCheck = type === 'check';
  const isIncoming = direction === 'in';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col">
        <div className={cn("p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center", isIncoming ? "bg-indigo-50/40 dark:bg-indigo-950/20" : "bg-purple-50/40 dark:bg-purple-950/20")}>
          <div>
            <h3 className="text-2xl font-black text-slate-800 dark:text-white">تسجيل {isCheck ? 'شيك' : 'كمبيالة'} {isIncoming ? 'وارد (مقبوض)' : 'صادر (مدفوع)'}</h3>
            <p className="text-xs font-bold text-slate-400 mt-1">متابعة استحقاق الورقة المالية ومواعيد تحصيلها وصرفها</p>
          </div>
          <button onClick={onClose} className="p-3 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">رقم {isCheck ? 'الشيك' : 'الورقة'} *</label>
              <input
                type="text"
                required
                placeholder="مثال: 987456"
                value={formData.paper_number}
                onChange={e => setFormData({ ...formData, paper_number: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all font-mono"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">المبلغ (ج.م) *</label>
              <input
                type="number"
                step="0.01"
                required
                placeholder="0.00"
                value={formData.amount}
                onChange={e => setFormData({ ...formData, amount: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">{isIncoming ? 'اسم الساحب / العميل *' : 'اسم المستفيد / المورد *'}</label>
              <input
                type="text"
                required
                placeholder="الجهة أو الشخص"
                value={formData.target_name}
                onChange={e => setFormData({ ...formData, target_name: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">تاريخ الاستحقاق *</label>
              <input
                type="date"
                required
                value={formData.due_date}
                onChange={e => setFormData({ ...formData, due_date: e.target.value })}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 mr-2">البنك المسحوب عليه (اختياري)</label>
            <select
              value={formData.bank_id}
              onChange={e => setFormData({ ...formData, bank_id: e.target.value })}
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all"
            >
              <option value="">بدون تحديد بنك</option>
              {banks.map(b => (
                <option key={b.id} value={b.id}>{b.name_ar} {b.account_number ? `(${b.account_number})` : ''}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 mr-2">ملاحظات إضافية</label>
            <textarea
              rows={2}
              placeholder="اكتب أي ملاحظات أو تفاصيل إضافية..."
              value={formData.notes}
              onChange={e => setFormData({ ...formData, notes: e.target.value })}
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-purple-500 transition-all resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="px-6 py-3.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300 rounded-2xl font-bold text-sm transition-all">إلغاء</button>
            <button type="submit" disabled={loading} className={cn("px-8 py-3.5 text-white rounded-2xl font-black text-sm transition-all shadow-lg active:scale-95 disabled:opacity-50 flex items-center gap-2", isIncoming ? "bg-indigo-600 hover:bg-indigo-700 shadow-indigo-600/20" : "bg-purple-600 hover:bg-purple-700 shadow-purple-600/20")}>
              <Plus className="w-4 h-4" />
              <span>{loading ? 'جاري الحفظ...' : 'تسجيل الورقة المالية'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// ManualJournalModal (Manual Double-Entry Journal Voucher)
// -------------------------------------------------------------
interface ManualJournalModalProps {
  show: boolean;
  accounts: any[];
  onClose: () => void;
  onSuccess: () => void;
}

interface JournalLineItem {
  account_id: string;
  type: 'debit' | 'credit';
  amount: string;
  notes: string;
}

function ManualJournalModal({ show, accounts, onClose, onSuccess }: ManualJournalModalProps) {
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [description, setDescription] = useState('');
  const [entries, setEntries] = useState<JournalLineItem[]>([
    { account_id: '', type: 'debit', amount: '', notes: '' },
    { account_id: '', type: 'credit', amount: '', notes: '' }
  ]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (show) {
      setDate(new Date().toISOString().split('T')[0]);
      setDescription('');
      setEntries([
        { account_id: '', type: 'debit', amount: '', notes: '' },
        { account_id: '', type: 'credit', amount: '', notes: '' }
      ]);
    }
  }, [show]);

  if (!show) return null;

  const leafAccounts = accounts.filter(a => a.is_group === 0);

  const totalDebit = entries.filter(e => e.type === 'debit').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const totalCredit = entries.filter(e => e.type === 'credit').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const diff = Math.abs(totalDebit - totalCredit);
  const isBalanced = diff < 0.01 && totalDebit > 0;

  const addLine = () => {
    setEntries([...entries, { account_id: '', type: 'debit', amount: '', notes: '' }]);
  };

  const removeLine = (idx: number) => {
    if (entries.length <= 2) {
      toast.error('يجب أن يتضمن القيد طرفين على الأقل');
      return;
    }
    setEntries(entries.filter((_, i) => i !== idx));
  };

  const updateLine = (idx: number, field: string, value: any) => {
    const updated = [...entries];
    updated[idx] = { ...updated[idx], [field]: value };
    setEntries(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) { toast.error('يرجى إدخال بيان القيد اليومي'); return; }
    if (!isBalanced) { toast.error(`القيد غير متزن. الفارق بين المدين والدائن: ${diff.toFixed(2)} ج.م`); return; }

    for (const line of entries) {
      if (!line.account_id) { toast.error('يرجى اختيار الحساب لجميع أطراف القيد'); return; }
      if (!parseFloat(line.amount) || parseFloat(line.amount) <= 0) { toast.error('يجب أن تكون المبالغ أكبر من صفر'); return; }
    }

    setLoading(true);
    const res = await createManualJournalAction({
      date,
      description: description.trim(),
      entries: entries.map(ent => ({
        account_id: parseInt(ent.account_id),
        type: ent.type,
        amount: parseFloat(ent.amount),
        notes: ent.notes?.trim() || undefined
      }))
    });

    if (res.success) {
      toast.success('تم إنشاء القيد اليومي المزدوج بنجاح');
      onSuccess();
      onClose();
    } else {
      toast.error(res.error || 'فشل إنشاء القيد اليومي');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 w-full max-w-3xl rounded-[48px] overflow-hidden shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col max-h-[90vh]">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-blue-50/40 dark:bg-blue-950/20">
          <div>
            <h3 className="text-2xl font-black text-slate-800 dark:text-white">إنشاء سند قيد يومي يدوي</h3>
            <p className="text-xs font-bold text-slate-400 mt-1">تسجيل حركة محاسبية مزدوجة (مدين / دائن) مع التحقق الفوري من التوازن</p>
          </div>
          <button onClick={onClose} className="p-3 bg-slate-100 dark:bg-slate-800 rounded-full hover:bg-slate-200 transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6 overflow-y-auto flex-1">
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">تاريخ القيد *</label>
              <input
                type="date"
                required
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-blue-500 transition-all font-mono"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-xs font-black text-slate-500 mr-2">بيان القيد العام *</label>
              <input
                type="text"
                required
                placeholder="مثال: تسوية رصيد بنكي / قيد إقفال عهدة"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-sm text-slate-900 dark:text-white focus:border-blue-500 transition-all"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm font-black text-slate-700 dark:text-slate-300">أطراف القيد المحاسبي:</span>
              <button
                type="button"
                onClick={addLine}
                className="px-4 py-2 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-xl text-xs font-black transition-all flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" /> إضافة طرف
              </button>
            </div>

            <div className="space-y-3">
              {entries.map((line, idx) => (
                <div key={idx} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-200 dark:border-slate-700 flex flex-wrap md:flex-nowrap items-center gap-3">
                  <div className="w-28">
                    <select
                      value={line.type}
                      onChange={e => updateLine(idx, 'type', e.target.value)}
                      className={cn(
                        "w-full p-3 rounded-xl border outline-none font-black text-xs transition-all",
                        line.type === 'debit' ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-rose-50 text-rose-700 border-rose-300"
                      )}
                    >
                      <option value="debit">مدين (Debit)</option>
                      <option value="credit">دائن (Credit)</option>
                    </select>
                  </div>

                  <div className="flex-1 min-w-[200px]">
                    <select
                      value={line.account_id}
                      onChange={e => updateLine(idx, 'account_id', e.target.value)}
                      required
                      className="w-full p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-xs text-slate-900 dark:text-white"
                    >
                      <option value="">اختر الحساب المحاسبي...</option>
                      {leafAccounts.map(acc => (
                        <option key={acc.id} value={acc.id}>
                          {acc.code} - {acc.name_ar}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="w-36">
                    <input
                      type="number"
                      step="0.01"
                      placeholder="المبلغ"
                      required
                      value={line.amount}
                      onChange={e => updateLine(idx, 'amount', e.target.value)}
                      className="w-full p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 outline-none font-black text-xs text-slate-900 dark:text-white font-mono"
                    />
                  </div>

                  <div className="flex-1 min-w-[160px]">
                    <input
                      type="text"
                      placeholder="شرح الطرف (اختياري)"
                      value={line.notes}
                      onChange={e => updateLine(idx, 'notes', e.target.value)}
                      className="w-full p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 outline-none font-bold text-xs text-slate-900 dark:text-white"
                    />
                  </div>

                  {entries.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      className="p-2.5 text-slate-400 hover:text-rose-600 rounded-xl transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="p-5 bg-slate-100 dark:bg-slate-800 rounded-2xl flex flex-wrap justify-between items-center gap-4 text-xs font-bold">
            <div className="flex gap-6">
              <div>إجمالي المدين: <span className="font-black text-emerald-600 font-mono text-sm">{totalDebit.toFixed(2)} ج.م</span></div>
              <div>إجمالي الدائن: <span className="font-black text-rose-600 font-mono text-sm">{totalCredit.toFixed(2)} ج.م</span></div>
            </div>
            <div className={cn("px-4 py-1.5 rounded-full font-black text-xs", isBalanced ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>
              {isBalanced ? '✓ القيد متزن' : `غير متزن (الفارق: ${diff.toFixed(2)} ج.م)`}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="px-6 py-3.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300 rounded-2xl font-bold text-sm transition-all">إلغاء</button>
            <button
              type="submit"
              disabled={loading || !isBalanced}
              className="px-8 py-3.5 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black text-sm transition-all shadow-lg shadow-blue-600/20 active:scale-95 disabled:opacity-50 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>{loading ? 'جاري الحفظ...' : 'حفظ القيد اليومي'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

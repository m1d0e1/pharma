'use client';
import { useHotkeys } from 'react-hotkeys-hook';


import { getShiftsAction, getCurrentShiftAction } from '@/app/actions-client/shifts';
import React, { useState, useEffect } from 'react';
import { 
  DollarSign, Landmark, Receipt, FileStack, AlertCircle, 
  CreditCard, TrendingUp, Wallet, ArrowRightLeft, PieChart,
  Plus, Search, Filter, Printer, X, Save, Activity, ArrowRight,
  Monitor, Settings, Database, Trash2, Edit, BarChart3, ShieldCheck,
  FileText, Download, CheckCircle, ChevronDown, ChevronLeft, FolderOpen
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { FinancialNoticeForm } from './FinancialComponents';
import TrialBalanceSettingsClient from './TrialBalanceSettingsClient';
import CashTransactionsClient from './CashTransactionsClient';
import ShiftManagementClient from '../shifts/ShiftManagementClient';
import { getExpensesAction } from '@/app/actions-client/expenses';
import { getClientSession } from '@/lib/auth/local';
import { getStaffAction } from '@/app/actions-client/users';
import { 
  createCashMovementAction, 
  getCashMovementsAction,
  getPointsOfSaleAction,
  getExpenseDefinitionsAction,
  getBanksAction,
  getPapersAction,
  getCardsAction,
  getAccountsAction,
  getJournalsAction,
  addAccountAction,
  getJournalDetailsAction,
  seedFinanceTestDataAction,
  getFinancialNoticesAction,
  getActivityLogsAction
} from '@/app/actions-client/finance';
import { format, isValid } from 'date-fns';
import { toast } from 'react-hot-toast';

const safeFormat = (dateStr: string | null | undefined, fmt: string) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return isValid(d) ? format(d, fmt) : '-';
};

const ACCOUNT_TABS = [
  // 1. Core Financials
  { group: 'المحاسبة العامة', items: [
    { id: 'chart_of_accounts', label: 'شجرة الحسابات', icon: Database, color: 'text-slate-600', bg: 'bg-slate-50' },
    { id: 'daily_journals', label: 'القيود اليومية', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
    { id: 'trial_balance_settings', label: 'إعدادات الميزان', icon: Settings, color: 'text-blue-600', bg: 'bg-blue-50' },
  ]},
  
  // 2. Cash Management
  { group: 'إدارة النقدية', items: [
    { id: 'treasury', label: 'الخزينة والتوريدات', icon: Wallet, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    { id: 'cash_movement', label: 'حركة النقدية', icon: ArrowRightLeft, color: 'text-blue-600', bg: 'bg-blue-50' },
    { id: 'pos_management', label: 'نقط البيع', icon: Monitor, color: 'text-purple-600', bg: 'bg-purple-50' },
  ]},

  // 3. Banks & Credit
  { group: 'البنوك والائتمان', items: [
    { id: 'banks', label: 'الحسابات البنكية', icon: Landmark, color: 'text-blue-600', bg: 'bg-blue-50' },
    { id: 'papers', label: 'الأوراق المالية', icon: FileStack, color: 'text-purple-600', bg: 'bg-purple-50' },
    { id: 'cards', label: 'البطاقات الائتمانية', icon: CreditCard, color: 'text-indigo-600', bg: 'bg-indigo-50' },
  ]},

  // 4. Expenses
  { group: 'المصروفات', items: [
    { id: 'expense_definitions', label: 'تعريف المصروفات', icon: Settings, color: 'text-amber-600', bg: 'bg-amber-50' },
    { id: 'expenses', label: 'المصاريف التشغيلية', icon: Receipt, color: 'text-rose-600', bg: 'bg-rose-50' },
  ]},

  // 5. Adjustments & Audit
  { group: 'التسويات والرقابة', items: [
    { id: 'notices', label: 'الإشعارات والتسويات', icon: AlertCircle, color: 'text-amber-600', bg: 'bg-amber-50' },
    { id: 'daily_reports', label: 'تقارير الوردية', icon: BarChart3, color: 'text-rose-600', bg: 'bg-rose-50' },
    { id: 'audit_logs', label: 'سجل الرقابة', icon: ShieldCheck, color: 'text-slate-600', bg: 'bg-slate-50' },
  ]},
];

export default function AccountsManagementClient({ initialTab = 'treasury' }: { initialTab?: string }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [showCashForm, setShowCashForm] = useState<{ show: boolean, type: 'disbursement' | 'receipt' }>({ show: false, type: 'disbursement' });
  const [movements, setMovements] = useState<any[]>([]);
  const [pointsOfSale, setPointsOfSale] = useState<any[]>([]);
  const [expenseDefinitions, setExpenseDefinitions] = useState<any[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [papers, setPapers] = useState<any[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [journals, setJournals] = useState<any[]>([]);
  const [shifts, setShifts] = useState<any[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [coaViewMode, setCoaViewMode] = useState<'table' | 'tree'>('tree');
  const [showAddAccount, setShowAddAccount] = useState<{ show: boolean, parentId: number | null }>({ show: false, parentId: null });
  const [selectedJournalId, setSelectedJournalId] = useState<string | null>(null);

  const [noticesList, setNoticesList] = useState<any[]>([]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [expensesList, setExpensesList] = useState<any[]>([]);
  
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [hasOpenShift, setHasOpenShift] = useState(false);
  const [staffList, setStaffList] = useState<any[]>([]);
  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
     setIsMounted(true);
     loadTabData();
  }, [activeTab]);

  const loadTabData = async () => {
     setLoadingData(true);
     try {
        if (activeTab === 'treasury') {
           const movementsRes = await getCashMovementsAction();
           if (movementsRes.success) setMovements(movementsRes.data as any[]);
           const accountsRes = await getAccountsAction();
           if (accountsRes.success) setAccounts(accountsRes.data as any[]);
           const posRes = await getPointsOfSaleAction();
           if (posRes.success) setPointsOfSale(posRes.data as any[]);
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
           const res = await getPapersAction();
           if (res.success) setPapers(res.data as any[]);
        } else if (activeTab === 'cards') {
           const res = await getCardsAction();
           if (res.success) setCards(res.data as any[]);
        } else if (activeTab === 'chart_of_accounts') {
           const res = await getAccountsAction();
           if (res.success) setAccounts(res.data as any[]);
        } else if (activeTab === 'daily_journals') {
           const res = await getJournalsAction();
           if (res.success) setJournals(res.data as any[]);
        } else if (activeTab === 'expenses') {
           const res = await getExpensesAction();
           if (res.success) setExpensesList(res.data as any[]);
        } else if (activeTab === 'notices') {
           const res = await getFinancialNoticesAction();
           if (res.success) setNoticesList(res.data as any[]);
        } else if (activeTab === 'audit_logs') {
           const res = await getActivityLogsAction();
           if (res.success) setActivityLogs(res.data as any[]);
        } else if (activeTab === 'daily_reports') {
           const res = await getShiftsAction({ status: 'all' });
           if (res.success) setShifts(res.data as any[]);
           
           const curShiftRes = await getCurrentShiftAction();
           if (curShiftRes.success) {
              setCurrentShift(curShiftRes.data || null);
              setHasOpenShift(!!curShiftRes.data);
           }

           const userObj = await getClientSession();
           if (userObj) {
              setUserRole(userObj.role);
              if (userObj.role === 'admin' || userObj.role === 'owner') {
                 const staffRes = await getStaffAction();
                 if (staffRes.success) {
                    setStaffList(staffRes.data || []);
                 }
              }
           }
        }
     } catch (error) {
        console.error('Load data error:', error);
     }
     setLoadingData(false);
  };

  const handleSeed = async () => {
     const res = await seedFinanceTestDataAction();
     if (res.success) {
        toast.success('Test data initialized successfully');
        loadTabData();
     } else {
        toast.error('Failed to initialize data');
     }
  };

  // Compute Treasury Stats Dynamically
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const treasuryAccount = accounts.find(a => a.code === '111');
  const treasuryBalance = treasuryAccount ? (treasuryAccount.balance || 0) : 0;
   
  const todayReceipts = movements
     .filter(m => m.type === 'receipt' && m.date === todayStr)
     .reduce((sum, m) => sum + m.amount, 0);

  const todayDisbursements = movements
     .filter(m => m.type === 'disbursement' && m.date === todayStr)
     .reduce((sum, m) => sum + m.amount, 0);

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
      'electricity': 'كهرباء ومياه',
      'operating_expenses': 'مصروفات تشغيلية',
      'personal': 'مسحوبات شخصية',
      'other': 'أخرى'
  };
  const largestCategoryLabel = categoryTranslations[largestCategory] || largestCategory;

  if (!isMounted) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8" dir="rtl">
       {/* Sidebar Navigation */}
       <div className="lg:col-span-3 space-y-4">
          <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 p-4 shadow-sm">
             <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-6 mb-4">قائمة الحسابات</p>
             <div className="space-y-6">
                {ACCOUNT_TABS.map((group) => (
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

          <button 
            onClick={handleSeed}
            className="w-full flex items-center justify-center gap-3 px-6 py-5 rounded-[24px] font-black bg-blue-50 dark:bg-blue-900/10 text-blue-600 dark:text-blue-400 border-2 border-dashed border-blue-200 dark:border-blue-800 hover:bg-blue-100 transition-all"
          >
             <Database className="w-5 h-5" /> Initialize Test Data
          </button>

          <div className="bg-gradient-to-br from-indigo-600 to-purple-700 rounded-[40px] p-8 text-white shadow-2xl">
             <TrendingUp className="w-12 h-12 mb-6 opacity-50" />
             <h4 className="text-xl font-black mb-2">إجمالي السيولة</h4>
             <p className="text-4xl font-black mb-1">
                {(pointsOfSale.reduce((sum, pos) => sum + pos.current_balance, 0) + 43222.2).toLocaleString('en-US')} 
                <span className="text-sm opacity-70"> ج.م</span>
             </p>
             <p className="text-sm font-bold opacity-60">محدث الآن من نقاط البيع</p>
          </div>
       </div>

       {/* Content Area */}
       <div className="lg:col-span-9 space-y-8">
          {activeTab === 'treasury' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black text-slate-800 dark:text-white">سجل توريدات النقدية</h2>
                      <p className="text-slate-500 font-bold">متابعة جميع المبالغ الداخلة والخارجة من الخزينة</p>
                   </div>
                   <div className="flex items-center gap-4">
                     <button onClick={() => window.print()} className="p-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-[24px] hover:bg-slate-200 transition-all no-print">
                       <Printer className="w-6 h-6" />
                     </button>
                     <button 
                       onClick={() => {
                          setActiveTab('cash_movement');
                          setShowCashForm({ show: true, type: 'receipt' });
                       }}
                       className="px-10 py-5 bg-emerald-600 text-white rounded-[24px] font-black hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-3"
                     >
                        <Plus className="w-6 h-6" /> إضافة توريد جديد
                     </button>
                   </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                   <StatCard label="رصيد الخزينة" value={treasuryBalance.toLocaleString('en-US')} color="emerald" icon={Wallet} />
                   <StatCard label="توريدات اليوم" value={`+${todayReceipts.toLocaleString('en-US')}`} color="blue" icon={ArrowRightLeft} />
                   <StatCard label="المصروفات اليومية" value={`-${todayDisbursements.toLocaleString('en-US')}`} color="rose" icon={Receipt} />
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                   <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                      <div className="relative w-96">
                         <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                         <input type="text" placeholder="بحث في السجل..." className="w-full pr-14 pl-6 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none font-bold" />
                      </div>
                   </div>
                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr>
                            <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">التاريخ</th>
                            <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">البيان</th>
                            <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">المبلغ</th>
                            <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">الحساب المتأثر</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                         ) : movements.length === 0 ? (
                            <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic font-bold">لا توجد حركات نقدية مسجلة اليوم</td></tr>
                         ) : movements.slice(0, 15).map(m => (
                            <tr key={`treasury-mov-${m.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer">
                               <td className="px-8 py-5 font-bold text-slate-500">{safeFormat(m.created_at || m.date, 'yyyy/MM/dd HH:mm')}</td>
                               <td className="px-8 py-5 font-black text-slate-800 dark:text-white">{m.notes || (m.type === 'receipt' ? 'توريد نقدية' : 'صرف نقدية')}</td>
                               <td className={cn("px-8 py-5 font-black", m.type === 'receipt' ? "text-emerald-600" : "text-rose-600")}>
                                  {m.type === 'receipt' ? `+${m.amount.toLocaleString()}` : `-${m.amount.toLocaleString()}`} ج.م
                               </td>
                               <td className="px-8 py-5">
                                  <span className="bg-blue-50 text-blue-600 px-4 py-1.5 rounded-full text-xs font-black">
                                     {m.source_type === 'pos' ? 'نقطة البيع' : m.source_type === 'main_safe' ? 'خزينة المحل' : m.source_type === 'admin' ? 'خزينة الإدارة' : m.source_type || 'الخزينة'}
                                  </span>
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
                       onClick={() => toast.success('قريباً: إضافة نقطة بيع جديدة')}
                       className="px-10 py-5 bg-purple-600 text-white rounded-[24px] font-black hover:bg-purple-700 transition-all shadow-xl shadow-purple-500/20 flex items-center gap-3"
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
                            <th className="px-8 py-6">إجراءات</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={6} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                         ) : pointsOfSale.length === 0 ? (
                            <tr><td colSpan={6} className="py-20 text-center text-slate-400 italic font-bold">لا توجد نقاط بيع مسجلة. اضغط "تهيئة" لإضافة بيانات تجريبية.</td></tr>
                         ) : pointsOfSale.map(pos => (
                            <tr key={`pos-${pos.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                               <td className="px-8 py-6 font-mono font-black text-blue-600">{pos.id}</td>
                               <td className="px-8 py-6 font-black">{pos.name_ar}</td>
                               <td className="px-8 py-6 font-bold text-slate-400 italic">{pos.name_en}</td>
                               <td className="px-8 py-6 font-black text-lg text-emerald-600">{pos.current_balance?.toLocaleString('en-US') ?? '0'} ج.م</td>
                               <td className="px-8 py-6 text-center">
                                  <div className="flex flex-col items-center">
                                     <span className="font-bold text-slate-700 dark:text-slate-300">{pos.location}</span>
                                     <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{pos.computer_name}</span>
                                  </div>
                               </td>
                               <td className="px-8 py-6">
                                  <div className="flex gap-2">
                                     <button 
                                       onClick={() => toast('جاري فتح بيانات نقطة البيع للتعديل')}
                                       className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-blue-600 transition-all"
                                     >
                                        <Edit className="w-4 h-4" />
                                     </button>
                                     <button 
                                       onClick={() => toast.error('لا يمكن حذف نقطة البيع الأساسية')}
                                       className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-rose-600 transition-all"
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
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black">تعريف المصروفات</h2>
                      <p className="text-slate-500 font-bold">تكويد وتصنيف أنواع المصاريف المختلفة</p>
                   </div>
                   <button 
                     onClick={() => toast.success('قريباً: إضافة تصنيف مصروفات جديد')}
                     className="px-10 py-5 bg-amber-600 text-white rounded-[24px] font-black hover:bg-amber-700 transition-all shadow-xl shadow-amber-500/20 flex items-center gap-3"
                   >
                      <Plus className="w-6 h-6" /> إضافة نوع مصروف
                   </button>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                            <th className="px-8 py-6">الكود</th>
                            <th className="px-8 py-6">الإسم (ع)</th>
                            <th className="px-8 py-6">الإسم (En)</th>
                            <th className="px-8 py-6">تاريخ الإنشاء</th>
                            <th className="px-8 py-6">إجراءات</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                         ) : expenseDefinitions.length === 0 ? (
                            <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">لا توجد تعريفات مسجلة. اضغط "تهيئة" لإضافة بيانات تجريبية.</td></tr>
                         ) : expenseDefinitions.map(exp => (
                            <tr key={`exp-${exp.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors group">
                               <td className="px-8 py-6 font-mono font-black text-amber-600">{exp.code}</td>
                               <td className="px-8 py-6 font-black text-slate-800 dark:text-white group-hover:text-amber-600 transition-colors">{exp.name_ar}</td>
                               <td className="px-8 py-6 font-bold text-slate-400 italic">{exp.name_en}</td>
                               <td className="px-8 py-6 font-bold text-slate-400">{safeFormat(exp.created_at, 'yyyy/MM/dd')}</td>
                               <td className="px-8 py-6">
                                  <div className="flex gap-2">
                                     <button 
                                       onClick={() => toast('جاري تعديل تعريف المصروف')}
                                       className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-blue-600 transition-all"
                                     >
                                        <Edit className="w-4 h-4" />
                                     </button>
                                     <button 
                                       onClick={() => toast.error('لا يمكن حذف تعريفات المصروفات الأساسية')}
                                       className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-rose-600 transition-all"
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

          {activeTab === 'notices' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <FinancialNoticeForm targetType="customer" onSuccess={loadTabData} />
                
                <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                   <div className="p-8 border-b border-slate-100 dark:border-slate-800">
                      <h4 className="text-xl font-black">سجل الإشعارات والتسويات الأخيرة</h4>
                   </div>
                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                            <th className="px-8 py-6">التاريخ</th>
                            <th className="px-8 py-6">النوع</th>
                            <th className="px-8 py-6">الجهة</th>
                            <th className="px-8 py-6">القيمة</th>
                            <th className="px-8 py-6">السبب</th>
                            <th className="px-8 py-6">بواسطة</th>
                            <th className="px-8 py-6">ملاحظات</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={7} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</td></tr>
                         ) : noticesList.length === 0 ? (
                            <tr><td colSpan={7} className="py-20 text-center text-slate-400 italic font-bold">لا توجد إشعارات مسجلة</td></tr>
                         ) : noticesList.map(n => (
                            <tr key={`notice-${n.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                               <td className="px-8 py-6 font-bold text-slate-500">{safeFormat(n.date || n.created_at, 'yyyy/MM/dd')}</td>
                               <td className="px-8 py-6">
                                  <span className={cn(
                                     "px-3 py-1 rounded-lg text-xs font-black",
                                     n.type === 'credit' ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"
                                  )}>
                                     {n.type === 'credit' ? 'خصم (Credit)' : 'إضافة (Debit)'}
                                  </span>
                               </td>
                               <td className="px-8 py-6 font-black">
                                  {n.target_type === 'customer' ? 'عميل' : n.target_type === 'supplier' ? 'مورد' : 'صيدلية'}
                               </td>
                               <td className={cn("px-8 py-6 font-black text-lg", n.type === 'credit' ? "text-rose-600" : "text-emerald-600")}>
                                  {n.amount.toLocaleString()} ج.م
                               </td>
                               <td className="px-8 py-6 font-black text-slate-700 dark:text-slate-300">{n.reason}</td>
                               <td className="px-8 py-6 font-bold text-slate-600">{n.user_name || 'غير معروف'}</td>
                               <td className="px-8 py-6 font-bold text-slate-500">{n.notes || '-'}</td>
                            </tr>
                         ))}
                      </tbody>
                   </table>
                </div>
             </div>
          )}

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
                       onClick={() => toast.success('قريباً: إضافة حساب بنكي جديد')}
                       className="px-10 py-5 bg-blue-600 text-white rounded-[24px] font-black hover:bg-blue-700 transition-all shadow-xl shadow-blue-500/20 flex items-center gap-3"
                     >
                        <Plus className="w-6 h-6" /> إضافة حساب بنكي
                     </button>
                   </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                   {loadingData ? (
                      <div className="col-span-2 py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات البنكية...</div>
                   ) : banks.length === 0 ? (
                      <div className="col-span-2 py-20 text-center text-slate-400 italic font-bold">لا توجد حسابات مسجلة</div>
                   ) : banks.map((bank: any) => (
                      <div key={`bank-${bank.id}`} className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm hover:border-blue-500 transition-all group">
                         <div className="flex justify-between items-start mb-6">
                            <div className="w-16 h-16 bg-blue-50 dark:bg-blue-900/20 rounded-[24px] flex items-center justify-center text-blue-600 group-hover:scale-110 transition-transform">
                               <Landmark className="w-8 h-8" />
                            </div>
                            <div className="text-left">
                               <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">الرصيد الحالي</p>
                               <p className="text-3xl font-black text-slate-900 dark:text-white">{bank.current_balance?.toLocaleString('en-US') ?? '0'} <span className="text-sm">ج.م</span></p>
                            </div>
                         </div>
                         <h4 className="text-xl font-black text-slate-800 dark:text-white mb-1">{bank.name_ar}</h4>
                         <p className="text-slate-400 font-bold mb-4 italic">{bank.name_en}</p>
                         <div className="pt-6 border-t border-slate-50 dark:border-slate-800 flex justify-between items-center">
                            <span className="text-xs font-black text-slate-500 uppercase tracking-widest">رقم الحساب: {bank.account_number}</span>
                            <button className="text-blue-600 font-black text-xs hover:underline">عرض الحركات</button>
                         </div>
                      </div>
                   ))}
                </div>
             </div>
          )}

          {activeTab === 'papers' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black text-slate-800 dark:text-white">الأوراق المالية (شيكات / كمبيالات)</h2>
                      <p className="text-slate-500 font-bold">متابعة استحقاقات الشيكات الصادرة والواردة</p>
                   </div>
                   <div className="flex gap-4">
                      <button 
                        onClick={() => toast.success('قريباً: إضافة شيك صادر')}
                        className="px-8 py-4 bg-purple-600 text-white rounded-2xl font-black hover:bg-purple-700 transition-all flex items-center gap-2"
                      >
                         <Plus className="w-5 h-5" /> شيك صادر
                      </button>
                      <button 
                        onClick={() => toast.success('قريباً: إضافة شيك وارد')}
                        className="px-8 py-4 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all flex items-center gap-2"
                      >
                         <Plus className="w-5 h-5" /> شيك وارد
                      </button>
                   </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                            <th className="px-8 py-6">رقم الورقة</th>
                            <th className="px-8 py-6">النوع</th>
                            <th className="px-8 py-6">الجهة / الساحب</th>
                            <th className="px-8 py-6">تاريخ الاستحقاق</th>
                            <th className="px-8 py-6 text-center">المبلغ</th>
                            <th className="px-8 py-6">الحالة</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={6} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل الأوراق المالية...</td></tr>
                         ) : papers.length === 0 ? (
                            <tr><td colSpan={6} className="py-20 text-center text-slate-400 italic font-bold">لا توجد أوراق مالية مسجلة</td></tr>
                         ) : papers.map((p: any) => (
                            <tr key={`paper-${p.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors group">
                               <td className="px-8 py-6 font-mono font-black text-slate-800 dark:text-white">{p.paper_number}</td>
                               <td className="px-8 py-6 font-bold">
                                  <span className={cn("px-4 py-1.5 rounded-full text-xs font-black", p.direction === 'in' ? "bg-indigo-50 text-indigo-600" : "bg-purple-50 text-purple-600")}>
                                     {p.type === 'check' ? 'شيك' : 'كمبيالة'} {p.direction === 'in' ? 'وارد' : 'صادر'}
                                  </span>
                                </td>
                               <td className="px-8 py-6 font-black">{p.target_name}</td>
                               <td className="px-8 py-6 font-bold text-rose-500">{safeFormat(p.due_date, 'yyyy/MM/dd')}</td>
                               <td className="px-8 py-6 text-center font-black text-lg">{p.amount.toLocaleString('en-US')} ج.م</td>
                               <td className="px-8 py-6">
                                  <span className="bg-amber-100 text-amber-600 px-4 py-1 rounded-full text-[10px] font-black uppercase">{p.status === 'pending' ? 'انتظار' : p.status}</span>
                               </td>
                            </tr>
                         ))}
                      </tbody>
                   </table>
                </div>
             </div>
          )}

          {activeTab === 'cards' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black text-slate-800 dark:text-white">ماكينات وبطاقات الائتمان</h2>
                      <p className="text-slate-500 font-bold">إدارة عُهد نقاط التحصيل الإلكتروني</p>
                   </div>
                   <button 
                     onClick={() => toast.success('قريباً: إضافة ماكينة دفع أو بطاقة')}
                     className="px-10 py-5 bg-indigo-600 text-white rounded-[24px] font-black hover:bg-indigo-700 transition-all flex items-center gap-3"
                   >
                      <Plus className="w-6 h-6" /> إضافة ماكينة / كارت
                   </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                   {loadingData ? (
                      <div className="col-span-3 py-20 text-center text-slate-400 italic font-bold">جاري تحميل البيانات...</div>
                   ) : cards.length === 0 ? (
                      <div className="col-span-3 py-20 text-center text-slate-400 italic font-bold">لا توجد ماكينات مسجلة</div>
                   ) : cards.map((c: any) => (
                      <div key={`card-${c.id}`} className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden group">
                         <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-500/5 rounded-full group-hover:scale-150 transition-transform" />
                         <CreditCard className="w-10 h-10 text-indigo-600 mb-6" />
                         <h4 className="text-lg font-black mb-1">{c.name_ar}</h4>
                         <p className="text-xs font-bold text-slate-400 uppercase mb-6">{c.name_en}</p>
                         <div className="flex justify-between items-end">
                            <div>
                               <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">الرصيد الحالي</p>
                               <p className="text-2xl font-black text-indigo-600">{c.current_balance?.toLocaleString('en-US') ?? '0'} ج.م</p>
                            </div>
                            <div className="text-left">
                               <p className="text-[10px] font-black text-rose-500 uppercase tracking-widest">العمولة</p>
                               <p className="font-black text-rose-500">{c.commission_pct}%</p>
                            </div>
                         </div>
                      </div>
                   ))}
                </div>
             </div>
          )}

          {activeTab === 'expenses' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h2 className="text-2xl font-black text-slate-800 dark:text-white">المصاريف التشغيلية</h2>
                      <p className="text-slate-500 font-bold">سجل المصروفات الفعلي وتحليل التكاليف</p>
                   </div>
                   <button 
                     onClick={() => {
                        setActiveTab('cash_movement');
                        setShowCashForm({ show: true, type: 'disbursement' });
                     }}
                     className="px-10 py-5 bg-rose-600 text-white rounded-[24px] font-black hover:bg-rose-700 transition-all shadow-xl shadow-rose-500/20 flex items-center gap-3"
                   >
                      <Plus className="w-6 h-6" /> إضافة مصروف (F4)
                   </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                   <div className="p-8 bg-rose-50 dark:bg-rose-900/10 rounded-[40px] border border-rose-100 dark:border-rose-900/20">
                      <p className="text-xs font-black text-rose-600 uppercase tracking-widest mb-2">إجمالي الشهر</p>
                      <p className="text-4xl font-black text-rose-700">{totalMonthExpenses.toLocaleString()} <span className="text-sm">ج.م</span></p>
                   </div>
                   <div className="p-8 bg-blue-50 dark:bg-blue-900/10 rounded-[40px] border border-blue-100 dark:border-blue-900/20">
                      <p className="text-xs font-black text-blue-600 uppercase tracking-widest mb-2">أكبر تصنيف</p>
                      <p className="text-2xl font-black text-blue-700">{largestCategoryLabel}</p>
                   </div>
                   <div className="p-8 bg-amber-50 dark:bg-amber-900/10 rounded-[40px] border border-amber-100 dark:border-amber-900/20">
                      <p className="text-xs font-black text-amber-600 uppercase tracking-widest mb-2">عدد العمليات</p>
                      <p className="text-4xl font-black text-amber-700">{expensesList.length} <span className="text-sm">عملية</span></p>
                   </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                            <th className="px-8 py-6">التاريخ</th>
                            <th className="px-8 py-6">التصنيف</th>
                            <th className="px-8 py-6">القيمة</th>
                            <th className="px-8 py-6">بواسطة</th>
                            <th className="px-8 py-6">ملاحظات</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {loadingData ? (
                            <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل المصروفات...</td></tr>
                         ) : expensesList.length === 0 ? (
                            <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">لا توجد مصروفات مسجلة</td></tr>
                         ) : expensesList.map(exp => (
                            <tr key={`exp-list-${exp.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                               <td className="px-8 py-6 font-bold text-slate-500">{safeFormat(exp.date, 'yyyy/MM/dd')}</td>
                               <td className="px-8 py-6 font-black text-slate-800 dark:text-white">
                                  <span className="bg-rose-50 text-rose-600 px-4 py-1.5 rounded-full text-xs font-black">
                                     {categoryTranslations[exp.category] || exp.category}
                                  </span>
                               </td>
                               <td className="px-8 py-6 font-black text-lg text-rose-600">{exp.amount.toLocaleString()} ج.م</td>
                               <td className="px-8 py-6 font-bold text-slate-700 dark:text-slate-300">{exp.user_name || 'غير معروف'}</td>
                               <td className="px-8 py-6 font-bold text-slate-500">{exp.notes || '-'}</td>
                            </tr>
                         ))}
                      </tbody>
                   </table>
                </div>
             </div>
          )}

           {activeTab === 'daily_reports' && (
              <div className="space-y-8 animate-in fade-in slide-in-from-left-4">
                 <ShiftManagementClient 
                    initialShifts={shifts}
                    currentShift={currentShift}
                    hasOpenShift={hasOpenShift}
                    userRole={userRole}
                    staffList={staffList}
                 />
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
                      <button 
                        onClick={() => toast('جاري البحث في سجل الرقابة...')}
                        className="p-5 bg-slate-50 dark:bg-slate-800 text-slate-500 rounded-2xl border border-slate-100 dark:border-slate-700 hover:bg-slate-100 transition-all"
                      >
                         <Search className="w-6 h-6" />
                      </button>
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
                         ) : activityLogs.length === 0 ? (
                            <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic font-bold">السجل فارغ حالياً</td></tr>
                         ) : activityLogs.map(log => (
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
                                           onClick={() => toast('جاري فتح بيانات الحساب للتعديل')}
                                           className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-blue-600 transition-all"
                                         >
                                            <Edit className="w-4 h-4" />
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
                       onClick={() => toast.success('قريباً: شاشة تسجيل القيود اليومية')}
                       className="px-10 py-5 bg-blue-600 text-white rounded-[24px] font-black hover:bg-blue-700 transition-all shadow-xl shadow-blue-500/20 flex items-center gap-3"
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
                                   <div className="flex gap-2">
                                      <button className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-blue-600 transition-all"><Printer className="w-4 h-4" /></button>
                                      <button className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:text-blue-600 transition-all"><ArrowRight className="w-4 h-4" /></button>
                                   </div>
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

       <JournalDetailsModal 
          journalId={selectedJournalId}
          onClose={() => setSelectedJournalId(null)}
       />
    </div>
  );
}


function StatCard({ label, value, color, icon: Icon }: any) {
  const colorMap = {
    emerald: 'text-emerald-600 bg-emerald-50 border-emerald-100 dark:bg-emerald-900/10 dark:border-emerald-900/20',
    blue: 'text-blue-600 bg-blue-50 border-blue-100 dark:bg-blue-900/10 dark:border-blue-900/20',
    rose: 'text-rose-600 bg-rose-50 border-rose-100 dark:bg-rose-900/10 dark:border-rose-900/20'
  };

  return (
    <div className={cn("p-8 rounded-[40px] border transition-all hover:scale-105 hover:shadow-xl", (colorMap as any)[color])}>
       <div className="flex justify-between items-center mb-6">
          <div className="w-14 h-14 bg-white dark:bg-slate-900 rounded-2xl flex items-center justify-center shadow-sm">
             <Icon className="w-8 h-8" />
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest opacity-60">تقرير مباشر</span>
       </div>
       <p className="text-sm font-black opacity-70 mb-2">{label}</p>
       <p className="text-4xl font-black">{value} <span className="text-sm">ج.م</span></p>
    </div>
  );
}

function buildAccountTree(accounts: any[]) {
   const map = new Map();
   accounts.forEach(acc => map.set(acc.id, { ...acc, children: [] }));
   const roots: any[] = [];
   accounts.sort((a, b) => a.code.localeCompare(b.code)).forEach(acc => {
      if (acc.parent_id && map.has(acc.parent_id)) {
         map.get(acc.parent_id).children.push(map.get(acc.id));
      } else {
         roots.push(map.get(acc.id));
      }
   });
   return roots;
}

function AccountTreeNode({ node, onAddSub, level = 0 }: { node: any, onAddSub: (id: number) => void, level?: number }) {
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
               {node.is_group && (
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
               )}
               <button 
                 onClick={(e) => { e.stopPropagation(); toast('جاري تعديل الحساب'); }}
                 className="p-2.5 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-xl hover:bg-slate-900 dark:hover:bg-white dark:hover:text-slate-900 transition-all shadow-sm"
               >
                 <Edit className="w-4 h-4" />
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
                    level={level + 1} 
                  />
               ))}
            </div>
         )}
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
                     <p className="font-black text-blue-700">هذا الحساب هو "حساب رئيسي" (Group)</p>
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

'use client';
import TableScrollContainer from '@/components/ui/TableScrollContainer';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { 
  Search, Filter, Calendar, User, ShoppingBag, 
  ChevronDown, FileText, Download, Printer, 
  ArrowRight, CreditCard, DollarSign, Wallet, BarChart3, ReceiptText, Scale
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getSalesReportsAction, getInvoiceDetailsAction } from '@/app/actions-client/sales-reports';
import { getStaffAction } from '@/app/actions-client/users';
import { getPatientsAction } from '@/app/actions-client/patients';
import { format } from 'date-fns';
import dynamic from 'next/dynamic';
import { toast } from 'react-hot-toast';
import { hasUserPermissionSync } from '@/lib/auth/local';
import { useHotkeys } from 'react-hotkeys-hook';

const ReceiptDetailsModal = dynamic(() => import('@/components/receipts/ReceiptDetailsModal'), { ssr: false });

const paymentMethodLabels: Record<string, string> = {
  cash: 'نقدي',
  visa: 'فيزا',
  credit: 'آجل',
  wallet: 'محفظة',
  check: 'شيك',
  delivery: 'توصيل',
};

const paymentMethodLabel = (method?: string) => paymentMethodLabels[String(method || '').toLowerCase()] || method || 'غير محدد';

const quoteCsvName = (value: unknown, fallback: string) => {
  const name = String(value || fallback);
  // Spreadsheet programs can evaluate quoted CSV cells that start with =, +, - or @.
  const literal = /^[=+@-]/.test(name.trimStart()) ? `'${name}` : name;
  return `"${literal.replace(/"/g, '""')}"`;
};

export default function SalesReportsClient({ userRole, user }: { userRole?: string; user?: any }) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // A prior successful result must not remain printable after a fresh read is
  // denied (including logout, staff revocation or tenant switch).
  const [reportReady, setReportReady] = useState(false);
  const [reportError, setReportError] = useState('');
  const [returnVerification, setReturnVerification] = useState<boolean | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<any[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const [staff, setStaff] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const searchRequestRef = useRef(0);
  const invoiceDetailsRequestRef = useRef(0);
  const metadataRequestRef = useRef(0);
  const actorKey = [String(user?.id || ''), String(user?.pharmacy_id || ''),
    String(user?.role || userRole || ''), JSON.stringify(user?.permissions || {})].join('|');
  const actorKeyRef = useRef(actorKey);
  const [authorizedActorKey, setAuthorizedActorKey] = useState(actorKey);
  // This render may belong to a different session/tenant than the rows last
  // authorized. Gate output even before the cleanup effect has committed.
  const verifiedReportReady = reportReady && authorizedActorKey === actorKey;

  const [filters, setFilters] = useState({
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    userId: 'all',
    patientId: 'all',
    paymentMethod: 'all',
    invoiceNumber: '',
  });

  // A filter edit changes the meaning of the report immediately. Keep neither
  // old invoice rows nor a pending read eligible for receipt/print/CSV export.
  const changeFilter = (key: keyof typeof filters, value: string) => {
    searchRequestRef.current += 1;
    invoiceDetailsRequestRef.current += 1;
    setReportReady(false);
    setReportError('');
    setReturnVerification(null);
    setInvoices([]);
    setLoading(false);
    setSelectedInvoice(null);
    setInvoiceItems([]);
    setLoadingItems(false);
    setFilters(current => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    if (actorKeyRef.current === actorKey) return;
    actorKeyRef.current = actorKey;
    setAuthorizedActorKey(actorKey);
    searchRequestRef.current += 1;
    invoiceDetailsRequestRef.current += 1;
    metadataRequestRef.current += 1;
    setReportReady(false);
    setReportError('');
    setReturnVerification(null);
    setInvoices([]);
    setSelectedInvoice(null);
    setInvoiceItems([]);
    setLoading(false);
    setLoadingItems(false);
    setStaff([]);
    setPatients([]);
  }, [actorKey]);

  useEffect(() => {
    async function loadData() {
      const metadataRequestId = ++metadataRequestRef.current;
      const [staffResult, patientResult] = await Promise.allSettled([
        getStaffAction(),
        getPatientsAction({ reportScope: true }),
      ]);
      if (metadataRequestId !== metadataRequestRef.current) return;
      let metadataFailed = false;

      if (staffResult.status === 'fulfilled' && staffResult.value.success) {
        setStaff(staffResult.value.data || []);
      } else {
        metadataFailed = true;
      }
      if (patientResult.status === 'fulfilled' && patientResult.value.success) {
        setPatients(patientResult.value.data || []);
      } else {
        metadataFailed = true;
      }
      if (metadataFailed) toast.error('تعذر تحميل بعض فلاتر تقرير المبيعات');

      await handleSearch();
    }
    void loadData();
    return () => { metadataRequestRef.current += 1; };
    // Initial load uses the default filters; edited filters run only when Search is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async () => {
    const requestId = ++searchRequestRef.current;
    setLoading(true);
    setReportReady(false);
    setReportError('');
    setReturnVerification(null);
    setInvoices([]);
    invoiceDetailsRequestRef.current += 1;
    setSelectedInvoice(null);
    setInvoiceItems([]);
    setLoadingItems(false);
    try {
      const res = await getSalesReportsAction({
        ...filters,
        userId: filters.userId === 'all' ? undefined : filters.userId,
        patientId: filters.patientId === 'all' ? undefined : filters.patientId,
      });
      if (requestId !== searchRequestRef.current) return;
      if (res.success) {
        const nextInvoices = res.data || [];
        setInvoices(nextInvoices);
        setReturnVerification('returnsVerified' in res ? res.returnsVerified : null);
        setReportReady(true);
      } else {
        setReportError(res.error || 'فشل تحميل تقرير المبيعات');
        toast.error(res.error || 'فشل تحميل تقرير المبيعات');
      }
    } catch (err) {
      if (requestId !== searchRequestRef.current) return;
      console.error('Sales report search error:', err);
      setReportError('فشل تحميل تقرير المبيعات');
      toast.error('فشل تحميل تقرير المبيعات');
    } finally {
      if (requestId === searchRequestRef.current) setLoading(false);
    }
  };

  useHotkeys('f', (event) => {
    event.preventDefault();
    void handleSearch();
  }, { enableOnFormTags: false }, [filters, selectedInvoice]);

  const handleInvoiceClick = async (invoiceId: string) => {
    const requestId = ++invoiceDetailsRequestRef.current;
    setSelectedInvoice(invoiceId);
    setInvoiceItems([]);
    setLoadingItems(true);
    try {
      const res = await getInvoiceDetailsAction(invoiceId);
      if (requestId !== invoiceDetailsRequestRef.current) return;
      if (res.success) setInvoiceItems(res.data || []);
      else {
        toast.error(res.error || 'فشل تحميل تفاصيل الفاتورة');
        setSelectedInvoice(null);
      }
    } catch (err) {
      if (requestId !== invoiceDetailsRequestRef.current) return;
      console.error('Sales report invoice details error:', err);
      toast.error('فشل تحميل تفاصيل الفاتورة');
      setSelectedInvoice(null);
    } finally {
      if (requestId === invoiceDetailsRequestRef.current) setLoadingItems(false);
    }
  };

  // sales_invoices.total_amount is persisted as the final/net invoice amount.
  // Reconstruct the pre-discount display value instead of subtracting discount twice.
  const totalGrossAmount = invoices.reduce(
    (sum, inv) => sum + Number(inv.total_amount || 0) + Number(inv.discount_amount || 0),
    0,
  );
  const totalDiscountAmount = invoices.reduce((sum, inv) => sum + Number(inv.discount_amount || 0), 0);
  const totalNetAmount = invoices.reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  // Invoice totals are immutable sale receipts; approved returns reduce the
  // revenue KPI without rewriting the historic invoice amounts or CSV export.
  // The native action explicitly says whether it completed the exhaustive
  // immutable-return ledger. Older non-native projections have no such flag.
  const returnsVerified = returnVerification ?? (invoices.length > 0 && invoices.every(inv =>
    typeof inv.refunded_amount === 'number' && Number.isFinite(inv.refunded_amount)));
  const totalApprovedReturns = invoices.reduce((sum, inv) => sum + Number(inv.refunded_amount || 0), 0);
  const netSalesAfterReturns = totalNetAmount - totalApprovedReturns;
  const cashSalesTotal = invoices
    .filter(i => i.payment_method === 'cash')
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const visaSalesTotal = invoices
    .filter(i => i.payment_method === 'visa')
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const creditSalesTotal = invoices
    .filter(i => i.payment_method === 'credit')
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const walletSalesTotal = invoices
    .filter(i => i.payment_method === 'wallet')
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const otherSalesTotal = invoices
    .filter(i => !['cash', 'visa', 'credit', 'wallet'].includes(String(i.payment_method || '').toLowerCase()))
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const reportUser = user || (userRole ? { role: userRole } : null);

  return (
    <div className="space-y-6 pb-16" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-center mb-5">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 dark:text-white">تقرير فواتير المبيعات</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">عرض وتحليل تفصيلي لعمليات البيع والمرتجعات</p>
          </div>
          <div className="flex gap-2">
            <button 
              type="button"
              onClick={() => window.print()}
              disabled={loading || !verifiedReportReady}
              aria-label="طباعة تقرير المبيعات"
              title="طباعة تقرير المبيعات"
              className="inline-flex h-11 w-11 items-center justify-center bg-slate-50 dark:bg-slate-800 text-slate-600 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Printer className="w-5 h-5" />
            </button>
            <button 
              type="button"
              aria-label="تصدير تقرير المبيعات إلى CSV"
              title="تصدير تقرير المبيعات إلى CSV"
              disabled={loading || !verifiedReportReady}
              onClick={() => {
                const headers = ['رقم الفاتورة', 'طريقة الدفع', 'تاريخ الفاتورة (نطاق الفلترة)', 'العميل', 'الموظف', 'قيمة الفاتورة', 'الخصم', 'قيمة الفاتورة بعد الخصم (قبل المرتجعات)', 'الحالة', 'مرتجعات الفاتورة المعتمدة حتى الآن (قد تكون بعد الفترة)', 'صافي الفاتورة بعد المرتجعات حتى الآن'];
                const rows = invoices.map(inv => [
                  `#${inv.id.slice(0, 8)}`,
                  paymentMethodLabel(inv.payment_method),
                  format(new Date(inv.created_at), 'yyyy/MM/dd HH:mm'),
                  quoteCsvName(inv.patient_name, '-'),
                  quoteCsvName(inv.staff_name, 'غير محدد'),
                  Number(inv.total_amount || 0) + Number(inv.discount_amount || 0),
                  inv.discount_amount || 0,
                  inv.total_amount,
                  inv.status || 'منتهية',
                  returnsVerified ? inv.refunded_amount : 'غير متاح',
                  returnsVerified ? Number(inv.total_amount) - Number(inv.refunded_amount) : 'غير متاح',
                ]);
                const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.setAttribute('href', url);
                link.setAttribute('download', `sales-report-${format(new Date(), 'yyyy-MM-dd')}.csv`);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
              }}
              className="inline-flex h-11 w-11 items-center justify-center bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 rounded-lg border border-blue-100 dark:border-blue-900/50 hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="w-5 h-5" />
            </button>
          </div>
        </div>
        {reportError && <p role="alert" className="mb-4 text-sm font-semibold text-rose-600">{reportError}</p>}

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 sm:p-5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200 dark:border-slate-700">
          <div className="space-y-2">
            <label htmlFor="sales-report-start-date" className="text-xs font-black text-slate-500 mr-2">من تاريخ</label>
            <div className="relative">
              <Calendar className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input 
                id="sales-report-start-date"
                type="date" 
                className="w-full pr-12 pl-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none focus:border-blue-500"
                value={filters.startDate}
                onChange={(e) => changeFilter('startDate', e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="sales-report-end-date" className="text-xs font-black text-slate-500 mr-2">إلى تاريخ</label>
            <div className="relative">
              <Calendar className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input 
                id="sales-report-end-date"
                type="date" 
                className="w-full pr-12 pl-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none focus:border-blue-500"
                value={filters.endDate}
                onChange={(e) => changeFilter('endDate', e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="sales-report-staff" className="text-xs font-black text-slate-500 mr-2">الموظف / الصيدلي</label>
            <select 
              id="sales-report-staff"
              className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none"
              value={filters.userId}
              onChange={(e) => changeFilter('userId', e.target.value)}
            >
              <option value="all">كل الموظفين</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor="sales-report-payment" className="text-xs font-black text-slate-500 mr-2">طريقة الدفع</label>
            <select 
              id="sales-report-payment"
              className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none"
              value={filters.paymentMethod}
              onChange={(e) => changeFilter('paymentMethod', e.target.value)}
            >
              <option value="all">الكل</option>
              <option value="cash">نقدي</option>
              <option value="credit">آجل / عملاء</option>
              <option value="visa">فيزا / شبكة</option>
              <option value="wallet">محفظة</option>
              <option value="check">شيك</option>
              <option value="delivery">توصيل</option>
            </select>
          </div>
          <div className="md:col-span-2 space-y-2">
            <label htmlFor="sales-report-patient" className="text-xs font-black text-slate-500 mr-2">العميل</label>
            <select 
              id="sales-report-patient"
              className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none"
              value={filters.patientId}
              onChange={(e) => changeFilter('patientId', e.target.value)}
            >
              <option value="all">كل العملاء</option>
              {patients.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor="sales-report-invoice" className="text-xs font-black text-slate-500 mr-2">رقم الفاتورة</label>
            <input 
              id="sales-report-invoice"
              type="text" 
              placeholder="ابحث برقم الفاتورة..."
              className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none"
              value={filters.invoiceNumber}
              onChange={(e) => changeFilter('invoiceNumber', e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <button 
              type="button"
              onClick={handleSearch}
              className="w-full py-2.5 bg-slate-900 text-white rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-slate-800 transition-colors shadow-sm"
            >
              <Search className="w-5 h-5" /> بحث (F)
            </button>
          </div>
        </div>
      </div>

      {/* Reports Unified Navigation Tab Bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-6 text-sm">
        {hasUserPermissionSync(reportUser, 'rep_can_view_sales') && (
          <Link 
            href="/reports" 
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <BarChart3 className="w-4 h-4" aria-hidden="true" /> التحليلات والمخططات
          </Link>
        )}
        {hasUserPermissionSync(reportUser, 'rep_can_view_sales') && (
          <Link
            href="/reports/sales"
            className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2"
          >
            <ReceiptText className="w-4 h-4" aria-hidden="true" /> تقرير فواتير المبيعات
          </Link>
        )}
        {hasUserPermissionSync(reportUser, 'rep_can_view_purchases') && (
          <Link
            href="/reports/purchases"
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <ShoppingBag className="w-4 h-4" aria-hidden="true" /> تقارير المشتريات
          </Link>
        )}
        {hasUserPermissionSync(reportUser, 'acc_can_view_reports') && (
          <Link
            href="/reports/trial-balance"
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <Scale className="w-4 h-4" aria-hidden="true" /> ميزان المراجعة
          </Link>
        )}
      </div>

      {/* Sales Summary KPI Cards */}
      {!reportReady && loading && (
        <p className="py-8 text-center text-slate-500" role="status">جاري التحقق من تقرير المبيعات...</p>
      )}
      {verifiedReportReady && (<>
      <p className="text-xs font-bold text-slate-600 dark:text-slate-300" role="note">
        {returnsVerified
          ? 'الفترة حسب تاريخ الفاتورة؛ الصافي يخصم المرتجعات المعتمدة لهذه الفواتير حتى الآن، بما فيها المرتجعات التي تمت بعد نهاية الفترة.'
          : 'الفترة حسب تاريخ الفاتورة؛ مبالغ الفواتير قبل المرتجعات. صافي المبيعات بعد المرتجعات غير متاح دون سجل مرتجعات موثّق ومصرّح.'}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/30 text-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <DollarSign className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">
              {returnsVerified ? 'صافي المبيعات' : 'إجمالي فواتير المبيعات'}
            </p>
            <p className="text-2xl font-black text-slate-900 dark:text-white">
              {(returnsVerified ? netSalesAfterReturns : totalNetAmount).toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
            <p className="text-xs text-slate-500 font-bold mt-0.5">{invoices.length} فاتورة</p>
            {!returnsVerified && (
              <p className="text-xs text-amber-700 font-bold mt-0.5">احتساب المرتجعات غير متاح في القراءة الحالية</p>
            )}
            {returnsVerified && totalApprovedReturns > 0 && (
              <p className="text-xs text-rose-600 font-bold mt-0.5">
                مرتجعات معتمدة: {totalApprovedReturns.toLocaleString()} ج.م (حتى الآن)
              </p>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-10 h-10 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">إجمالي قبل الخصم</p>
            <p className="text-2xl font-black text-slate-800 dark:text-slate-200">
              {totalGrossAmount.toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-10 h-10 bg-rose-50 dark:bg-rose-900/30 text-rose-600 rounded-lg flex items-center justify-center shrink-0">
            <ShoppingBag className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">إجمالي الخصومات</p>
            <p className="text-2xl font-black text-rose-600">
              {totalDiscountAmount.toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 rounded-lg flex items-center justify-center shrink-0">
            <Wallet className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">المبيعات النقدية / شبكة</p>
            <p className="text-xl font-black text-emerald-600">
              {(cashSalesTotal + visaSalesTotal).toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
            <p className="text-xs text-slate-500 font-bold mt-0.5">
              آجل: {creditSalesTotal.toLocaleString()} ج.م · محفظة: {walletSalesTotal.toLocaleString()} ج.م
              {otherSalesTotal > 0 ? ` · أخرى: ${otherSalesTotal.toLocaleString()} ج.م` : ''}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">التوزيع حسب قيمة الفواتير قبل المرتجعات</p>
          </div>
        </div>
      </div>

      {/* Main Table (Invoices) */}
      <div className="grid grid-cols-1 gap-4">
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <TableScrollContainer>
            <table className="w-full min-w-[1350px] text-right">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr className="text-slate-500 text-xs font-black">
                  <th className="px-5 py-3.5">الرقم</th>
                  <th className="px-5 py-3.5">النوع</th>
                  <th className="px-5 py-3.5">التاريخ</th>
                  <th className="px-5 py-3.5">العميل</th>
                  <th className="px-5 py-3.5">الموظف</th>
                  <th className="px-5 py-3.5">ق. الفاتورة</th>
                  <th className="px-5 py-3.5">ق. الخصم</th>
                  <th className="px-5 py-3.5">ق. بعد الخصم (قبل المرتجعات)</th>
                  <th className="px-5 py-3.5">مرتجعات معتمدة حتى الآن</th>
                  <th className="px-5 py-3.5">الصافي بعد المرتجعات حتى الآن</th>
                  <th className="px-5 py-3.5">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {loading ? (
                  <tr><td colSpan={11} className="py-20 text-center font-bold text-slate-400 italic animate-pulse">جاري البحث...</td></tr>
                ) : invoices.length === 0 ? (
                  <tr><td colSpan={11} className="py-20 text-center font-bold text-slate-400 italic">لا توجد فواتير مطابقة للبحث</td></tr>
                ) : invoices.map((inv) => (
                  <tr 
                    key={inv.id} 
                    tabIndex={0}
                    onClick={() => handleInvoiceClick(inv.id)}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        void handleInvoiceClick(inv.id);
                      }
                    }}
                    className={cn(
                      "hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer group focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500",
                      selectedInvoice === inv.id ? "bg-blue-50/50 dark:bg-blue-900/10" : ""
                    )}
                  >
                    <td className="px-8 py-6 font-mono font-black text-blue-600 group-hover:underline">#{inv.id.slice(0, 8)}</td>
                    <td className="px-8 py-6">
                      <span className={cn(
                        "px-4 py-1.5 rounded-full text-xs font-black",
                        inv.payment_method === 'cash' ? "bg-emerald-50 text-emerald-600" :
                        inv.payment_method === 'visa' ? "bg-blue-50 text-blue-600" :
                        inv.payment_method === 'wallet' ? "bg-amber-50 text-amber-700" : "bg-purple-50 text-purple-600"
                      )}>
                        {paymentMethodLabel(inv.payment_method)}
                      </span>
                    </td>
                    <td className="px-8 py-6 font-bold text-slate-500">{format(new Date(inv.created_at), 'yyyy/MM/dd HH:mm')}</td>
                    <td className="px-8 py-6 font-black">{inv.patient_name || '-'}</td>
                    <td className="px-8 py-6 font-bold text-slate-400 italic">{inv.staff_name || 'غير محدد'}</td>
                    <td className="px-8 py-6 font-black">{(Number(inv.total_amount || 0) + Number(inv.discount_amount || 0)).toLocaleString()}</td>
                    <td className="px-8 py-6 font-black text-rose-500">{inv.discount_amount?.toLocaleString() || 0}</td>
                    <td className="px-8 py-6 font-black text-lg text-slate-900 dark:text-white">{Number(inv.total_amount || 0).toLocaleString()}</td>
                    <td className="px-8 py-6 font-bold text-rose-600">{returnsVerified ? Number(inv.refunded_amount).toLocaleString() : 'غير متاح'}</td>
                    <td className="px-8 py-6 font-black text-blue-600">{returnsVerified ? (Number(inv.total_amount) - Number(inv.refunded_amount)).toLocaleString() : 'غير متاح'}</td>
                    <td className="px-8 py-6">
                      <span className={cn(
                        "px-3 py-1 rounded-lg text-xs font-black",
                        inv.status === 'completed' || inv.status === 'approved' ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/20 dark:text-emerald-400" :
                        inv.status === 'delivered' ? "bg-blue-50 text-blue-600 dark:bg-blue-950/20 dark:text-blue-400" :
                        inv.status === 'draft' ? "bg-amber-50 text-amber-600 dark:bg-amber-950/20 dark:text-amber-400" :
                        "bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                      )}>
                        {inv.status === 'completed' ? 'منتهية' :
                         inv.status === 'approved' ? 'معتمدة' :
                         inv.status === 'delivered' ? 'تم التوصيل' :
                         inv.status === 'draft' ? 'مسودة' : inv.status || 'منتهية'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              {invoices.length > 0 && (
                <tfoot className="bg-slate-50 dark:bg-slate-800/80 font-black border-t-2 border-slate-200 dark:border-slate-700">
                  <tr>
                    <td colSpan={5} className="px-8 py-6 text-slate-700 dark:text-slate-200 text-sm font-black">
                      الإجمالي ({invoices.length} فاتورة)
                    </td>
                    <td className="px-8 py-6 font-black text-slate-800 dark:text-slate-200">
                      {totalGrossAmount.toLocaleString()}
                    </td>
                    <td className="px-8 py-6 font-black text-rose-500">
                      {totalDiscountAmount.toLocaleString()}
                    </td>
                    <td className="px-8 py-6 font-black text-xl text-blue-600 dark:text-blue-400">
                      {totalNetAmount.toLocaleString()}
                    </td>
                    <td className="px-8 py-6 font-bold text-rose-600">{returnsVerified ? totalApprovedReturns.toLocaleString() : 'غير متاح'}</td>
                    <td className="px-8 py-6 font-black text-blue-600">{returnsVerified ? netSalesAfterReturns.toLocaleString() : 'غير متاح'}</td>
                    <td className="px-8 py-6"></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </TableScrollContainer>
        </div>
        {selectedInvoice && !loadingItems && (
          <ReceiptDetailsModal 
            invoice={{
              id: selectedInvoice,
              total_amount: invoices.find(i => i.id === selectedInvoice)?.total_amount || 0,
              discount_amount: invoices.find(i => i.id === selectedInvoice)?.discount_amount || 0,
              points_redeemed: invoices.find(i => i.id === selectedInvoice)?.points_redeemed || 0,
              loyalty_discount_amount: invoices.find(i => i.id === selectedInvoice)?.loyalty_discount_amount || 0,
              created_at: invoices.find(i => i.id === selectedInvoice)?.created_at || new Date().toISOString(),
              payment_method: invoices.find(i => i.id === selectedInvoice)?.payment_method || 'cash',
              profiles: { full_name: invoices.find(i => i.id === selectedInvoice)?.staff_name || 'System' },
              patients: invoices.find(i => i.id === selectedInvoice)?.patient_name ? { full_name: invoices.find(i => i.id === selectedInvoice)?.patient_name, phone: '' } : null,
              sales_items: invoiceItems.map((item: any) => ({
                quantity_sold: item.quantity_sold,
                unit_price: item.unit_price,
                inventory: { master_drugs: { trade_name: item.trade_name, trade_name_en: item.trade_name_en || item.trade_name } },
                trade_name: item.trade_name,
                trade_name_en: item.trade_name_en || item.trade_name,
                active_ingredient: item.active_ingredient,
                unit: item.unit,
              }))
            } as any}
            onClose={() => setSelectedInvoice(null)}
          />
        )}
      </div>
      </>)}
    </div>
  );
}

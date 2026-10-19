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
import { getPurchasesReportsAction, getPurchaseInvoiceDetailsAction, getSuppliersAction } from '@/app/actions-client/purchases';
import { getStaffAction } from '@/app/actions-client/users';
import { format } from 'date-fns';
import { toast } from 'react-hot-toast';
import { hasUserPermissionSync } from '@/lib/auth/local';
import { useHotkeys } from 'react-hotkeys-hook';
import { useDialogFocusTrap } from '@/hooks/useDialogFocusTrap';

function optionalNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function purchaseReportPaymentLabel(method: unknown): string {
  if (method === 'cash') return 'نقدي';
  if (method === 'credit') return 'آجل';
  if (method === 'check') return 'شيك';
  return String(method || '-');
}

// Literal cell values must stay inert when the workbook is opened in Excel or
// converted to CSV. A leading whitespace/control character does not make a
// formula prefix safe; prefix the entire original value with an apostrophe.
export function safePurchasesReportExportText(value: unknown): string {
  const text = String(value ?? '');
  return /^[\x00-\x20\uFEFF]*[=+@-]/u.test(text) ? `'${text}` : text;
}

// Report SQL can produce e.g. 462.00000000000006 for an exact 462.00 posting.
// Normalize *only* cent-equivalent, finite numbers. Never turn missing, malformed
// or fractional-cent values into a plausible 0.00 in a financial workbook.
function purchaseReportExportMoney(value: unknown, field: string, required = false): number | string {
  if ((value === undefined || value === null) && !required) return 'غير متاح';
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid purchase report export amount: ${field}`);
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 0.001) {
    throw new Error(`Invalid purchase report export amount: ${field}`);
  }
  return cents / 100;
}

// Deterministic, offline export builder. Numeric verified financial figures
// remain numeric XLSX cells. No additional database read occurs during export.
export function buildPurchasesReportWorkbook(invoices: any[], XLSX: typeof import('xlsx')) {
  const rows = invoices.map((invoice) => {
    const original = purchaseReportExportMoney(invoice.total_amount, 'total_amount', true) as number;
    const returned = purchaseReportExportMoney(invoice.returned_amount, 'returned_amount');
    const adjusted = purchaseReportExportMoney(invoice.net_after_returns, 'net_after_returns');
    if ((typeof returned === 'number') !== (typeof adjusted === 'number') ||
        (typeof returned === 'number' && typeof adjusted === 'number' &&
          Math.round(original * 100) !== Math.round(returned * 100) + Math.round(adjusted * 100))) {
      throw new Error('Invalid purchase report export amount: return reconciliation');
    }
    return {
      'رقم الفاتورة': safePurchasesReportExportText(invoice.invoice_number || invoice.id),
      'تاريخ الفاتورة': safePurchasesReportExportText(invoice.invoice_date || invoice.created_at),
      'المورد': safePurchasesReportExportText(invoice.supplier_name),
      'المستخدم': safePurchasesReportExportText(invoice.staff_name),
      'طريقة الدفع': safePurchasesReportExportText(purchaseReportPaymentLabel(invoice.payment_method)),
      'إجمالي قبل الخصم': purchaseReportExportMoney(invoice.gross_amount, 'gross_amount'),
      'الخصم': purchaseReportExportMoney(invoice.discount_amount, 'discount_amount'),
      'صافي الفاتورة قبل مرتجعات الموردين': original,
      'مرتجعات الموردين الموثقة حتى وقت التقرير': returned,
      'صافي الفاتورة بعد المرتجعات الموثقة': adjusted,
      'إجمالي البيع المتوقع': purchaseReportExportMoney(invoice.total_selling_amount, 'total_selling_amount'),
      'الحالة': safePurchasesReportExportText(invoice.status),
    };
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Purchases');
  return workbook;
}

export function purchaseReportUnitLabel(item: Record<string, unknown>): string {
  const largeUnit = String(item.large_unit ?? '').trim();
  return largeUnit || 'علبة';
}

export function purchaseReportDate(value: unknown, includeTime = false): string {
  if (!value) return '-';
  const text = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) return `${dateOnly[1]}/${dateOnly[2]}/${dateOnly[3]}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return format(parsed, includeTime ? 'yyyy/MM/dd HH:mm' : 'yyyy/MM/dd');
}

export function purchaseReportLineAmounts(item: Record<string, unknown>) {
  const quantity = Number(item.quantity || 0);
  const unitCost = Number(item.cost_price || 0);
  const taxPercent = Number(item.tax_percent || 0);
  // Bonus stock is free; only paid quantity contributes to the invoice value.
  const fallbackGross = quantity * unitCost * (1 + taxPercent / 100);
  const gross = optionalNumber(
    item.line_gross_amount,
    item.lineGrossAmount,
    item.gross_amount,
    fallbackGross,
  ) ?? 0;
  const explicitDiscount = optionalNumber(
    item.line_discount_amount,
    item.lineDiscountAmount,
    item.allocated_discount_amount,
    item.discount_amount,
  ) ?? 0;
  const net = optionalNumber(
    item.line_net_amount,
    item.lineNetAmount,
    item.net_amount,
    gross - explicitDiscount,
  ) ?? gross;
  return { gross, discount: Math.max(0, gross - net), net };
}

export default function PurchasesReportsClient({ userRole, user }: { userRole?: string; user?: any }) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // A denied/failed native read must never masquerade as an audited zero total.
  const [reportState, setReportState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reportError, setReportError] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<any[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const [staff, setStaff] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const searchRequestRef = useRef(0);
  const invoiceDetailsRequestRef = useRef(0);
  const invoiceDialogRef = useDialogFocusTrap<HTMLDivElement>(Boolean(selectedInvoice));

  const [filters, setFilters] = useState({
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    userId: 'all',
    supplierId: 'all',
    paymentMethod: 'all',
    invoiceNumber: '',
    drugName: '',
  });

  useEffect(() => {
    async function loadFilters() {
      const [staffResult, supplierResult] = await Promise.allSettled([
        getStaffAction(),
        getSuppliersAction({ reportScope: true }),
      ]);
      let metadataFailed = false;

      if (staffResult.status === 'fulfilled' && staffResult.value.success) {
        setStaff(staffResult.value.data || []);
      } else {
        metadataFailed = true;
      }
      if (supplierResult.status === 'fulfilled' && supplierResult.value.success) {
        setSuppliers(supplierResult.value.data || []);
      } else {
        metadataFailed = true;
      }
      if (metadataFailed) toast.error('تعذر تحميل بعض فلاتر تقرير المشتريات');
    }
    void loadFilters();
    void handleSearch();
    // Initial load uses the default filters; edited filters run only when Search is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async () => {
    const requestId = ++searchRequestRef.current;
    setLoading(true);
    setReportState('loading');
    try {
      const res = await getPurchasesReportsAction({
        ...filters,
        userId: filters.userId === 'all' ? undefined : filters.userId,
        supplierId: filters.supplierId === 'all' ? undefined : filters.supplierId,
      });
      if (requestId !== searchRequestRef.current) return;
      if (res.success) {
        const nextInvoices = res.data || [];
        setInvoices(nextInvoices);
        setReportError('');
        setReportState('ready');
        if (selectedInvoice && !nextInvoices.some((invoice: any) => invoice.id === selectedInvoice)) {
          invoiceDetailsRequestRef.current += 1;
          setSelectedInvoice(null);
          setInvoiceItems([]);
          setLoadingItems(false);
        }
      } else {
        const ownershipDenied = String(res.error || '').includes('Legacy purchasing ownership needs independent tenant verification');
        const unverifiedReturns = String(res.error || '').includes('Unverified tenant-owned purchase return');
        setReportError(ownershipDenied
          ? 'تعذر التحقق من ملكية بيانات المشتريات. يلزم إثبات تبعية الفواتير للصيدلية قبل عرض التقرير.'
          : unverifiedReturns
          ? 'توجد مرتجعات مشتريات لا يمكن التحقق من سنداتها المحاسبية للصيدلية. تعذر احتساب الصافي بعد المرتجعات.'
          : 'تعذر تحميل تقرير المشتريات. القيم المالية غير متاحة حتى تنجح إعادة المحاولة.');
        setReportState('error');
        toast.error(res.error || 'فشل تحميل تقرير المشتريات');
      }
    } catch (err) {
      if (requestId !== searchRequestRef.current) return;
      console.error('Purchases report search error:', err);
      setReportError('تعذر تحميل تقرير المشتريات. القيم المالية غير متاحة حتى تنجح إعادة المحاولة.');
      setReportState('error');
      toast.error('فشل تحميل تقرير المشتريات');
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
      const res = await getPurchaseInvoiceDetailsAction(invoiceId, { reportScope: true });
      if (requestId !== invoiceDetailsRequestRef.current) return;
      if (res.success) setInvoiceItems(res.data || []);
      else {
        toast.error(res.error || 'فشل تحميل تفاصيل فاتورة الشراء');
        setSelectedInvoice(null);
      }
    } catch (err) {
      if (requestId !== invoiceDetailsRequestRef.current) return;
      console.error('Purchase report invoice details error:', err);
      toast.error('فشل تحميل تفاصيل فاتورة الشراء');
      setSelectedInvoice(null);
    } finally {
      if (requestId === invoiceDetailsRequestRef.current) setLoadingItems(false);
    }
  };

  const handleExport = async () => {
    if (invoices.length === 0) {
      toast.error('لا توجد فواتير لتصديرها');
      return;
    }

    try {
      const XLSX = await import('xlsx');
      const workbook = buildPurchasesReportWorkbook(invoices, XLSX);
      XLSX.writeFile(workbook, `purchase-report-${format(new Date(), 'yyyy-MM-dd')}.xlsx`);
      toast.success('تم تصدير تقرير المشتريات');
    } catch (error) {
      console.error('Failed to export purchase report:', error);
      toast.error('فشل تصدير تقرير المشتريات');
    }
  };

  const totalGrossAmount = invoices.reduce((sum, inv) => sum + Number(inv.gross_amount ?? inv.total_amount ?? 0), 0);
  const totalDiscountAmount = invoices.reduce((sum, inv) => sum + Number(inv.discount_amount || 0), 0);
  const totalNetAmount = invoices.reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const returnTotalsVerified = invoices.length > 0 && invoices.every(inv =>
    typeof inv.returned_amount === 'number' && Number.isFinite(inv.returned_amount) &&
    typeof inv.net_after_returns === 'number' && Number.isFinite(inv.net_after_returns));
  const totalReturnedAmount = returnTotalsVerified
    ? invoices.reduce((sum, inv) => sum + inv.returned_amount, 0) : null;
  const totalAfterReturns = returnTotalsVerified
    ? invoices.reduce((sum, inv) => sum + inv.net_after_returns, 0) : null;
  const totalSellingAmount = invoices.reduce((sum, inv) => sum + Number(inv.total_selling_amount || 0), 0);
  const cashPurchasesTotal = invoices
    .filter(i => i.payment_method === 'cash')
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const creditPurchasesTotal = invoices
    .filter(i => i.payment_method === 'credit')
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const reportUser = user || (userRole ? { role: userRole } : null);

  return (
    <div className="space-y-6 pb-16" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-center mb-5">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 dark:text-white">تقرير فواتير المشتريات</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">فواتير الشراء الأصلية ومرتجعات الموردين المثبتة على نفس الفواتير</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              disabled={reportState !== 'ready'}
              aria-label="طباعة تقرير المشتريات"
              title="طباعة تقرير المشتريات"
              className="inline-flex h-11 w-11 items-center justify-center bg-slate-50 dark:bg-slate-800 text-slate-600 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            >
              <Printer className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={reportState !== 'ready'}
              aria-label="تصدير تقرير المشتريات إلى Excel"
              title="تصدير تقرير المشتريات إلى Excel"
              className="inline-flex h-11 w-11 items-center justify-center bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 rounded-lg border border-blue-100 dark:border-blue-900/50 hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors"
            >
              <Download className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="space-y-5 p-4 sm:p-5 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-slate-200 dark:border-slate-700">
          
          {/* Top Main Search Bar for Drug Name */}
          <div className="space-y-2">
            <label htmlFor="purchase-report-drug" className="text-xs font-black text-blue-600 dark:text-blue-400 flex items-center gap-2">
              <Search className="w-4 h-4" /> البحث باسم الصنف / الدواء في كافة فواتير المشتريات
            </label>
            <div className="relative">
              <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input 
                id="purchase-report-drug"
                type="text" 
                placeholder="ادخل اسم الصنف أو المادة الفعالة للبحث في الفواتير..."
                className="w-full pr-11 pl-3.5 py-2.5 bg-white dark:bg-slate-900 rounded-lg border border-blue-200 dark:border-blue-900 text-sm font-medium text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600 shadow-sm"
                value={filters.drugName}
                onChange={(e) => setFilters({...filters, drugName: e.target.value})}
              />
            </div>
          </div>

          {/* Secondary Filters */}
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="space-y-2">
              <label htmlFor="purchase-report-start-date" className="text-xs font-black text-slate-500 mr-2">من تاريخ</label>
              <div className="relative">
                <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  id="purchase-report-start-date"
                  type="date" 
                  className="w-full pr-10 pl-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none focus:border-blue-500"
                  value={filters.startDate}
                  onChange={(e) => setFilters({...filters, startDate: e.target.value})}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="purchase-report-end-date" className="text-xs font-black text-slate-500 mr-2">إلى تاريخ</label>
              <div className="relative">
                <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  id="purchase-report-end-date"
                  type="date" 
                  className="w-full pr-10 pl-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none focus:border-blue-500"
                  value={filters.endDate}
                  onChange={(e) => setFilters({...filters, endDate: e.target.value})}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="purchase-report-invoice" className="text-xs font-black text-slate-500 mr-2">رقم الفاتورة</label>
              <input 
                id="purchase-report-invoice"
                type="text" 
                placeholder="رقم الفاتورة..."
                className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none"
                value={filters.invoiceNumber}
                onChange={(e) => setFilters({...filters, invoiceNumber: e.target.value})}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="purchase-report-supplier" className="text-xs font-black text-slate-500 mr-2">المورد</label>
              <select 
                id="purchase-report-supplier"
                className="w-full px-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none"
                value={filters.supplierId}
                onChange={(e) => setFilters({...filters, supplierId: e.target.value})}
              >
                <option value="all">كل الموردين</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="purchase-report-staff" className="text-xs font-black text-slate-500 mr-2">الموظف / الصيدلي</label>
              <select 
                id="purchase-report-staff"
                className="w-full px-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none"
                value={filters.userId}
                onChange={(e) => setFilters({...filters, userId: e.target.value})}
              >
                <option value="all">كل الموظفين</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="purchase-report-payment" className="text-xs font-black text-slate-500 mr-2">طريقة الدفع</label>
              <select 
                id="purchase-report-payment"
                className="w-full px-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none"
                value={filters.paymentMethod}
                onChange={(e) => setFilters({...filters, paymentMethod: e.target.value})}
              >
                <option value="all">الكل</option>
                <option value="cash">نقدي</option>
                <option value="credit">آجل</option>
                <option value="check">شيك</option>
              </select>
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button 
              type="button"
              onClick={handleSearch}
              className="px-6 py-2.5 bg-slate-900 text-white rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-slate-800 transition-colors shadow-sm text-sm"
            >
              <Search className="w-5 h-5" /> بحث في الفواتير (F)
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
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <ReceiptText className="w-4 h-4" aria-hidden="true" /> تقرير فواتير المبيعات
          </Link>
        )}
        {hasUserPermissionSync(reportUser, 'rep_can_view_purchases') && (
          <Link
            href="/reports/purchases"
            className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2"
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

      {reportState === 'error' && (
        <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-5 text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
          <p className="font-bold">{reportError}</p>
          <button type="button" onClick={() => void handleSearch()} className="mt-3 rounded-lg border border-rose-400 px-4 py-2 font-bold focus-visible:ring-2 focus-visible:ring-rose-500">
            إعادة المحاولة
          </button>
        </div>
      )}
      {reportState === 'loading' && (
        <p role="status" className="py-5 text-center font-bold text-slate-500">جاري التحقق من بيانات تقرير المشتريات...</p>
      )}
      {reportState === 'ready' && <>
      <p role="note" className="rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm font-bold text-amber-900 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200">
        نطاق التاريخ يحدد تاريخ فواتير الشراء. عند توفر السندات الأصلية تخصم جميع مرتجعات تلك الفواتير المثبتة حتى وقت تحميل التقرير، بما فيها المرتجعات اللاحقة لنهاية الفترة. غير الموثق يظهر «غير متاح». الصافي بعد المرتجعات ليس رصيد المورد بعد الدفعات.
      </p>
      {/* Purchases Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/30 text-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <DollarSign className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">صافي فواتير الشراء قبل مرتجعات الموردين</p>
            <p className="text-2xl font-black text-slate-900 dark:text-white">
              {totalNetAmount.toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
            <p className="text-xs text-slate-500 font-bold mt-0.5">{invoices.length} فاتورة</p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <p className="text-xs font-bold text-slate-500">مرتجعات الموردين الموثقة لتلك الفواتير</p>
          <p className="text-2xl font-black text-rose-600">{totalReturnedAmount === null ? 'غير متاح' : totalReturnedAmount.toLocaleString()} <span className="text-xs text-slate-400">{totalReturnedAmount === null ? '' : 'ج.م'}</span></p>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <p className="text-xs font-bold text-slate-500">صافي المشتريات بعد مرتجعات الموردين الموثقة</p>
          <p className="text-2xl font-black text-emerald-600">{totalAfterReturns === null ? 'غير متاح' : totalAfterReturns.toLocaleString()} <span className="text-xs text-slate-400">{totalAfterReturns === null ? '' : 'ج.م'}</span></p>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-14 h-14 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-2xl flex items-center justify-center shrink-0">
            <FileText className="w-7 h-7" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">إجمالي قبل الخصم</p>
            <p className="text-2xl font-black text-slate-800 dark:text-slate-200">
              {totalGrossAmount.toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-14 h-14 bg-rose-50 dark:bg-rose-900/30 text-rose-600 rounded-2xl flex items-center justify-center shrink-0">
            <ShoppingBag className="w-7 h-7" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">إجمالي الخصومات</p>
            <p className="text-2xl font-black text-rose-600">
              {totalDiscountAmount.toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-14 h-14 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 rounded-2xl flex items-center justify-center shrink-0">
            <CreditCard className="w-7 h-7" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">القيمة البيعية المتوقعة</p>
            <p className="text-xl font-black text-emerald-600">
              {totalSellingAmount.toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
            <p className="text-xs text-slate-500 font-bold mt-0.5">
              نقدي: {cashPurchasesTotal.toLocaleString()} | آجل: {creditPurchasesTotal.toLocaleString()}
            </p>
          </div>
        </div>
      </div>

      {/* Main Table (Invoices) */}
      <div className="grid grid-cols-1 gap-4">
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <TableScrollContainer>
            <table className="w-full min-w-[1180px] text-right">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr className="text-slate-500 text-xs font-black">
                  <th className="px-5 py-3.5">الرقم</th>
                  <th className="px-5 py-3.5">النوع</th>
                  <th className="px-5 py-3.5">التاريخ</th>
                  <th className="px-5 py-3.5">المورد</th>
                  <th className="px-5 py-3.5">الموظف</th>
                  <th className="px-5 py-3.5">إجمالي قبل الخصم</th>
                  <th className="px-5 py-3.5">ق. البيع المتوقعة</th>
                  <th className="px-5 py-3.5">ق. الخصم</th>
                  <th className="px-5 py-3.5">صافي الفاتورة قبل المرتجعات</th>
                  <th className="px-5 py-3.5">مرتجعات المورد الموثقة</th>
                  <th className="px-5 py-3.5">الصافي بعد المرتجعات</th>
                  <th className="px-5 py-3.5">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {loading ? (
                  <tr><td colSpan={12} className="py-20 text-center font-bold text-slate-400 italic animate-pulse">جاري البحث...</td></tr>
                ) : invoices.length === 0 ? (
                  <tr><td colSpan={12} className="py-20 text-center font-bold text-slate-400 italic">لا توجد فواتير مطابقة للبحث</td></tr>
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
                    <td className="px-6 py-6 font-mono font-black text-blue-600 group-hover:underline">#{inv.id.slice(0, 8)}</td>
                    <td className="px-6 py-6">
                      <span className={cn(
                        "px-4 py-1.5 rounded-full text-xs font-black",
                        inv.payment_method === 'cash' ? "bg-emerald-50 text-emerald-600" :
                        inv.payment_method === 'check' ? "bg-amber-50 text-amber-600" : "bg-purple-50 text-purple-600"
                      )}>
                        {inv.payment_method === 'cash' ? 'نقدي' : inv.payment_method === 'check' ? 'شيك' : 'آجل'}
                      </span>
                    </td>
                    <td className="px-6 py-6 font-bold text-slate-500">{purchaseReportDate(inv.invoice_date || inv.created_at, true)}</td>
                    <td className="px-6 py-6 font-black">{inv.supplier_name || '-'}</td>
                    <td className="px-6 py-6 font-bold text-slate-400 italic">{inv.staff_name || 'غير محدد'}</td>
                    <td className="px-6 py-6 font-black">{Number(inv.gross_amount ?? inv.total_amount ?? 0).toLocaleString()}</td>
                    <td className="px-6 py-6 font-black text-emerald-600">{(inv.total_selling_amount || 0).toLocaleString()}</td>
                    <td className="px-6 py-6 font-black text-rose-500">{Number(inv.discount_amount || 0).toLocaleString()}</td>
                    <td className="px-6 py-6 font-black text-lg text-slate-900 dark:text-white">{Number(inv.total_amount || 0).toLocaleString()}</td>
                    <td className="px-6 py-6 font-bold text-rose-600">{typeof inv.returned_amount === 'number' ? inv.returned_amount.toLocaleString() : 'غير متاح'}</td>
                    <td className="px-6 py-6 font-black text-lg text-emerald-600">{typeof inv.net_after_returns === 'number' ? inv.net_after_returns.toLocaleString() : 'غير متاح'}</td>
                    <td className="px-6 py-6">
                      <span className={cn(
                        "px-3 py-1 rounded-lg text-xs font-black",
                        inv.status === 'completed' ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/20 dark:text-emerald-400" :
                        inv.status === 'delivered' ? "bg-blue-50 text-blue-600 dark:bg-blue-950/20 dark:text-blue-400" :
                        inv.status === 'draft' ? "bg-amber-50 text-amber-600 dark:bg-amber-950/20 dark:text-amber-400" :
                        "bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                      )}>
                        {inv.status === 'completed' ? 'منتهية' :
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
                    <td colSpan={5} className="px-6 py-6 text-slate-700 dark:text-slate-200 text-sm font-black">
                      الإجمالي ({invoices.length} فاتورة)
                    </td>
                    <td className="px-6 py-6 font-black text-slate-800 dark:text-slate-200">
                      {totalGrossAmount.toLocaleString()}
                    </td>
                    <td className="px-6 py-6 font-black text-emerald-600">
                      {totalSellingAmount.toLocaleString()}
                    </td>
                    <td className="px-6 py-6 font-black text-rose-500">
                      {totalDiscountAmount.toLocaleString()}
                    </td>
                    <td className="px-6 py-6 font-black text-xl text-blue-600 dark:text-blue-400">
                      {totalNetAmount.toLocaleString()}
                    </td>
                    <td className="px-6 py-6"></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </TableScrollContainer>
        </div>

        {/* Invoice Items Modal */}
        {selectedInvoice && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
            <div
              ref={invoiceDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="purchase-items-dialog-title"
              tabIndex={-1}
              className="w-full max-w-5xl bg-white dark:bg-slate-900 text-slate-900 dark:text-white rounded-[40px] shadow-2xl animate-in zoom-in-95 border border-slate-100 dark:border-slate-800 flex flex-col max-h-[90vh] overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center shrink-0">
                <div>
                  <h4 id="purchase-items-dialog-title" className="text-xl font-black">أصناف الفاتورة #{selectedInvoice.slice(0, 8)}</h4>
                  <p className="text-slate-500 dark:text-slate-400 text-xs font-bold">تفاصيل المشتريات والكميات والأسعار</p>
                </div>
                <button 
                  type="button"
                  aria-label="إغلاق تفاصيل أصناف فاتورة المشتريات"
                  onClick={() => setSelectedInvoice(null)}
                  className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-2xl transition-all"
                >
                  <ArrowRight className="w-5 h-5 rotate-180" />
                </button>
              </div>
              <div className="overflow-auto flex-1 p-2">
                <table className="w-full min-w-[1100px] text-right border-separate border-spacing-y-2 px-6">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 sticky top-0 z-10">
                    <tr className="text-slate-500 text-xs font-black">
                      <th className="px-4 py-5 rounded-r-2xl">كود الصنف</th>
                      <th className="px-4 py-5">إسم الصنف</th>
                      <th className="px-4 py-5">ت. الصلاحية</th>
                      <th className="px-4 py-5">الكمية</th>
                      <th className="px-4 py-5">الوحدة</th>
                      <th className="px-4 py-5">سعر الشراء</th>
                      <th className="px-4 py-5">سعر البيع</th>
                      <th className="px-4 py-5">إجمالي قبل الخصم</th>
                      <th className="px-4 py-5">صافي الشراء</th>
                      <th className="px-4 py-5 rounded-l-2xl">إجمالي البيع</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-transparent">
                    {loadingItems ? (
                      <tr><td colSpan={10} className="py-10 text-center animate-pulse text-slate-400 font-bold">جاري جلب الأصناف...</td></tr>
                    ) : invoiceItems.length === 0 ? (
                      <tr><td colSpan={10} className="py-10 text-center text-slate-400 font-bold">لا توجد أصناف مسجلة لهذه الفاتورة</td></tr>
                    ) : invoiceItems.map((item) => {
                      const amounts = purchaseReportLineAmounts(item);
                      return <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                        <td className="px-4 py-5 font-mono text-blue-500 rounded-r-2xl bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{item.barcode}</td>
                        <td className="px-4 py-5 font-black bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">
                          {item.trade_name_en && !/^Drug\s*#?\s*\d+$/i.test(item.trade_name_en.trim())
                            ? item.trade_name_en
                            : (item.trade_name && !/^Drug\s*#?\s*\d+$/i.test(item.trade_name.trim())
                              ? item.trade_name
                              : (item.trade_name_en || item.trade_name || item.active_ingredient || `صنف #${item.drug_id || item.id}`))}
                        </td>
                        <td className="px-4 py-5 font-bold text-slate-400 italic bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{purchaseReportDate(item.expiry_date)}</td>
                        <td className="px-4 py-5 font-black text-lg bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{item.quantity}</td>
                        <td className="px-4 py-5 text-slate-500 bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{purchaseReportUnitLabel(item)}</td>
                        <td className="px-4 py-5 font-bold bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{item.cost_price?.toLocaleString()}</td>
                        <td className="px-4 py-5 font-bold text-emerald-600 bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{(item.selling_price || item.base_price || 0).toLocaleString()}</td>
                        <td className="px-4 py-5 font-black bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{amounts.gross.toLocaleString()}</td>
                        <td className="px-4 py-5 font-black text-blue-600 bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{amounts.net.toLocaleString()}</td>
                        <td className="px-4 py-5 font-black text-emerald-500 rounded-l-2xl bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50">{(((item.selling_price || item.base_price || 0)) * (item.quantity || 0)).toLocaleString()}</td>
                      </tr>;
                    })}
                  </tbody>
                  {!loadingItems && invoiceItems.length > 0 && (() => {
                    const selected = invoices.find(invoice => invoice.id === selectedInvoice);
                    const lineTotals = invoiceItems.reduce((totals, item) => {
                      const amounts = purchaseReportLineAmounts(item);
                      totals.gross += amounts.gross;
                      totals.net += amounts.net;
                      totals.selling += ((Number(item.selling_price ?? item.base_price ?? 0)) * (Number(item.quantity || 0)));
                      return totals;
                    }, { gross: 0, net: 0, selling: 0 });
                    const invoiceNet = Number(selected?.total_amount || 0);
                    const reconciliation = invoiceNet - lineTotals.net;

                    return (
                      <tfoot className="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/70 font-black text-xs">
                        <tr>
                          <td colSpan={7} className="px-4 py-4 text-slate-600 dark:text-slate-300">إجمالي السطور المسجلة</td>
                          <td className="px-4 py-4 text-slate-800 dark:text-slate-200">{lineTotals.gross.toLocaleString()}</td>
                          <td className="px-4 py-4 text-blue-600 dark:text-blue-400">{lineTotals.net.toLocaleString()}</td>
                          <td className="px-4 py-4 text-emerald-600">{lineTotals.selling.toLocaleString()}</td>
                        </tr>
                        {Math.abs(reconciliation) > 0.01 && (
                          <tr>
                            <td colSpan={8} className="px-4 py-3 text-slate-500">تسوية الفاتورة (ضريبة/خصم/مصروفات)</td>
                            <td className="px-4 py-3 text-amber-600 font-bold">{reconciliation.toLocaleString()}</td>
                            <td className="px-4 py-3"></td>
                          </tr>
                        )}
                        <tr>
                          <td colSpan={8} className="px-4 py-4 text-base">صافي الفاتورة النهائي</td>
                          <td className="px-4 py-4 text-lg text-primary-600 dark:text-primary-400">{invoiceNet.toLocaleString()} ج.م</td>
                          <td className="px-4 py-4"></td>
                        </tr>
                      </tfoot>
                    );
                  })()}
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
      </>}
    </div>
  );
}

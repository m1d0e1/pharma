'use client';
import TableScrollContainer from '@/components/ui/TableScrollContainer';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  Search, Filter, Calendar, User, ShoppingBag, 
  ChevronDown, FileText, Download, Printer, 
  ArrowRight, CreditCard, DollarSign, Wallet
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPurchasesReportsAction, getPurchaseInvoiceDetailsAction, getSuppliersAction } from '@/app/actions-client/purchases';
import { getStaffAction } from '@/app/actions-client/users';
import { format } from 'date-fns';
import { toast } from 'react-hot-toast';

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

export function purchaseReportUnitLabel(item: Record<string, unknown>): string {
  const unitId = Number(item.unit_id);
  if (unitId === 1) return 'علبة';
  if (unitId === 2) return 'شريط';
  return String(item.unit || '-');
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

export default function PurchasesReportsClient({ userRole }: { userRole?: string }) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<any[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const [staff, setStaff] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);

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
    async function loadData() {
      const staffRes = await getStaffAction();
      if (staffRes.success) setStaff(staffRes.data || []);

      const supplierRes = await getSuppliersAction();
      if (supplierRes.success) setSuppliers(supplierRes.data || []);

      handleSearch();
    }
    loadData();
    // Initial load uses the default filters; edited filters run only when Search is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async () => {
    setLoading(true);
    const res = await getPurchasesReportsAction({
      ...filters,
      userId: filters.userId === 'all' ? undefined : filters.userId,
      supplierId: filters.supplierId === 'all' ? undefined : filters.supplierId,
    });
    if (res.success) setInvoices(res.data || []);
    setLoading(false);
  };

  const handleInvoiceClick = async (invoiceId: string) => {
    setSelectedInvoice(invoiceId);
    setLoadingItems(true);
    const res = await getPurchaseInvoiceDetailsAction(invoiceId);
    if (res.success) setInvoiceItems(res.data || []);
    setLoadingItems(false);
  };

  const handleExport = async () => {
    if (invoices.length === 0) {
      toast.error('لا توجد فواتير لتصديرها');
      return;
    }

    try {
      const XLSX = await import('xlsx');
      const rows = invoices.map((invoice) => ({
        'رقم الفاتورة': invoice.invoice_number || invoice.id,
        'تاريخ الفاتورة': invoice.invoice_date || invoice.created_at,
        'المورد': invoice.supplier_name || '',
        'المستخدم': invoice.staff_name || '',
        'طريقة الدفع': purchaseReportPaymentLabel(invoice.payment_method),
        'إجمالي قبل الخصم': Number(invoice.gross_amount ?? invoice.total_amount ?? 0),
        'الخصم': Number(invoice.discount_amount || 0),
        'صافي الفاتورة': Number(invoice.total_amount || 0),
        'إجمالي البيع المتوقع': Number(invoice.total_selling_amount || 0),
        'الحالة': invoice.status || '',
      }));
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Purchases');
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
  const totalSellingAmount = invoices.reduce((sum, inv) => sum + Number(inv.total_selling_amount || 0), 0);
  const cashPurchasesTotal = invoices
    .filter(i => i.payment_method === 'cash')
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
  const creditPurchasesTotal = invoices
    .filter(i => i.payment_method === 'credit')
    .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);

  return (
    <div className="space-y-8 pb-20" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-black text-slate-800 dark:text-white">تقرير فواتير المشتريات</h1>
            <p className="text-slate-500 font-bold">عرض وتحليل تفصيلي لعمليات البيع والمرتجعات والأسعار</p>
          </div>
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => window.print()}
              aria-label="طباعة تقرير المشتريات"
              title="طباعة تقرير المشتريات"
              className="p-5 bg-slate-50 dark:bg-slate-800 text-slate-500 rounded-2xl border border-slate-100 dark:border-slate-700 hover:bg-slate-100 transition-all"
            >
              <Printer className="w-6 h-6" />
            </button>
            <button
              type="button"
              onClick={handleExport}
              aria-label="تصدير تقرير المشتريات إلى Excel"
              title="تصدير تقرير المشتريات إلى Excel"
              className="p-5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 rounded-2xl hover:bg-blue-600 hover:text-white transition-all"
            >
              <Download className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="space-y-6 p-8 bg-slate-50 dark:bg-slate-800/50 rounded-[32px] border border-slate-100 dark:border-slate-700">
          
          {/* Top Main Search Bar for Drug Name */}
          <div className="space-y-2">
            <label className="text-xs font-black text-blue-600 dark:text-blue-400 uppercase tracking-wide flex items-center gap-2">
              <Search className="w-4 h-4" /> البحث باسم الصنف / الدواء في كافة فواتير المشتريات
            </label>
            <div className="relative">
              <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-400" />
              <input 
                type="text" 
                placeholder="ادخل اسم الصنف أو المادة الفعالة للبحث في الفواتير..."
                className="w-full pr-14 pl-4 py-4 bg-white dark:bg-slate-900 rounded-2xl border-2 border-blue-200 dark:border-blue-900 font-black text-lg text-slate-900 dark:text-white outline-none focus:border-blue-600 shadow-sm"
                value={filters.drugName}
                onChange={(e) => setFilters({...filters, drugName: e.target.value})}
              />
            </div>
          </div>

          {/* Secondary Filters */}
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase mr-2">من تاريخ</label>
              <div className="relative">
                <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="date" 
                  className="w-full pr-10 pl-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none focus:border-blue-500"
                  value={filters.startDate}
                  onChange={(e) => setFilters({...filters, startDate: e.target.value})}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase mr-2">إلى تاريخ</label>
              <div className="relative">
                <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="date" 
                  className="w-full pr-10 pl-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none focus:border-blue-500"
                  value={filters.endDate}
                  onChange={(e) => setFilters({...filters, endDate: e.target.value})}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase mr-2">رقم الفاتورة</label>
              <input 
                type="text" 
                placeholder="رقم الفاتورة..."
                className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none"
                value={filters.invoiceNumber}
                onChange={(e) => setFilters({...filters, invoiceNumber: e.target.value})}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase mr-2">المورد</label>
              <select 
                className="w-full px-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none"
                value={filters.supplierId}
                onChange={(e) => setFilters({...filters, supplierId: e.target.value})}
              >
                <option value="all">كل الموردين</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase mr-2">الموظف / الصيدلي</label>
              <select 
                className="w-full px-3 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs outline-none"
                value={filters.userId}
                onChange={(e) => setFilters({...filters, userId: e.target.value})}
              >
                <option value="all">كل الموظفين</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase mr-2">طريقة الدفع</label>
              <select 
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
              onClick={handleSearch}
              className="px-10 py-4 bg-slate-900 text-white rounded-2xl font-black flex items-center justify-center gap-3 hover:bg-slate-800 transition-all shadow-xl text-base"
            >
              <Search className="w-5 h-5" /> بحث في الفواتير (F)
            </button>
          </div>
        </div>
      </div>

      {/* Reports Unified Navigation Tab Bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-6 text-sm">
        {userRole === 'owner' && (
          <Link 
            href="/reports" 
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <span>📊</span> التحليلات والمخططات
          </Link>
        )}
        <Link 
          href="/reports/sales" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
        >
          <span>🧾</span> تقرير فواتير المبيعات
        </Link>
        <Link 
          href="/reports/purchases" 
          className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2"
        >
          <span>🛒</span> تقارير المشتريات
        </Link>
        <Link 
          href="/reports/trial-balance" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
        >
          <span>⚖️</span> ميزان المراجعة
        </Link>
      </div>

      {/* Purchases Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-14 h-14 bg-blue-50 dark:bg-blue-900/30 text-blue-600 rounded-2xl flex items-center justify-center shrink-0">
            <DollarSign className="w-7 h-7" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-400">صافي المشتريات</p>
            <p className="text-2xl font-black text-slate-900 dark:text-white">
              {totalNetAmount.toLocaleString()} <span className="text-xs text-slate-400">ج.م</span>
            </p>
            <p className="text-[10px] text-slate-400 font-bold mt-0.5">{invoices.length} فاتورة</p>
          </div>
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
            <p className="text-[10px] text-slate-400 font-bold mt-0.5">
              نقدي: {cashPurchasesTotal.toLocaleString()} | آجل: {creditPurchasesTotal.toLocaleString()}
            </p>
          </div>
        </div>
      </div>

      {/* Main Table (Invoices) */}
      <div className="grid grid-cols-1 gap-8">
        <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
          <TableScrollContainer>
            <table className="w-full text-right">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                  <th className="px-6 py-6">الرقم</th>
                  <th className="px-6 py-6">النوع</th>
                  <th className="px-6 py-6">التاريخ</th>
                  <th className="px-6 py-6">المورد</th>
                  <th className="px-6 py-6">الموظف</th>
                  <th className="px-6 py-6">إجمالي قبل الخصم</th>
                  <th className="px-6 py-6">ق. البيع المتوقعة</th>
                  <th className="px-6 py-6">ق. الخصم</th>
                  <th className="px-6 py-6">صافي الشراء</th>
                  <th className="px-6 py-6">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {loading ? (
                  <tr><td colSpan={10} className="py-20 text-center font-bold text-slate-400 italic animate-pulse">جاري البحث...</td></tr>
                ) : invoices.length === 0 ? (
                  <tr><td colSpan={10} className="py-20 text-center font-bold text-slate-400 italic">لا توجد فواتير مطابقة للبحث</td></tr>
                ) : invoices.map((inv) => (
                  <tr 
                    key={inv.id} 
                    onClick={() => handleInvoiceClick(inv.id)}
                    className={cn(
                      "hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer group",
                      selectedInvoice === inv.id ? "bg-blue-50/50 dark:bg-blue-900/10" : ""
                    )}
                  >
                    <td className="px-6 py-6 font-mono font-black text-blue-600 group-hover:underline">#{inv.id.slice(0, 8)}</td>
                    <td className="px-6 py-6">
                      <span className={cn(
                        "px-4 py-1.5 rounded-full text-[10px] font-black",
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
                    <td className="px-6 py-6">
                      <span className={cn(
                        "px-3 py-1 rounded-lg text-[10px] font-black uppercase",
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
            <div className="w-full max-w-5xl bg-white dark:bg-slate-900 text-slate-900 dark:text-white rounded-[40px] shadow-2xl animate-in zoom-in-95 border border-slate-100 dark:border-slate-800 flex flex-col max-h-[90vh] overflow-hidden">
              <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center shrink-0">
                <div>
                  <h4 className="text-xl font-black">أصناف الفاتورة #{selectedInvoice.slice(0, 8)}</h4>
                  <p className="text-slate-500 dark:text-slate-400 text-xs font-bold">تفاصيل المشتريات والكميات والأسعار</p>
                </div>
                <button 
                  onClick={() => setSelectedInvoice(null)}
                  className="p-3 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-2xl transition-all"
                >
                  <ArrowRight className="w-5 h-5 rotate-180" />
                </button>
              </div>
              <div className="overflow-y-auto flex-1 p-2">
                <table className="w-full text-right border-separate border-spacing-y-2 px-6">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 sticky top-0 z-10">
                    <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
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
    </div>
  );
}

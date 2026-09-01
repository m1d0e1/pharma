import TableScrollContainer from '@/components/ui/TableScrollContainer';
'use client';

import React, { useState, useEffect } from 'react';
import { getPurchaseInvoicesAction, getPurchaseInvoiceDetailsAction, deletePurchaseInvoiceAction } from '@/app/actions-client/purchases';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';
import { Search, Receipt, FileText, ArrowUpRight, CheckCircle2, Clock, Printer, Pencil, X, Trash2, PackageMinus } from 'lucide-react';
import { toast } from 'react-hot-toast';
import Link from 'next/link';
import BarcodePrinter from '@/components/purchases/BarcodePrinter';

function optionalNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function purchaseInvoicePaymentLabel(method: unknown): string {
  if (method === 'cash') return 'نقدي';
  if (method === 'credit') return 'آجل';
  if (method === 'check') return 'شيك';
  return String(method || '-');
}

export function purchaseInvoiceUnitLabel(item: Record<string, unknown>): string {
  const unitId = Number(item.unit_id);
  if (unitId === 1) return 'علبة';
  if (unitId === 2) return 'شريط';
  return String(item.unit || '-');
}

export function purchaseInvoiceDate(value: unknown): string {
  if (!value) return '-';
  const text = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return format(parsed, 'dd MMMM yyyy', { locale: ar });
}

export function purchaseInvoiceLineAmounts(item: Record<string, unknown>) {
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

export default function PurchaseReportsClient() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [drugSearchTerm, setDrugSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedInvoiceForBarcode, setSelectedInvoiceForBarcode] = useState<any[] | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<any | null>(null);
  const [selectedItems, setSelectedItems] = useState<any[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function load() {
      const res = await getPurchaseInvoicesAction();
      if (res.success && res.data) {
        setInvoices(res.data);
      } else {
        toast.error('فشل تحميل تقارير المشتريات');
      }
      setLoading(false);
    }
    load();
  }, []);

  const filteredInvoices = invoices.filter(inv => {
    const matchesSearch = !searchTerm || 
                          inv.invoice_number?.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          inv.supplier_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          inv.id?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesDrug = !drugSearchTerm.trim() || 
                        inv.drug_names?.toLowerCase().includes(drugSearchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || 
                          (statusFilter === 'completed' && inv.status === 'completed') ||
                          (statusFilter === 'pending' && inv.status !== 'completed');
    return matchesSearch && matchesDrug && matchesStatus;
  });

  const totalPurchases = invoices.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0);
  const completedPurchases = invoices.filter(i => i.status === 'completed').reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0);
  const selectedSellingTotal = selectedItems.reduce(
    (sum, item) => sum + Number(item.quantity || 0) * Number(item.selling_price ?? item.base_price ?? 0),
    0
  );
  const selectedLineTotals = selectedItems.reduce((totals, item) => {
    const amounts = purchaseInvoiceLineAmounts(item);
    totals.gross += amounts.gross;
    totals.net += amounts.net;
    return totals;
  }, { gross: 0, net: 0 });
  const selectedInvoiceNet = Number(selectedInvoice?.total_amount || 0);
  const selectedInvoiceGross = optionalNumber(selectedInvoice?.gross_amount)
    ?? (selectedLineTotals.gross + Number(selectedInvoice?.expenses || 0));
  const selectedInvoiceDiscount = optionalNumber(selectedInvoice?.discount_amount)
    ?? Math.max(0, selectedInvoiceGross - selectedInvoiceNet);
  const selectedReconciliation = selectedInvoiceNet - selectedLineTotals.net;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const handlePrintBarcode = async (invoiceId: string) => {
    toast.loading('جاري تحميل بيانات الفاتورة...', { id: 'load-invoice' });
    const res = await getPurchaseInvoiceDetailsAction(invoiceId);
    toast.dismiss('load-invoice');
    
    if (res.success && res.data) {
      // Mapping the data to match BarcodeItem interface
      const items = res.data.map((item: any) => ({
        id: item.drug_id,
        trade_name: item.trade_name,
        trade_name_en: item.trade_name,
        barcode: item.barcode || '000000',
        selling_price: item.selling_price || item.cost_price, // fallback if selling_price is not set
        expiry_date: item.expiry_date
      }));
      setSelectedInvoiceForBarcode(items);
    } else {
      toast.error('فشل في تحميل تفاصيل الفاتورة للطباعة');
    }
  };

  const showInvoice = async (invoice: any) => {
    setSelectedInvoice(invoice);
    setSelectedItems([]);
    setDetailsLoading(true);
    const res = await getPurchaseInvoiceDetailsAction(invoice.id);
    setDetailsLoading(false);
    if (res.success && res.data) setSelectedItems(res.data);
    else toast.error('فشل تحميل تفاصيل فاتورة الشراء');
  };

  const deleteInvoice = async (removeInventory: boolean) => {
    if (!selectedInvoice || !confirm(removeInventory
      ? 'حذف الفاتورة وعكس كمياتها من المخزون وقيودها المحاسبية ورصيد المورد؟'
      : 'حذف سجل الفاتورة فقط؟ ستبقى الكميات في المخزون والقيود المحاسبية ورصيد المورد دون تغيير.')) return;
    setDeleting(true);
    const result = await deletePurchaseInvoiceAction(selectedInvoice.id, removeInventory);
    setDeleting(false);
    if (!result.success) return toast.error(result.error || 'فشل حذف فاتورة الشراء');
    setInvoices(current => current.filter(invoice => invoice.id !== selectedInvoice.id));
    setSelectedInvoice(null);
    toast.success('تم حذف فاتورة الشراء');
  };

  return (
    <div className="space-y-6">
      {selectedInvoiceForBarcode && (
        <BarcodePrinter items={selectedInvoiceForBarcode} onClose={() => setSelectedInvoiceForBarcode(null)} />
      )}
      {selectedInvoice && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-slate-950/60 p-4" onClick={() => setSelectedInvoice(null)}>
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl dark:bg-slate-900" dir="rtl" onClick={e => e.stopPropagation()}>
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-2xl font-black">فاتورة شراء {selectedInvoice.invoice_number || selectedInvoice.id.slice(0, 8)}</h3>
                <p className="mt-1 text-sm text-slate-500">{selectedInvoice.supplier_name} {selectedInvoice.supplier_phone ? `- ${selectedInvoice.supplier_phone}` : ''}</p>
              </div>
              <button onClick={() => setSelectedInvoice(null)} className="rounded-xl p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="إغلاق"><X /></button>
            </div>
            <div className="mb-6 grid grid-cols-2 gap-3 rounded-2xl bg-slate-50 p-4 text-sm dark:bg-slate-800 md:grid-cols-4">
              <div><span className="text-slate-500">تاريخ الفاتورة</span><p className="font-bold">{purchaseInvoiceDate(selectedInvoice.invoice_date || selectedInvoice.created_at)}</p></div>
              <div><span className="text-slate-500">المستخدم</span><p className="font-bold">{selectedInvoice.user_name || '---'}</p></div>
              <div><span className="text-slate-500">الدفع</span><p className="font-bold">{purchaseInvoicePaymentLabel(selectedInvoice.payment_method)}</p></div>
              <div><span className="text-slate-500">الحالة</span><p className="font-bold">{selectedInvoice.status}</p></div>
              <div><span className="text-slate-500">الضريبة</span><p className="font-bold">{Number(selectedInvoice.tax_percent || 0).toFixed(2)}%</p></div>
              <div><span className="text-slate-500">إجمالي قبل الخصم</span><p className="font-bold">{selectedInvoiceGross.toFixed(2)} ج.م</p></div>
              <div><span className="text-slate-500">إجمالي الخصم</span><p className="font-bold text-rose-600">{selectedInvoiceDiscount.toFixed(2)} ج.م</p></div>
              <div><span className="text-slate-500">المصروفات</span><p className="font-bold">{Number(selectedInvoice.expenses || 0).toFixed(2)} ج.م</p></div>
              <div><span className="text-slate-500">صافي الفاتورة</span><p className="font-black text-primary-600">{selectedInvoiceNet.toFixed(2)} ج.م</p></div>
              <div><span className="text-slate-500">إجمالي قيمة البيع</span><p className="font-black text-emerald-600">{selectedSellingTotal.toFixed(2)} ج.م</p></div>
              {selectedInvoice.check_number && <div><span className="text-slate-500">رقم الشيك</span><p className="font-bold">{selectedInvoice.check_number}</p></div>}
              {selectedInvoice.notes && <div className="col-span-2"><span className="text-slate-500">ملاحظات</span><p className="font-bold">{selectedInvoice.notes}</p></div>}
            </div>
            {detailsLoading ? <p className="py-10 text-center text-slate-500">جاري التحميل...</p> : (
              <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-700">
                <table className="w-full text-right text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800"><tr><th className="p-3">الصنف</th><th className="p-3">الباركود</th><th className="p-3">الكمية</th><th className="p-3">المجاني</th><th className="p-3">الصلاحية</th><th className="p-3">سعر الشراء</th><th className="p-3">سعر البيع</th><th className="p-3">الضريبة</th><th className="p-3">إجمالي قبل الخصم</th><th className="p-3">صافي السطر</th></tr></thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{selectedItems.map(item => {
                    const amounts = purchaseInvoiceLineAmounts(item);
                    return <tr key={item.id}><td className="p-3 font-bold">{item.trade_name_en || item.trade_name}</td><td className="p-3">{item.barcode || '---'}</td><td className="p-3">{item.quantity} {purchaseInvoiceUnitLabel(item)}</td><td className="p-3">{item.bonus_quantity || 0}</td><td className="p-3">{purchaseInvoiceDate(item.expiry_date)}</td><td className="p-3 font-bold text-blue-600">{Number(item.cost_price || 0).toFixed(2)}</td><td className="p-3 font-bold text-emerald-600">{Number(item.selling_price ?? item.base_price ?? 0).toFixed(2)}</td><td className="p-3">{Number(item.tax_percent || 0).toFixed(2)}%</td><td className="p-3 font-black">{amounts.gross.toFixed(2)}</td><td className="p-3 font-black text-blue-600">{amounts.net.toFixed(2)}</td></tr>;
                  })}</tbody>
                  {selectedItems.length > 0 && (
                    <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-black dark:border-slate-700 dark:bg-slate-800/70">
                      <tr><td colSpan={8} className="p-3">إجمالي السطور</td><td className="p-3">{selectedLineTotals.gross.toFixed(2)}</td><td className="p-3 text-blue-600">{selectedLineTotals.net.toFixed(2)}</td></tr>
                      <tr><td colSpan={9} className="p-3 text-slate-500">تسوية الفاتورة (ضريبة/خصم/مصروفات)</td><td className="p-3">{selectedReconciliation.toFixed(2)}</td></tr>
                      <tr><td colSpan={9} className="p-3">صافي الفاتورة</td><td className="p-3 text-lg text-primary-600">{selectedInvoiceNet.toFixed(2)}</td></tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
            <div className="mt-6 flex flex-wrap gap-3 border-t border-slate-200 pt-5 dark:border-slate-700">
              <button disabled={deleting} onClick={() => deleteInvoice(false)} className="inline-flex items-center gap-2 rounded-xl bg-amber-100 px-4 py-2.5 font-bold text-amber-800 disabled:opacity-50">
                <Trash2 className="h-4 w-4" /> حذف السجل فقط (إبقاء المخزون والحسابات)
              </button>
              <button disabled={deleting} onClick={() => deleteInvoice(true)} className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 font-bold text-white disabled:opacity-50">
                <PackageMinus className="h-4 w-4" /> حذف وعكس المخزون والحسابات
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-100 dark:border-slate-800 flex items-center gap-4">
          <div className="w-14 h-14 bg-primary-100 dark:bg-primary-900/30 text-primary-600 rounded-2xl flex items-center justify-center shrink-0">
            <Receipt className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-500 mb-1">إجمالي المشتريات</p>
            <p className="text-2xl font-black text-slate-900 dark:text-white">
              {totalPurchases.toFixed(2)} <span className="text-sm text-slate-400">ج.م</span>
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-100 dark:border-slate-800 flex items-center gap-4">
          <div className="w-14 h-14 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 rounded-2xl flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-500 mb-1">المشتريات المكتملة</p>
            <p className="text-2xl font-black text-slate-900 dark:text-white">
              {completedPurchases.toFixed(2)} <span className="text-sm text-slate-400">ج.م</span>
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-100 dark:border-slate-800 flex items-center gap-4">
          <div className="w-14 h-14 bg-blue-100 dark:bg-blue-900/30 text-blue-600 rounded-2xl flex items-center justify-center shrink-0">
            <FileText className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-500 mb-1">عدد الفواتير</p>
            <p className="text-2xl font-black text-slate-900 dark:text-white">
              {invoices.length}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-wrap gap-4 items-center justify-between">
          <h2 className="text-xl font-bold">سجل الفواتير</h2>
          <div className="flex items-center gap-3 w-full md:w-auto flex-wrap">
            <div className="relative flex-1 md:w-64">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-blue-600 dark:text-blue-400" />
              <input 
                type="text"
                placeholder="بحث باسم الصنف / الدواء..."
                value={drugSearchTerm}
                onChange={e => setDrugSearchTerm(e.target.value)}
                className="w-full pr-10 pl-4 py-2.5 bg-blue-50/70 dark:bg-slate-800 border-2 border-blue-200 dark:border-blue-900 rounded-xl focus:ring-2 focus:ring-blue-500 font-bold text-sm text-slate-900 dark:text-white transition-all"
              />
            </div>
            <div className="relative flex-1 md:w-56">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input 
                type="text"
                placeholder="بحث برقم الفاتورة أو المورد..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pr-10 pl-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-primary-500 text-sm transition-all"
              />
            </div>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-primary-500 font-bold text-sm outline-none"
            >
              <option value="all">كل الفواتير</option>
              <option value="completed">المكتملة فقط</option>
              <option value="pending">المعلقة فقط</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 text-slate-500">
                <th className="p-4 font-bold">رقم الفاتورة</th>
                <th className="p-4 font-bold">المورد</th>
                <th className="p-4 font-bold">التاريخ</th>
                <th className="p-4 font-bold">طريقة الدفع</th>
                <th className="p-4 font-bold">الحالة</th>
                <th className="p-4 font-bold">الإجمالي</th>
                <th className="p-4 font-bold text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredInvoices.map((inv) => (
                <tr key={inv.id} tabIndex={0} onClick={() => showInvoice(inv)} onKeyDown={e => { if (e.key === 'Enter') showInvoice(inv); }} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                  <td className="p-4 font-bold text-primary-600">{inv.invoice_number || inv.id.substring(0, 8)}</td>
                  <td className="p-4">{inv.supplier_name || 'غير محدد'}</td>
                  <td className="p-4 text-slate-500">
                    {purchaseInvoiceDate(inv.invoice_date || inv.created_at)}
                  </td>
                  <td className="p-4">
                    <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg text-sm font-bold">
                      {purchaseInvoicePaymentLabel(inv.payment_method)}
                    </span>
                  </td>
                  <td className="p-4">
                    {inv.status === 'completed' ? (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-600 rounded-lg text-sm font-bold">
                        <CheckCircle2 className="w-4 h-4" /> مكتمل
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-600 rounded-lg text-sm font-bold">
                        <Clock className="w-4 h-4" /> معلق
                      </span>
                    )}
                  </td>
                  <td className="p-4 font-bold text-lg">
                    {Number(inv.total_amount || 0).toFixed(2)}
                  </td>
                  <td className="p-4 text-center flex items-center justify-center gap-2">
                    {inv.status !== 'completed' && (
                      <Link
                        href={`/purchases/new?supplier_id=${inv.supplier_id}`}
                        onClick={e => e.stopPropagation()}
                        className="p-2 text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/30 rounded-xl transition-all"
                        title="استكمال الفاتورة"
                      >
                        <ArrowUpRight className="w-5 h-5" />
                      </Link>
                    )}
                    {inv.status === 'completed' && (
                      <Link
                        href={`/purchases/new?edit_invoice_id=${inv.id}`}
                        onClick={e => e.stopPropagation()}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-xl transition-all"
                        title="تعديل الفاتورة المكتملة"
                      >
                        <Pencil className="w-5 h-5" />
                      </Link>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handlePrintBarcode(inv.id); }}
                      className="p-2 text-slate-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/30 rounded-xl transition-all"
                      title="طباعة ملصقات الباركود"
                    >
                      <Printer className="w-5 h-5" />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredInvoices.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500">
                    لا توجد فواتير مطابقة
                  </td>
                </tr>
              )}
            </tbody>
            {filteredInvoices.length > 0 && (
              <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-black dark:border-slate-700 dark:bg-slate-800/70">
                <tr>
                  <td colSpan={5} className="p-4 text-slate-700 dark:text-slate-200 text-sm">
                    الإجمالي ({filteredInvoices.length} فاتورة)
                  </td>
                  <td className="p-4 text-xl font-black text-primary-600 dark:text-primary-400">
                    {filteredInvoices.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0).toFixed(2)} ج.م
                  </td>
                  <td className="p-4"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import { getPurchaseInvoicesAction, getPurchaseInvoiceDetailsAction } from '@/app/actions-client/purchases';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';
import { Search, Filter, Receipt, FileText, ArrowUpRight, CheckCircle2, Clock, Printer } from 'lucide-react';
import { toast } from 'react-hot-toast';
import BarcodePrinter from '@/components/purchases/BarcodePrinter';

export default function PurchaseReportsClient() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedInvoiceForBarcode, setSelectedInvoiceForBarcode] = useState<any[] | null>(null);

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

  const filteredInvoices = invoices.filter(inv => 
    inv.invoice_number?.includes(searchTerm) || 
    inv.supplier_name?.includes(searchTerm) ||
    inv.id?.includes(searchTerm)
  );

  const totalPurchases = invoices.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0);
  const completedPurchases = invoices.filter(i => i.status === 'completed').reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0);

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

  return (
    <div className="space-y-6">
      {selectedInvoiceForBarcode && (
        <BarcodePrinter items={selectedInvoiceForBarcode} onClose={() => setSelectedInvoiceForBarcode(null)} />
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
          <div className="relative w-full md:w-64">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input 
              type="text"
              placeholder="بحث في الفواتير..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pr-10 pl-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl focus:ring-2 focus:ring-primary-500 transition-all"
            />
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
                <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                  <td className="p-4 font-bold text-primary-600">{inv.invoice_number || inv.id.substring(0, 8)}</td>
                  <td className="p-4">{inv.supplier_name || 'غير محدد'}</td>
                  <td className="p-4 text-slate-500">
                    {format(new Date(inv.created_at), 'dd MMMM yyyy', { locale: ar })}
                  </td>
                  <td className="p-4">
                    <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg text-sm font-bold">
                      {inv.payment_method === 'cash' ? 'نقدي' : inv.payment_method === 'credit' ? 'آجل' : 'شيك'}
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
                  <td className="p-4 text-center">
                    <button
                      onClick={() => handlePrintBarcode(inv.id)}
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
          </table>
        </div>
      </div>
    </div>
  );
}

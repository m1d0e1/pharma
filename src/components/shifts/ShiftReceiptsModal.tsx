'use client';

import React, { useState, useEffect } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { 
  X, Printer, Eye, Search, Receipt, 
  ShoppingBag, DollarSign, CreditCard
} from 'lucide-react';
import { getShiftReceiptsAction } from '@/app/actions-client/shifts';
import ReceiptDetailsModal from '@/components/receipts/ReceiptDetailsModal';
import { generateReceiptHtml, printHtmlContent } from '@/lib/utils/printing';
import { getConfigAction } from '@/app/actions-client/config';
import toast from 'react-hot-toast';

interface ShiftReceiptsModalProps {
  isOpen: boolean;
  shiftId: string;
  onClose: () => void;
  shiftTitle?: string;
}

export default function ShiftReceiptsModal({
  isOpen,
  shiftId,
  onClose,
  shiftTitle
}: ShiftReceiptsModalProps) {
  useHotkeys('esc', () => { if (isOpen) onClose(); }, { enableOnFormTags: true });

  const [receipts, setReceipts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState<any | null>(null);
  const [pharmacyInfo, setPharmacyInfo] = useState({ name: 'صيدلية فارما تيك', phone: '', address: '' });

  useEffect(() => {
    async function loadConfig() {
      try {
        const name = await getConfigAction('pharmacy_name');
        const phone = await getConfigAction('pharmacy_phone');
        const address = await getConfigAction('pharmacy_address');
        setPharmacyInfo({
          name: name?.value || 'صيدلية فارما تيك',
          phone: phone?.value || '',
          address: address?.value || ''
        });
      } catch {}
    }
    loadConfig();
  }, []);

  useEffect(() => {
    if (!isOpen || !shiftId) return;

    let isMounted = true;
    async function loadData() {
      setLoading(true);
      try {
        const res = await getShiftReceiptsAction(shiftId);
        if (isMounted) {
          if (res.success) {
            setReceipts(res.data || []);
          } else {
            toast.error(res.error || 'فشل جلب فواتير الوردية');
            setReceipts([]);
          }
        }
      } catch (err) {
        if (isMounted) {
          toast.error('حدث خطأ أثناء تحميل الفواتير');
          setReceipts([]);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadData();
    return () => { isMounted = false; };
  }, [isOpen, shiftId]);

  if (!isOpen) return null;

  const filteredReceipts = receipts.filter((item) => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    const invId = String(item.invoice_number || item.id || '').toLowerCase();
    const patientName = String(item.patient_name || item.patients?.full_name || '').toLowerCase();
    const staffName = String(item.staff_name || item.profiles?.full_name || '').toLowerCase();
    const hasDrug = item.sales_items?.some((s: any) => 
      String(s.trade_name || s.trade_name_en || '').toLowerCase().includes(q)
    );
    return invId.includes(q) || patientName.includes(q) || staffName.includes(q) || hasDrug;
  });

  const totalSalesAmount = receipts.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
  const cashSalesAmount = receipts.filter(r => r.payment_method === 'cash').reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
  const creditSalesAmount = receipts.filter(r => r.payment_method === 'credit').reduce((sum, r) => sum + Number(r.total_amount || 0), 0);

  const handlePrint = (invoice: any) => {
    try {
      const html = generateReceiptHtml(invoice, pharmacyInfo);
      printHtmlContent(html);
    } catch (e) {
      toast.error('فشلت عملية الطباعة');
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in" dir="rtl">
      <div className="w-full max-w-4xl bg-white dark:bg-slate-900 text-slate-900 dark:text-white rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-900 via-blue-800 to-indigo-950 text-white p-5 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/10 rounded-2xl flex items-center justify-center text-blue-200">
              <Receipt className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight">فواتير وإيصالات الوردية</h2>
              <p className="text-xs text-blue-200 font-mono">
                {shiftTitle || `وردية #${shiftId.slice(0, 12).toUpperCase()}`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-rose-600 flex items-center justify-center text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick Stats Bar */}
        <div className="p-4 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0 text-xs">
          <div className="bg-white dark:bg-slate-900 p-3 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-2.5">
            <div className="p-2 bg-blue-50 dark:bg-blue-900/30 text-blue-600 rounded-xl">
              <ShoppingBag className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-bold">عدد الفواتير</p>
              <p className="font-black text-sm">{receipts.length}</p>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 p-3 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-2.5">
            <div className="p-2 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 rounded-xl">
              <DollarSign className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-bold">إجمالي المبيعات</p>
              <p className="font-black text-sm text-emerald-600">{totalSalesAmount.toFixed(2)} ج.م</p>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 p-3 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-2.5">
            <div className="p-2 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 rounded-xl">
              <span className="font-bold text-xs">💵</span>
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-bold">المبيعات النقدية</p>
              <p className="font-black text-sm">{cashSalesAmount.toFixed(2)} ج.م</p>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 p-3 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-2.5">
            <div className="p-2 bg-amber-50 dark:bg-amber-900/30 text-amber-600 rounded-xl">
              <CreditCard className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-bold">المبيعات الآجل</p>
              <p className="font-black text-sm text-amber-600">{creditSalesAmount.toFixed(2)} ج.م</p>
            </div>
          </div>
        </div>

        {/* Search Bar */}
        <div className="p-4 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="relative">
            <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="بحث برقم الفاتورة أو اسم العميل أو اسم الصنف..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pr-10 pl-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-xs font-bold outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Content List / Table */}
        <div className="p-4 overflow-y-auto flex-1 custom-scrollbar">
          {loading ? (
            <div className="py-20 text-center text-slate-400 font-bold animate-pulse text-sm">
              جاري تحميل فواتير الوردية...
            </div>
          ) : filteredReceipts.length === 0 ? (
            <div className="py-20 text-center space-y-2">
              <div className="text-4xl">🧾</div>
              <p className="text-slate-500 dark:text-slate-400 font-bold text-sm">
                {searchTerm ? 'لا توجد فواتير مطابقة للبحث' : 'لا توجد فواتير مبيعات مسجلة في هذه الوردية'}
              </p>
            </div>
          ) : (
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
              <div className="grid grid-cols-12 bg-slate-50 dark:bg-slate-800/80 p-3 text-xs font-black text-slate-500 select-none">
                <span className="col-span-2 text-center">رقم الفاتورة</span>
                <span className="col-span-2 text-center">التاريخ والوقت</span>
                <span className="col-span-3">العميل</span>
                <span className="col-span-2 text-center">طريقة الدفع</span>
                <span className="col-span-1 text-center">الأصناف</span>
                <span className="col-span-1 text-left">الإجمالي</span>
                <span className="col-span-1 text-center">الإجراءات</span>
              </div>

              {filteredReceipts.map((inv) => (
                <div
                  key={inv.id}
                  className="grid grid-cols-12 p-3 text-xs font-bold items-center hover:bg-blue-50/40 dark:hover:bg-slate-800/50 transition-colors"
                >
                  <span className="col-span-2 text-center font-mono font-bold text-slate-700 dark:text-slate-300">
                    #{inv.invoice_number || inv.id.slice(0, 8).toUpperCase()}
                  </span>

                  <span className="col-span-2 text-center text-slate-500 text-[11px] font-mono">
                    {inv.created_at ? new Date(inv.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '---'}
                  </span>

                  <div className="col-span-3">
                    <span className="font-bold text-slate-800 dark:text-slate-200 block truncate">
                      {inv.patient_name || inv.patients?.full_name || 'عميل نقدي'}
                    </span>
                    {(inv.patient_phone || inv.patients?.phone) && (
                      <span className="text-[10px] text-slate-400 font-mono block">
                        {inv.patient_phone || inv.patients?.phone}
                      </span>
                    )}
                  </div>

                  <span className="col-span-2 text-center">
                    <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-black ${
                      inv.payment_method === 'cash'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : inv.payment_method === 'credit'
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                        : inv.payment_method === 'visa'
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                        : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    }`}>
                      {inv.payment_method === 'cash' ? 'نقدي' : inv.payment_method === 'credit' ? 'آجل' : inv.payment_method === 'visa' ? 'فيزا' : inv.payment_method}
                    </span>
                  </span>

                  <span className="col-span-1 text-center font-bold text-slate-500">
                    {inv.sales_items?.length || 0}
                  </span>

                  <span className="col-span-1 text-left font-mono font-black text-slate-900 dark:text-white">
                    {Number(inv.total_amount || 0).toFixed(2)}
                  </span>

                  <div className="col-span-1 flex items-center justify-center gap-1.5">
                    <button
                      onClick={() => setSelectedInvoice(inv)}
                      className="p-1.5 hover:bg-blue-100 dark:hover:bg-slate-700 text-blue-600 rounded-lg transition-colors"
                      title="عرض تفاصيل الفاتورة"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handlePrint(inv)}
                      className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg transition-colors"
                      title="طباعة سريعة"
                    >
                      <Printer className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center shrink-0">
          <span className="text-xs font-bold text-slate-500">
            عدد الفواتير المعروضة: {filteredReceipts.length} من أصل {receipts.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition-all shadow"
          >
            إغلاق
          </button>
        </div>
      </div>

      {/* Invoice Details Modal */}
      {selectedInvoice && (
        <ReceiptDetailsModal
          invoice={selectedInvoice}
          onClose={() => setSelectedInvoice(null)}
        />
      )}
    </div>
  );
}

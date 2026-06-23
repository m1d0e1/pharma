'use client';

import React, { useState, useEffect } from 'react';
import { 
  Bike, CheckCircle, Clock, MapPin, 
  Phone, User, DollarSign, ArrowRight,
  Search, Filter, Receipt
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPendingDeliveriesAction, closeDeliveryInvoiceAction } from '@/app/actions-client/delivery';
import toast from 'react-hot-toast';
import { format } from 'date-fns';

export default function DeliveryManagementClient() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [deliveryFees, setDeliveryFees] = useState<Record<string, number>>({});

  const loadDeliveries = async () => {
    setLoading(true);
    const res = await getPendingDeliveriesAction();
    if (res.success) setInvoices(res.data || []);
    setLoading(false);
  };

  useEffect(() => {
    loadDeliveries();
  }, []);

  const handleClose = async (invoiceId: string) => {
    const fee = deliveryFees[invoiceId] || 0;
    setClosingId(invoiceId);
    const res = await closeDeliveryInvoiceAction(invoiceId, fee);
    if (res.success) {
      toast.success('تم إغلاق الفاتورة وتأكيد التوصيل');
      loadDeliveries();
    } else {
      toast.error(res.error || 'فشل إغلاق الفاتورة');
    }
    setClosingId(null);
  };

  return (
    <div className="space-y-8 pb-20" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-800 dark:text-white flex items-center gap-4">
            <Bike className="w-10 h-10 text-rose-500" />
            إغلاق فواتير التوصيل المنزلي
          </h1>
          <p className="text-slate-500 font-bold">متابعة وإغلاق الفواتير التي تم إرسالها مع المناديب</p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-left">
            <p className="text-[10px] font-black text-slate-400 uppercase">قيد التوصيل</p>
            <p className="text-2xl font-black text-rose-600">{invoices.length}</p>
          </div>
          <button 
            onClick={loadDeliveries}
            className="p-4 bg-slate-50 dark:bg-slate-800 text-slate-500 rounded-2xl hover:bg-slate-100 transition-all"
          >
            <Clock className={cn("w-6 h-6", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {invoices.length === 0 && !loading ? (
        <div className="bg-white dark:bg-slate-900 p-20 rounded-[40px] border border-slate-100 dark:border-slate-800 text-center space-y-4">
          <div className="w-20 h-20 bg-emerald-50 dark:bg-emerald-900/20 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle className="w-10 h-10 text-emerald-500" />
          </div>
          <h3 className="text-xl font-black text-slate-800 dark:text-white">لا توجد طلبات توصيل معلقة</h3>
          <p className="text-slate-400 font-bold">تم إغلاق جميع فواتير التوصيل المنزلي بنجاح</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {invoices.map((inv) => (
            <div key={inv.id} className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm hover:shadow-xl transition-all group border-b-4 border-b-rose-500/20">
              <div className="p-8 space-y-6">
                <div className="flex justify-between items-start">
                  <div className="p-4 bg-rose-50 dark:bg-rose-900/20 rounded-2xl">
                    <Bike className="w-6 h-6 text-rose-600" />
                  </div>
                  <div className="text-left">
                    <p className="text-[10px] font-black text-slate-400"># {inv.id.slice(0, 8)}</p>
                    <p className="text-xs font-bold text-slate-500">{format(new Date(inv.created_at), 'HH:mm | yyyy/MM/dd')}</p>
                  </div>
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-50 dark:border-slate-800">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
                      <User className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-black text-slate-800 dark:text-white">{inv.patient_name}</p>
                      <p className="text-xs font-bold text-slate-400">{inv.patient_phone}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-slate-500">
                    <MapPin className="w-5 h-5 text-rose-400 shrink-0" />
                    <p className="text-xs font-bold leading-relaxed">{inv.patient_address || 'لم يتم تسجيل العنوان'}</p>
                  </div>
                </div>

                <div className="p-6 bg-slate-50 dark:bg-slate-800/50 rounded-3xl space-y-3">
                  <div className="flex justify-between items-center text-[10px] font-black text-slate-400 uppercase">
                    <span>قيمة الفاتورة</span>
                    <span className="text-lg text-slate-800 dark:text-white">{inv.total_amount.toLocaleString()} ج.م</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-black text-slate-400 uppercase">خدمة التوصيل</span>
                    <div className="relative w-24">
                      <input 
                        type="number" 
                        className="w-full pl-3 pr-8 py-2 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-black text-xs outline-none focus:ring-2 ring-rose-500"
                        value={deliveryFees[inv.id] || ''}
                        onChange={(e) => setDeliveryFees({...deliveryFees, [inv.id]: parseFloat(e.target.value) || 0})}
                        placeholder="0.00"
                      />
                      <DollarSign className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
                    </div>
                  </div>
                </div>

                <button 
                  onClick={() => handleClose(inv.id)}
                  disabled={closingId === inv.id}
                  className={cn(
                    "w-full py-5 bg-slate-900 text-white rounded-[24px] font-black flex items-center justify-center gap-3 hover:bg-slate-800 transition-all shadow-xl shadow-slate-500/20",
                    closingId === inv.id && "opacity-50"
                  )}
                >
                  <CheckCircle className="w-6 h-6" /> إغلاق وتأكيد (F10)
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

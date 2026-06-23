'use client';

import React, { useState, useEffect } from 'react';
import { 
  CheckCircle2, AlertCircle, ShoppingBag, 
  DollarSign, ArrowRight, RefreshCcw, 
  Search, PackageSearch
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getNegativeStockInvoicesAction, settleNegativeStockAction } from '@/app/actions-client/settlement';
import toast from 'react-hot-toast';
import { format } from 'date-fns';

export default function NegativeStockSettlementClient() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [settlingId, setSettlingId] = useState<number | null>(null);
  const [costPrices, setCostPrices] = useState<Record<number, number>>({});

  const loadItems = async () => {
    setLoading(true);
    const res = await getNegativeStockInvoicesAction();
    if (res.success) setItems(res.data || []);
    setLoading(false);
  };

  useEffect(() => {
    loadItems();
  }, []);

  const handleSettle = async (itemId: number) => {
    const cost = costPrices[itemId];
    if (!cost || cost <= 0) {
      toast.error('يرجى إدخال سعر التكلفة الصحيح');
      return;
    }

    setSettlingId(itemId);
    const res = await settleNegativeStockAction(itemId, cost);
    if (res.success) {
      toast.success('تمت التسوية بنجاح');
      loadItems();
    } else {
      toast.error(res.error || 'فشل عملية التسوية');
    }
    setSettlingId(null);
  };

  return (
    <div className="space-y-8 pb-20" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-800 dark:text-white flex items-center gap-4">
            <PackageSearch className="w-10 h-10 text-rose-500" />
            تسوية أصناف مباعة بدون رصيد
          </h1>
          <p className="text-slate-500 font-bold">معالجة الأصناف التي تم بيعها قبل إضافتها للمخزون بشكل رسمي</p>
        </div>
        <button 
          onClick={loadItems}
          className="p-4 bg-slate-50 dark:bg-slate-800 text-slate-500 rounded-2xl hover:bg-slate-100 transition-all"
        >
          <RefreshCcw className={cn("w-6 h-6", loading && "animate-spin")} />
        </button>
      </div>

      {items.length === 0 && !loading ? (
        <div className="bg-white dark:bg-slate-900 p-20 rounded-[40px] border border-slate-100 dark:border-slate-800 text-center space-y-4">
          <div className="w-20 h-20 bg-emerald-50 dark:bg-emerald-900/20 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
          </div>
          <h3 className="text-xl font-black text-slate-800 dark:text-white">لا توجد أصناف تحتاج لتسوية</h3>
          <p className="text-slate-400 font-bold">جميع المبيعات تمت برصيد مخزني كافٍ</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
          <table className="w-full text-right">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                <th className="px-8 py-6">رقم الفاتورة</th>
                <th className="px-8 py-6">التاريخ</th>
                <th className="px-8 py-6">الصنف</th>
                <th className="px-8 py-6">الكمية المباعة</th>
                <th className="px-8 py-6">سعر البيع</th>
                <th className="px-8 py-6 w-48">سعر التكلفة الحالي</th>
                <th className="px-8 py-6 text-left">الإجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {loading ? (
                <tr><td colSpan={7} className="py-20 text-center animate-pulse font-bold text-slate-400">جاري التحميل...</td></tr>
              ) : items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                  <td className="px-8 py-6">
                    <span className="font-mono font-black text-blue-600">#{item.invoice_id.slice(0, 8)}</span>
                  </td>
                  <td className="px-8 py-6 font-bold text-slate-500">
                    {format(new Date(item.invoice_date), 'yyyy/MM/dd HH:mm')}
                  </td>
                  <td className="px-8 py-6">
                    <p className="font-black text-slate-800 dark:text-white">{item.trade_name}</p>
                    <p className="text-[10px] text-slate-400 font-mono">{item.barcode}</p>
                  </td>
                  <td className="px-8 py-6 font-black text-rose-600 text-lg">{item.quantity_sold}</td>
                  <td className="px-8 py-6 font-bold">{item.unit_price.toLocaleString()}</td>
                  <td className="px-8 py-6">
                    <div className="relative">
                      <DollarSign className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input 
                        type="number" 
                        step="0.01"
                        placeholder="أدخل التكلفة..."
                        className="w-full pr-10 pl-3 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-xl font-black outline-none focus:ring-2 ring-blue-500"
                        value={costPrices[item.id] || ''}
                        onChange={(e) => setCostPrices({...costPrices, [item.id]: parseFloat(e.target.value) || 0})}
                      />
                    </div>
                  </td>
                  <td className="px-8 py-6 text-left">
                    <button 
                      onClick={() => handleSettle(item.id)}
                      disabled={settlingId === item.id}
                      className={cn(
                        "px-6 py-3 bg-slate-900 text-white rounded-xl font-black text-xs hover:bg-slate-800 transition-all shadow-lg flex items-center gap-2",
                        settlingId === item.id && "opacity-50"
                      )}
                    >
                      {settlingId === item.id ? 'جاري الحفظ...' : 'إتمام التسوية'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

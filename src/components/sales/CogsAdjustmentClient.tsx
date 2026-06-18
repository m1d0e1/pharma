'use client';

import React, { useState } from 'react';
import { 
  Edit3, Search, DollarSign, 
  TrendingDown, TrendingUp, History,
  Save, AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions/cogs';
import { toast } from 'sonner';
import { format } from 'date-fns';

export default function CogsAdjustmentClient() {
  const [searchTerm, setSearchTerm] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [adjustingId, setAdjustingId] = useState<number | null>(null);
  const [newCosts, setNewCosts] = useState<Record<number, number>>({});

  const handleSearch = async () => {
    setLoading(true);
    const res = await getSoldItemsForCogsAdjustmentAction(searchTerm);
    if (res.success) setItems(res.data || []);
    setLoading(false);
  };

  const handleUpdate = async (itemId: number) => {
    const cost = newCosts[itemId];
    if (!cost || cost <= 0) {
      toast.error('يرجى إدخال تكلفة صحيحة');
      return;
    }

    setAdjustingId(itemId);
    const res = await updateSoldItemCostAction(itemId, cost);
    if (res.success) {
      toast.success('تم تعديل تكلفة الصنف المباع بنجاح');
      handleSearch();
    } else {
      toast.error(res.error || 'فشل التعديل');
    }
    setAdjustingId(null);
  };

  return (
    <div className="space-y-8 pb-20" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
        <h1 className="text-3xl font-black text-slate-800 dark:text-white flex items-center gap-4">
          <Edit3 className="w-10 h-10 text-blue-500" />
          تعديل تكلفة الأصناف المباعة
        </h1>
        <p className="text-slate-500 font-bold mt-2">تصحيح تكلفة الشراء للأصناف بعد إتمام عملية البيع لأغراض محاسبية</p>
        
        <div className="mt-8 flex gap-4">
          <div className="relative flex-1">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-400" />
            <input 
              type="text" 
              className="w-full pr-14 pl-6 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none focus:ring-2 ring-blue-500"
              placeholder="ابحث باسم الصنف أو رقم الفاتورة..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
          </div>
          <button 
            onClick={handleSearch}
            className="px-10 py-4 bg-slate-900 text-white rounded-2xl font-black hover:bg-slate-800 transition-all"
          >
            بحث
          </button>
        </div>
      </div>

      {items.length > 0 ? (
        <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
          <table className="w-full text-right">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                <th className="px-8 py-6">الصنف والفاتورة</th>
                <th className="px-8 py-6">التاريخ</th>
                <th className="px-8 py-6">سعر البيع</th>
                <th className="px-8 py-6">التكلفة المسجلة</th>
                <th className="px-8 py-6">هامش الربح الحالي</th>
                <th className="px-8 py-6 w-48">التكلفة الجديدة</th>
                <th className="px-8 py-6 text-left">حفظ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((item) => {
                const profit = item.unit_price - item.current_inv_cost;
                const profitMargin = (profit / item.unit_price) * 100;
                
                return (
                  <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                    <td className="px-8 py-6">
                      <p className="font-black text-slate-800 dark:text-white">{item.trade_name}</p>
                      <p className="text-[10px] font-mono text-blue-500 font-bold">INV #{item.invoice_id.slice(0, 8)}</p>
                    </td>
                    <td className="px-8 py-6 font-bold text-slate-400 text-xs">
                      {format(new Date(item.invoice_date), 'yyyy/MM/dd')}
                    </td>
                    <td className="px-8 py-6 font-black">{item.unit_price.toLocaleString()}</td>
                    <td className="px-8 py-6 font-bold text-slate-500">{item.current_inv_cost.toLocaleString()}</td>
                    <td className="px-8 py-6">
                      <div className="flex items-center gap-2">
                        {profit >= 0 ? <TrendingUp className="w-4 h-4 text-emerald-500" /> : <TrendingDown className="w-4 h-4 text-rose-500" />}
                        <span className={cn("font-black", profit >= 0 ? "text-emerald-600" : "text-rose-600")}>
                          %{profitMargin.toFixed(1)}
                        </span>
                      </div>
                    </td>
                    <td className="px-8 py-6">
                      <div className="relative">
                        <DollarSign className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input 
                          type="number" 
                          step="0.01"
                          className="w-full pr-10 pl-3 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-xl font-black outline-none focus:ring-2 ring-blue-500"
                          value={newCosts[item.id] || ''}
                          onChange={(e) => setNewCosts({...newCosts, [item.id]: parseFloat(e.target.value) || 0})}
                        />
                      </div>
                    </td>
                    <td className="px-8 py-6 text-left">
                      <button 
                        onClick={() => handleUpdate(item.id)}
                        disabled={adjustingId === item.id}
                        className={cn(
                          "p-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all shadow-lg",
                          adjustingId === item.id && "opacity-50"
                        )}
                      >
                        <Save className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : !loading && searchTerm && (
        <div className="p-20 text-center bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 text-slate-400 font-bold italic">
          لم يتم العثور على نتائج للبحث...
        </div>
      )}
    </div>
  );
}

'use client';

import React, { useState, useMemo } from 'react';
import { 
  Search, 
  ArrowLeft, 
  ShoppingCart, 
  ExternalLink,
  TrendingDown,
  Printer,
  Package,
  AlertCircle,
  ClipboardList,
  Loader2
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'react-hot-toast';
import { addToShortagesAction } from '@/app/actions-client/shortages';

export interface LowStockItem {
  id: string | number;
  drug_id: number;
  quantity: number;
  local_selling_price: number;
  expiry_date?: string;
  trade_name: string;
  trade_name_en?: string;
  active_ingredient: string;
  official_price: number;
  manufacturer: string;
  barcode?: string;
  reorder_point?: number;
  default_purchase_qty?: number;
  avg_monthly_usage?: number;
  deficit?: number;
  status?: 'out_of_stock' | 'critical' | 'low';
}

interface Props {
  initialItems: LowStockItem[];
}

export default function LowStockClient({ initialItems }: Props) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'out_of_stock' | 'critical' | 'low'>('all');
  const [savingDrugId, setSavingDrugId] = useState<number | null>(null);

  const filteredItems = useMemo(() => {
    return initialItems.filter(item => {
      const matchesSearch = 
        item.trade_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.trade_name_en && item.trade_name_en.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (item.active_ingredient && item.active_ingredient.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (item.manufacturer && item.manufacturer.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (item.barcode && item.barcode.toLowerCase().includes(searchTerm.toLowerCase()));

      if (!matchesSearch) return false;

      if (filterStatus === 'out_of_stock') return Number(item.quantity || 0) <= 0;
      if (filterStatus === 'critical') return Number(item.quantity || 0) > 0 && item.status === 'critical';
      if (filterStatus === 'low') return Number(item.quantity || 0) > 0 && item.status !== 'critical';

      return true;
    });
  }, [initialItems, searchTerm, filterStatus]);

  const outOfStockCount = useMemo(() => initialItems.filter(i => Number(i.quantity || 0) <= 0).length, [initialItems]);
  const criticalCount = useMemo(() => initialItems.filter(i => Number(i.quantity || 0) > 0 && i.status === 'critical').length, [initialItems]);

  const handlePrint = () => {
    window.print();
  };

  const addToNotebook = async (item: LowStockItem) => {
    const suggestedQuantity = Math.ceil(Math.max(
      Number(item.default_purchase_qty || 1),
      Number(item.deficit || 0),
      Number(item.avg_monthly_usage || 0),
    ));

    setSavingDrugId(item.drug_id);
    try {
      const result = await addToShortagesAction({ drug_id: item.drug_id, qty: suggestedQuantity });
      if (!result.success) throw new Error(result.error || 'فشل الإضافة');
      toast.success((result.data as any)?.created ? 'تمت الإضافة إلى كشكول النواقص' : 'الصنف موجود وتم تحديث كميته');
    } catch (error: any) {
      toast.error(error.message || 'فشل الإضافة إلى كشكول النواقص');
    } finally {
      setSavingDrugId(null);
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      {/* Search, Status Tabs & Actions Bar */}
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between no-print">
        <div className="relative flex-1 group w-full">
          <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
          <input 
            type="text"
            placeholder="بحث بالاسم، الباركود، المادة الفعالة، أو الشركة المصنعة..."
            className="w-full pr-14 pl-6 py-4 bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm focus:ring-4 focus:ring-blue-500/5 outline-none transition-all font-bold text-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto shrink-0">
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-2xl text-xs font-black">
            <button
              onClick={() => setFilterStatus('all')}
              className={`px-4 py-2 rounded-xl transition-all ${filterStatus === 'all' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500'}`}
            >
              الكل ({initialItems.length})
            </button>
            <button
              onClick={() => setFilterStatus('out_of_stock')}
              className={`px-4 py-2 rounded-xl transition-all ${filterStatus === 'out_of_stock' ? 'bg-red-500 text-white shadow-sm' : 'text-red-500'}`}
            >
              منتهية ({outOfStockCount})
            </button>
            <button
              onClick={() => setFilterStatus('critical')}
              className={`px-4 py-2 rounded-xl transition-all ${filterStatus === 'critical' ? 'bg-amber-500 text-white shadow-sm' : 'text-amber-600'}`}
            >
              حرجة ({criticalCount})
            </button>
          </div>

          <button 
            onClick={handlePrint}
            className="px-5 py-3.5 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm hover:bg-slate-50 transition-all flex items-center gap-2 font-black text-xs"
          >
            <Printer className="w-4 h-4" />
            <span>طباعة</span>
          </button>
          
          <Link 
            href="/inventory"
            className="px-5 py-3.5 bg-blue-600 text-white rounded-2xl shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all flex items-center gap-2 font-black text-xs whitespace-nowrap"
          >
            <ArrowLeft className="w-4 h-4 rotate-180" />
            <span>المخزون</span>
          </Link>
        </div>
      </div>

      {/* Grid Layout for Low Stock Items */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredItems.map((item) => {
          const isZero = Number(item.quantity || 0) <= 0;
          const reorderLimit = Number(item.reorder_point || 10);
          const deficit = Math.max(0, reorderLimit - Number(item.quantity || 0));

          return (
            <div 
              key={item.id || item.drug_id} 
              className={`group bg-white dark:bg-slate-900 p-6 rounded-[2.5rem] border shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all relative overflow-hidden flex flex-col justify-between ${
                isZero 
                  ? 'border-red-200 dark:border-red-900/40 border-t-8 border-t-red-600' 
                  : item.status === 'critical' 
                    ? 'border-amber-200 dark:border-amber-900/40 border-t-8 border-t-amber-500' 
                    : 'border-slate-100 dark:border-slate-800 border-t-8 border-t-blue-500'
              }`}
            >
              <div>
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-2">
                    <div className={`p-2.5 rounded-2xl ${
                      isZero ? 'bg-red-50 text-red-600 dark:bg-red-900/20' : 'bg-amber-50 text-amber-600 dark:bg-amber-900/20'
                    }`}>
                      <TrendingDown className="w-5 h-5" />
                    </div>
                    <div>
                      <span className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black ${
                        isZero 
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' 
                          : item.status === 'critical' 
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                            : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                      }`}>
                        {isZero ? 'نفد من المخزون (0)' : item.status === 'critical' ? 'مستوى حرج' : 'تحت حد الطلب'}
                      </span>
                    </div>
                  </div>

                  <div className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700 text-left">
                    <span className="text-[10px] font-bold text-slate-400 block">الرصيد / الحد</span>
                    <span className={`text-base font-black ${isZero ? 'text-red-600' : 'text-amber-600'}`}>
                      {item.quantity} <span className="text-xs text-slate-400">/ {reorderLimit}</span>
                    </span>
                  </div>
                </div>

                <div className="space-y-1 mb-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-black text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors leading-tight">
                      {item.trade_name_en || item.trade_name}
                    </h3>
                    {item.barcode && (
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono text-[9px] font-bold">
                        {item.barcode}
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-bold text-slate-400 truncate">{item.active_ingredient || '---'}</p>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-4 border-t border-slate-50 dark:border-slate-800 text-xs">
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase">الشركة</p>
                    <p className="font-bold text-slate-700 dark:text-slate-300 truncate">{item.manufacturer || 'غير مسجل'}</p>
                  </div>
                  <div className="text-left">
                    <p className="text-[10px] font-black text-slate-400 uppercase">العجز المقدر</p>
                    <p className="font-black text-red-600">{deficit} وحدة</p>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex gap-2 no-print">
                <button
                  onClick={() => addToNotebook(item)}
                  disabled={savingDrugId === item.drug_id}
                  className="flex-1 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/20 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-400 py-2.5 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  {savingDrugId === item.drug_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ClipboardList className="w-3.5 h-3.5" />}
                  <span>إضافة للكشكول</span>
                </button>
                <Link 
                  href={`/purchases/new?drugId=${item.drug_id}`}
                  className="flex-1 bg-primary-600 hover:bg-primary-700 text-white py-2.5 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-1.5 shadow-md shadow-primary-500/20 active:scale-95"
                >
                  <ShoppingCart className="w-3.5 h-3.5" />
                  <span>طلب شراء</span>
                </Link>
                <Link 
                  href={`/inventory?search=${encodeURIComponent(item.barcode || item.trade_name_en || item.trade_name)}`}
                  className="p-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-xl transition-all flex items-center justify-center"
                  title="عرض بالمخزون"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          );
        })}

        {filteredItems.length === 0 && (
          <div className="col-span-full py-20 bg-white dark:bg-slate-900 rounded-[3rem] border-2 border-dashed border-slate-100 dark:border-slate-800 flex flex-col items-center justify-center gap-4 text-slate-300">
            <Package className="w-20 h-20 opacity-20" />
            <p className="text-2xl font-black italic">لا توجد نواقص تطابق بحثك</p>
          </div>
        )}
      </div>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          .no-print, nav, button, .flex-col-md-row { display: none !important; }
          .bg-white { border: none !important; }
          body { background: white !important; font-size: 12pt; }
          .grid { display: block !important; }
          .group { border: 1px solid #eee !important; margin-bottom: 10px !important; break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}

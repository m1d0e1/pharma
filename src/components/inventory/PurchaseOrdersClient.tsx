'use client';

import React, { useState } from 'react';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';
import { Search, Filter, Eye, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { updatePurchaseOrderStatusAction } from '@/app/actions-client/purchases';
import { toast } from 'react-hot-toast';

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: any }> = {
  pending: { label: 'قيد الانتظار', color: 'text-amber-600', bg: 'bg-amber-100', icon: Clock },
  completed: { label: 'تم الاستلام', color: 'text-emerald-600', bg: 'bg-emerald-100', icon: CheckCircle2 },
  cancelled: { label: 'تم الإلغاء', color: 'text-red-600', bg: 'bg-red-100', icon: XCircle },
};

interface Props {
  initialOrders: any[];
}

export default function PurchaseOrdersClient({ initialOrders }: Props) {
  const [orders, setOrders] = useState(initialOrders);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  const filtered = orders.filter((o: any) => {
    const matchSearch = o.id.toLowerCase().includes(search.toLowerCase()) || 
                       o.supplier_name?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filter === 'all' || o.status === filter;
    return matchSearch && matchStatus;
  });

  const handleStatusUpdate = async (poId: string, newStatus: string) => {
    const result = await updatePurchaseOrderStatusAction(poId, newStatus);
    if (result.success) {
      toast.success('تم تحديث حالة الطلب');
      setOrders(orders.map(o => o.id === poId ? { ...o, status: newStatus } : o));
    } else {
      toast.error(result.error || 'فشل التحديث');
    }
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="بحث برقم الطلب أو اسم المورد..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pr-10 pl-4 py-3 rounded-xl text-sm font-bold"
          />
        </div>
        <div className="flex gap-2">
          {['all', 'pending', 'completed', 'cancelled'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
                filter === f 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-500 hover:bg-slate-100'
              }`}
            >
              {f === 'all' ? 'الكل' : STATUS_CONFIG[f]?.label}
            </button>
          ))}
        </div>
      </div>

      {/* Orders List */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden">
        <table className="w-full text-right">
          <thead>
            <tr className="bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
              <th className="px-6 py-4 text-xs font-black text-slate-400">رقم الطلب</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400">المورد</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400 text-center">عدد الأصناف</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400 text-center">الإجمالي التقديري</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400 text-center">الحالة</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400 text-center">التاريخ</th>
              <th className="px-6 py-4 text-xs font-black text-slate-400">الإجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-20 text-center text-slate-400 font-bold">لا توجد أوامر شراء مطابقة</td>
              </tr>
            ) : (
              filtered.map((order: any) => {
                const config = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;
                const Icon = config.icon;
                return (
                  <tr key={order.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                    <td className="px-6 py-4">
                      <span className="font-black text-blue-600">{order.id}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-bold">{order.supplier_name || 'غير محدد'}</span>
                    </td>
                    <td className="px-6 py-4 text-center font-bold">
                      {order.item_count}
                    </td>
                    <td className="px-6 py-4 text-center font-black">
                      {order.total_amount.toLocaleString()} <span className="text-[10px]">ج.م</span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black ${config.bg} ${config.color}`}>
                        <Icon className="w-3 h-3" />
                        {config.label}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center text-xs text-slate-500 font-bold">
                      {format(new Date(order.created_at), 'dd MMM yyyy', { locale: ar })}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {order.status === 'pending' && (
                          <>
                            <button 
                              onClick={() => handleStatusUpdate(order.id, 'completed')}
                              className="p-2 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100"
                              title="تم الاستلام"
                            >
                              <CheckCircle2 className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => handleStatusUpdate(order.id, 'cancelled')}
                              className="p-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100"
                              title="إلغاء الطلب"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        <button className="p-2 bg-slate-50 text-slate-600 rounded-lg hover:bg-slate-100">
                          <Eye className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

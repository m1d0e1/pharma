'use client';

import React, { useState, useEffect } from 'react';
import { Search, Plus, ArrowRightLeft, X } from 'lucide-react';
import Link from 'next/link';
import { getReturnsAction } from '@/app/actions-client/returns';
import { getPurchaseReturnDetailsAction, getPurchaseReturnsAction } from '@/app/actions-client/purchases';
import { format } from 'date-fns';

export default function ReturnsClient({ title, type = 'sales' }: { title: string, type?: 'sales' | 'purchases' }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [returns, setReturns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedReturn, setSelectedReturn] = useState<any>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const newReturnLink = type === 'sales' ? '/returns/new' : '/purchases/returns/new';
  const placeholderText = type === 'sales' ? 'بحث برقم المرتجع أو الفاتورة...' : 'بحث برقم المرتجع أو المورد...';

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      if (type === 'sales') {
        const res = await getReturnsAction();
        if (res.success && res.data) {
          setReturns(res.data);
        }
      } else {
        const res = await getPurchaseReturnsAction();
        if (res.success && res.data) {
          setReturns(res.data);
        }
      }
      setLoading(false);
    }
    fetchData();
  }, [type]);

  const filteredReturns = returns.filter(r => 
    r.id?.includes(searchTerm) || 
    r.invoice_id?.includes(searchTerm) ||
    (type === 'purchases' ? r.supplier_name?.includes(searchTerm) : false)
  );

  const openPurchaseReturn = async (id: string) => {
    if (type !== 'purchases') return;
    setDetailsLoading(true);
    const res = await getPurchaseReturnDetailsAction(id);
    setDetailsLoading(false);
    if (res.success) setSelectedReturn(res.data);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{title}</h1>
          <p className="text-slate-500 text-sm mt-1">سجل المرتجعات وإدارتها</p>
        </div>
        
        <Link href={newReturnLink} className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl transition-colors font-bold text-sm">
          <Plus className="w-4 h-4" />
          إضافة مرتجع
        </Link>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-wrap gap-4 items-center justify-between">
          <div className="relative w-full md:w-96">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input 
              type="text"
              placeholder={placeholderText}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pr-10 pl-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl focus:ring-2 focus:ring-primary-500 transition-all"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500 mb-4"></div>
            <p className="text-slate-500">جاري تحميل المرتجعات...</p>
          </div>
        ) : filteredReturns.length === 0 ? (
          <div className="p-12 text-center flex flex-col items-center justify-center">
            <div className="w-20 h-20 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
              <ArrowRightLeft className="w-10 h-10 text-slate-400" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">لا توجد مرتجعات</h3>
            <p className="text-slate-500 max-w-sm mx-auto mb-6">
              لم تقم بإنشاء أي مرتجعات بعد. يمكنك البدء بإضافة أول مرتجع.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400">
                <tr>
                  <th className="px-6 py-4 font-medium">رقم المرتجع</th>
                  <th className="px-6 py-4 font-medium">رقم الفاتورة</th>
                  {type === 'purchases' && <th className="px-6 py-4 font-medium">المورد</th>}
                  <th className="px-6 py-4 font-medium">المستخدم</th>
                  <th className="px-6 py-4 font-medium">الإجمالي</th>
                  <th className="px-6 py-4 font-medium">التاريخ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredReturns.map((r, i) => (
                  <tr
                    key={i}
                    onClick={() => openPurchaseReturn(r.id)}
                    onKeyDown={e => e.key === 'Enter' && openPurchaseReturn(r.id)}
                    tabIndex={type === 'purchases' ? 0 : undefined}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${type === 'purchases' ? 'cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500' : ''}`}
                  >
                    <td className="px-6 py-4 font-medium text-slate-900 dark:text-white">{r.id?.substring(0, 8)}</td>
                    <td className="px-6 py-4 text-slate-500">{type === 'purchases' ? (r.invoice_number || r.purchase_invoice_id?.substring(0, 8)) : r.invoice_id?.substring(0, 8)}</td>
                    {type === 'purchases' && <td className="px-6 py-4 text-slate-500">{r.supplier_name}</td>}
                    <td className="px-6 py-4 text-slate-500">{r.user_name || r.created_by_name}</td>
                    <td className="px-6 py-4 font-bold text-primary-600">{(r.total_refund || r.total_amount || 0).toFixed(2)} ج.م</td>
                    <td className="px-6 py-4 text-slate-500">{r.created_at ? format(new Date(r.created_at), 'yyyy-MM-dd HH:mm') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detailsLoading && <div className="text-center text-sm text-slate-500">جاري تحميل تفاصيل المرتجع...</div>}
      {selectedReturn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSelectedReturn(null)}>
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-900" onClick={e => e.stopPropagation()} dir="rtl">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-black text-slate-900 dark:text-white">تفاصيل مرتجع المشتريات</h2>
              <button onClick={() => setSelectedReturn(null)} aria-label="إغلاق" className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-5 w-5" /></button>
            </div>
            <div className="mb-6 grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-800 md:grid-cols-4">
              <div><span className="text-slate-500">رقم المرتجع</span><p className="font-bold">{selectedReturn.id}</p></div>
              <div><span className="text-slate-500">الفاتورة الأصلية</span><p className="font-bold">{selectedReturn.invoice_number || selectedReturn.purchase_invoice_id || 'غير مرتبطة'}</p></div>
              <div><span className="text-slate-500">تاريخ الفاتورة</span><p className="font-bold">{selectedReturn.invoice_date || '-'}</p></div>
              <div><span className="text-slate-500">إجمالي الفاتورة</span><p className="font-bold">{selectedReturn.invoice_total == null ? '-' : `${Number(selectedReturn.invoice_total).toFixed(2)} ج.م`}</p></div>
              <div><span className="text-slate-500">المورد</span><p className="font-bold">{selectedReturn.supplier_name || '-'}</p></div>
              <div><span className="text-slate-500">هاتف المورد</span><p className="font-bold">{selectedReturn.supplier_phone || '-'}</p></div>
              <div><span className="text-slate-500">المستخدم</span><p className="font-bold">{selectedReturn.user_name || '-'}</p></div>
              <div><span className="text-slate-500">طريقة الاسترداد</span><p className="font-bold">{selectedReturn.refund_method === 'cash' ? 'نقدي' : 'خصم من حساب المورد'}</p></div>
              <div><span className="text-slate-500">الحالة</span><p className="font-bold">{selectedReturn.status}</p></div>
              <div><span className="text-slate-500">إجمالي المرتجع</span><p className="font-bold text-primary-600">{Number(selectedReturn.total_amount || 0).toFixed(2)} ج.م</p></div>
              <div><span className="text-slate-500">التاريخ</span><p className="font-bold">{selectedReturn.created_at ? format(new Date(selectedReturn.created_at), 'yyyy-MM-dd HH:mm') : '-'}</p></div>
              <div className="col-span-2 md:col-span-4"><span className="text-slate-500">السبب / الملاحظات</span><p className="font-bold">{selectedReturn.reason || '-'}</p></div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
              <table className="w-full text-right text-sm">
                <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800"><tr><th className="p-3">الصنف</th><th className="p-3">الكمية</th><th className="p-3">الوحدة</th><th className="p-3">سعر الوحدة</th><th className="p-3">الإجمالي</th><th className="p-3">التشغيلة</th><th className="p-3">الصلاحية</th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {selectedReturn.items?.map((item: any) => <tr key={item.id}><td className="p-3 font-bold">{item.drug_name || item.trade_name_en}</td><td className="p-3">{item.quantity_returned}</td><td className="p-3">{item.unit || 'large'}</td><td className="p-3">{Number(item.unit_price || 0).toFixed(2)}</td><td className="p-3">{Number(item.total_price || 0).toFixed(2)}</td><td className="p-3">{item.batch_number || '-'}</td><td className="p-3">{item.expiry_date || '-'}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

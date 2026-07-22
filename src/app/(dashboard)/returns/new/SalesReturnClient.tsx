'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getInvoiceForReturnAction, createReturnAction, getSalesInvoicesByDateAction } from '@/app/actions-client/returns';
import { Search, Save, Trash2, ArrowRight, Calendar, FileText } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'react-hot-toast';

export default function SalesReturnClient() {
  const router = useRouter();
  const listRef = React.useRef<HTMLDivElement>(null);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [invoicesByDate, setInvoicesByDate] = useState<any[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [invoice, setInvoice] = useState<any>(null);
  const [itemsToReturn, setItemsToReturn] = useState<any[]>([]);
  const [reason, setReason] = useState<string>('');
  const [refundMethod, setRefundMethod] = useState<'cash' | 'patient_account'>('cash');
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [selectedIndex, setSelectedIndex] = useState<number>(-1);

  // Fetch invoices when date changes
  React.useEffect(() => {
    async function fetchInvoices() {
      const res = await getSalesInvoicesByDateAction(selectedDate);
      if (res.success) {
        const list = res.data || [];
        setInvoicesByDate(list);
        setSelectedIndex(list.length > 0 ? 0 : -1);
      }
    }
    fetchInvoices();
  }, [selectedDate]);
  // Fetch details of selected invoice
  React.useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex < invoicesByDate.length) {
      handleInvoiceSelect(invoicesByDate[selectedIndex].id);
    } else {
      setInvoiceId('');
      setInvoice(null);
      setItemsToReturn([]);
    }
  }, [selectedIndex, invoicesByDate]);

  // Scroll selected button into view
  React.useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const activeEl = listRef.current.children[selectedIndex] as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest'
        });
      }
    }
  }, [selectedIndex]);

  // Handle keyboard arrow navigation
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore keydown if focused on input/textarea/select elements to not interfere with quantity inputs
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
        return;
      }

      if (invoicesByDate.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev < invoicesByDate.length - 1 ? prev + 1 : prev));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : 0));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [invoicesByDate]);

  const handleInvoiceSelect = async (invId: string) => {
    setInvoiceId(invId);
    if (!invId) {
      setInvoice(null);
      setItemsToReturn([]);
      return;
    }
    
    setIsSearching(true);
    const res = await getInvoiceForReturnAction(invId);
    setIsSearching(false);
    
    if (res.success && res.data) {
      setInvoice(res.data);
      if (!res.data.patient_id) setRefundMethod('cash');
      // Initialize return items with 0 quantity
      setItemsToReturn(res.data.items.map((item: any) => ({
        ...item,
        return_quantity: 0,
        original_unit: item.unit,
        base_price: item.unit_price // Treat the initial price as base_price to calculate upon
      })));
    } else {
      toast.error(res.error || 'فاتورة غير موجودة');
      setInvoice(null);
      setItemsToReturn([]);
    }
  };

  const toLargeQty = (item: any, quantity: number, unit: string) => {
    const l2m = item.large_to_medium || 1;
    const m2s = item.medium_to_small || 1;
    if (unit === 'medium') return quantity / l2m;
    if (unit === 'small') return quantity / (l2m * m2s);
    return quantity;
  };

  const fromLargeQty = (item: any, quantity: number, unit: string) => {
    const l2m = item.large_to_medium || 1;
    const m2s = item.medium_to_small || 1;
    if (unit === 'medium') return quantity * l2m;
    if (unit === 'small') return quantity * l2m * m2s;
    return quantity;
  };

  const remainingInSelectedUnit = (item: any) => {
    const sold = toLargeQty(item, item.quantity_sold || 0, item.original_unit || 'large');
    const returned = toLargeQty(item, item.returned_quantity || 0, item.original_unit || 'large');
    return fromLargeQty(item, Math.max(0, sold - returned), item.unit || 'large');
  };

  const updateQuantity = (index: number, quantity: number) => {
    setItemsToReturn(prev => {
      const newItems = [...prev];
      const item = newItems[index];
      // Ensure quantity does not exceed remaining quantity
      const remainingQty = remainingInSelectedUnit(item);
      if (quantity < 0) quantity = 0;
      if (quantity > remainingQty) quantity = remainingQty;
      newItems[index] = { ...item, return_quantity: quantity };
      return newItems;
    });
  };

  const totalRefund = itemsToReturn.reduce((sum, item) => sum + ((item.return_quantity || 0) * item.unit_price), 0);
  const activeReturns = itemsToReturn.filter(i => i.return_quantity > 0);

  const handleSubmit = async () => {
    if (!invoice) return;
    if (activeReturns.length === 0) {
      return toast.error('يرجى تحديد كمية لمرتجع واحد على الأقل');
    }

    setIsSubmitting(true);
    const res = await createReturnAction({
      invoice_id: invoiceId,
      refund_method: refundMethod,
      reason,
      patient_id: invoice.patient_id || undefined,
      items: activeReturns.map(i => ({
        sale_item_id: i.id,
        inventory_id: i.inventory_id,
        drug_name: i.drug_name,
        quantity: i.return_quantity,
        unit_price: i.unit_price,
        unit: i.unit
      }))
    });

    if (res.success) {
      toast.success('تم تسجيل المرتجع بنجاح');
      router.push('/returns');
    } else {
      toast.error('فشل حفظ المرتجع: ' + res.error);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">إضافة مرتجع مبيعات</h1>
          <p className="text-slate-500">إرجاع مبيعات فاتورة وتحديث المخزون</p>
        </div>
        <Link href="/returns" className="btn btn-ghost flex items-center gap-2">
          <ArrowRight className="w-4 h-4" />
          رجوع
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Date selection & Invoice list */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-4">
            <label className="block text-xs font-bold text-slate-500 mb-2">تاريخ الفواتير</label>
            <div className="relative">
              <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="date"
                className="w-full pl-4 pr-10 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold text-slate-900 dark:text-white"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-4">
            <h2 className="text-sm font-black mb-3 text-slate-800 dark:text-white flex justify-between items-center">
              <span>الفواتير المتاحة</span>
              <span className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-xs px-2 py-0.5 rounded-full font-black">
                {invoicesByDate.length}
              </span>
            </h2>
            
            <div ref={listRef} className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
              {invoicesByDate.length === 0 ? (
                <div className="py-12 text-center text-slate-400 font-bold text-xs">لا توجد فواتير مكتملة في هذا التاريخ</div>
              ) : (
                invoicesByDate.map((inv, idx) => (
                  <button
                    key={inv.id}
                    onClick={() => setSelectedIndex(idx)}
                    className={`w-full text-right p-3 rounded-xl border transition-all flex flex-col gap-1 ${
                      selectedIndex === idx
                        ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-500 dark:border-blue-600 shadow-md'
                        : 'bg-slate-50/50 dark:bg-slate-900/50 border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900'
                    }`}
                  >
                    <div className="flex justify-between items-center w-full">
                      <span className="font-black text-xs text-slate-800 dark:text-slate-100">رقم الفاتورة: {inv.id.slice(0, 8)}</span>
                      <span className="text-[10px] text-slate-400 font-bold">
                        {new Date(inv.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="flex justify-between items-center w-full mt-1">
                      <span className="text-sm font-black text-blue-600 dark:text-blue-400">{inv.total_amount.toFixed(2)} ج.م</span>
                      <span className="text-[9px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded font-black text-slate-500">
                        {inv.payment_method === 'cash' ? 'نقدي' : inv.payment_method === 'credit' ? 'آجل' : inv.payment_method === 'visa' ? 'فيزا' : inv.payment_method}
                      </span>
                    </div>
                    {inv.patient_name && (
                      <div className="text-[10px] text-purple-600 dark:text-purple-400 font-bold mt-1">👤 المريض: {inv.patient_name}</div>
                    )}
                    <div className="text-[9px] text-slate-400 font-bold">البائع: {inv.user_name || 'غير محدد'}</div>
                  </button>
                ))
              )}
            </div>
            {invoicesByDate.length > 0 && (
              <div className="mt-3 text-[10px] text-slate-400 font-bold text-center border-t border-slate-100 dark:border-slate-700/50 pt-2">
                💡 استخدم الأسهم <span className="font-black text-slate-600 dark:text-slate-300">↑</span> و <span className="font-black text-slate-600 dark:text-slate-300">↓</span> للتنقل السريع
              </div>
            )}
          </div>
        </div>

        {/* Right column: Selected receipt items and refund details */}
        <div className="lg:col-span-2 space-y-6">
          {invoice ? (
            <div className="space-y-6">
              {/* Items Section */}
              <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-bold text-slate-800 dark:text-white">أصناف الفاتورة</h2>
                  <div className="text-xs text-slate-500 flex gap-4">
                    <span>المريض: {invoice.patient_name || 'غير محدد'}</span>
                    <span>البائع: {invoice.user_name || 'غير محدد'}</span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-right text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400">
                        <th className="p-3 font-medium">الصنف</th>
                        <th className="p-3 font-medium text-center">الكمية المباعة</th>
                        <th className="p-3 font-medium text-center">المرتجع سابقاً</th>
                        <th className="p-3 font-medium text-center">الكمية المتبقية</th>
                        <th className="p-3 font-medium text-center">سعر الوحدة</th>
                        <th className="p-3 font-medium text-center">كمية المرتجع</th>
                        <th className="p-3 font-medium text-center">قيمة المرتجع</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {itemsToReturn.map((item, idx) => (
                        <tr key={idx} className="group">
                          <td className="p-3 font-medium text-slate-800 dark:text-slate-200">{item.drug_name}</td>
                          <td className="p-3 text-center text-slate-600 dark:text-slate-400">
                            {item.quantity_sold} {item.original_unit === 'large' ? 'علبة' : item.original_unit === 'medium' ? 'شريط' : 'وحدة'}
                          </td>
                          <td className="p-3 text-center text-amber-600 dark:text-amber-500 font-bold">
                            {item.returned_quantity || 0} {item.original_unit === 'large' ? 'علبة' : item.original_unit === 'medium' ? 'شريط' : 'وحدة'}
                          </td>
                          <td className="p-3 text-center text-emerald-600 dark:text-emerald-500 font-bold">
                            {remainingInSelectedUnit(item).toFixed(2)} {item.unit === 'large' ? '\u0639\u0644\u0628\u0629' : item.unit === 'medium' ? '\u0634\u0631\u064a\u0637' : '\u0648\u062d\u062f\u0629'}
                          </td>
                          <td className="hidden">
                            {item.quantity_sold - (item.returned_quantity || 0)} {item.original_unit === 'large' ? 'علبة' : item.original_unit === 'medium' ? 'شريط' : 'وحدة'}
                          </td>
                          <td className="p-3 text-center text-slate-600 dark:text-slate-400">{item.unit_price.toFixed(2)} ج.م</td>
                          <td className="p-3 text-center flex items-center justify-center gap-2">
                            <input
                              type="number"
                              min="0"
                              className="w-20 p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white text-center focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                              value={item.return_quantity || ''}
                              onChange={(e) => updateQuantity(idx, Number(e.target.value))}
                            />
                            <select
                              className="w-24 p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white text-sm"
                              value={item.unit}
                              onChange={(e) => {
                                const newItems = [...itemsToReturn];
                                const oldUnit = newItems[idx].unit;
                                const newUnit = e.target.value;
                                const l2m = newItems[idx].large_to_medium || 1;
                                const m2s = newItems[idx].medium_to_small || 1;
                                
                                // Convert old unit price to base price (large)
                                let basePrice = newItems[idx].unit_price;
                                if (oldUnit === 'medium') basePrice = basePrice * l2m;
                                if (oldUnit === 'small') basePrice = basePrice * l2m * m2s;

                                // Now convert base price to new unit price
                                let newPrice = basePrice;
                                if (newUnit === 'medium') newPrice = basePrice / l2m;
                                if (newUnit === 'small') newPrice = basePrice / (l2m * m2s);

                                newItems[idx].unit = newUnit;
                                newItems[idx].unit_price = newPrice;
                                newItems[idx].return_quantity = Math.min(newItems[idx].return_quantity || 0, remainingInSelectedUnit(newItems[idx]));
                                setItemsToReturn(newItems);
                              }}
                            >
                              <option value="large">علبة</option>
                              <option value="medium">شريط</option>
                              <option value="small">وحدة</option>
                            </select>
                          </td>
                          <td className="p-3 font-semibold text-center text-slate-800 dark:text-slate-200">
                            {((item.return_quantity || 0) * item.unit_price).toFixed(2)} ج.م
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Summary and settings panel */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Summary box */}
                <div className="bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-6 flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold text-slate-700 dark:text-slate-300 mb-2">إجمالي قيمة المرتجع</h3>
                    <span className="text-3xl font-black text-slate-900 dark:text-white">{totalRefund.toFixed(2)} ج.م</span>
                  </div>
                  
                  <button
                    onClick={handleSubmit}
                    disabled={isSubmitting || activeReturns.length === 0}
                    className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white p-3.5 rounded-xl font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-6 shadow-md shadow-blue-500/10"
                  >
                    <Save className="w-5 h-5" />
                    {isSubmitting ? 'جاري الحفظ...' : 'تنفيذ المرتجع'}
                  </button>
                </div>

                {/* Settings panel */}
                <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 space-y-4">
                  <h3 className="font-bold text-slate-850 dark:text-white">خيارات الاسترداد</h3>
                  
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">طريقة الاسترداد *</label>
                    <select
                      className="w-full p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:border-blue-500 font-bold"
                      value={refundMethod}
                      onChange={(e) => setRefundMethod(e.target.value as any)}
                    >
                      <option value="cash">استرداد نقدي (كاش)</option>
                      <option value="patient_account" disabled={!invoice?.patient_id}>خصم من مديونية مريض الفاتورة (حساب آجل)</option>
                    </select>
                  </div>

                  {!invoice?.patient_id && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 rounded-lg bg-amber-50 p-3 text-xs font-bold text-amber-700 dark:bg-amber-950/20 dark:text-amber-300">
                      الفاتورة غير مرتبطة بمريض؛ يجب استخدام الاسترداد النقدي حتى لا يُرحّل الرصيد إلى حساب غير صحيح.
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">سبب المرتجع / ملاحظات</label>
                    <textarea
                      className="w-full p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:border-blue-500 font-bold"
                      rows={2}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="اختياري..."
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-20 text-center text-slate-400 font-bold">
              <FileText className="w-12 h-12 mx-auto mb-3 opacity-30 text-blue-500" />
              الرجاء تحديد فاتورة من القائمة لعرض تفاصيلها والبدء في الإرجاع
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

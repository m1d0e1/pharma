'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getInvoiceForReturnAction, createReturnAction, getSalesInvoicesByDateAction } from '@/app/actions-client/returns';
import { Search, Save, Trash2, ArrowRight, Calendar } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'react-hot-toast';

export default function SalesReturnClient() {
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [invoicesByDate, setInvoicesByDate] = useState<any[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [invoice, setInvoice] = useState<any>(null);
  const [itemsToReturn, setItemsToReturn] = useState<any[]>([]);
  const [reason, setReason] = useState<string>('');
  const [refundMethod, setRefundMethod] = useState<'cash' | 'patient_account'>('cash');
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch invoices when date changes
  React.useEffect(() => {
    async function fetchInvoices() {
      const res = await getSalesInvoicesByDateAction(selectedDate);
      if (res.success) {
        setInvoicesByDate(res.data || []);
      }
    }
    fetchInvoices();
  }, [selectedDate]);

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
      // Initialize return items with 0 quantity
      setItemsToReturn(res.data.items.map((item: any) => ({
        ...item,
        return_quantity: 0
      })));
    } else {
      toast.error(res.error || 'فاتورة غير موجودة');
      setInvoice(null);
      setItemsToReturn([]);
    }
  };

  const updateQuantity = (index: number, quantity: number) => {
    setItemsToReturn(prev => {
      const newItems = [...prev];
      const item = newItems[index];
      // Ensure quantity does not exceed sold quantity
      if (quantity < 0) quantity = 0;
      if (quantity > item.quantity_sold) quantity = item.quantity_sold;
      newItems[index] = { ...item, return_quantity: quantity };
      return newItems;
    });
  };

  const totalRefund = itemsToReturn.reduce((sum, item) => sum + (item.return_quantity * item.unit_price), 0);
  const activeReturns = itemsToReturn.filter(i => i.return_quantity > 0);

  const handleSubmit = async () => {
    if (!invoice) return;
    if (activeReturns.length === 0) {
      return toast.error('يرجى تحديد كمية لمرتجع واحد على الأقل');
    }

    setIsSubmitting(true);
    const payload = {
      invoice_id: invoice.id,
      shift_id: invoice.shift_id,
      refund_method: refundMethod,
      reason,
      items: activeReturns.map(i => ({
        sale_item_id: i.id,
        inventory_id: i.inventory_id,
        drug_name: i.drug_name,
        quantity: i.return_quantity,
        unit_price: i.unit_price,
        unit: i.unit
      }))
    };

    const res = await createReturnAction(payload);
    setIsSubmitting(false);

    if (res.success) {
      toast.success('تم إنشاء مرتجع المبيعات بنجاح');
      router.push('/returns');
    } else {
      toast.error('حدث خطأ: ' + res.error);
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
        <div className="lg:col-span-2 space-y-6">
          {/* Search Section */}
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6">
            <h2 className="text-lg font-bold mb-4 text-slate-800 dark:text-white">تحديد فاتورة المبيعات</h2>
            <div className="flex gap-4">
              <div className="w-1/3">
                <label className="block text-sm font-medium mb-1">تاريخ الفاتورة</label>
                <div className="relative">
                  <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="date"
                    className="w-full pl-4 pr-10 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900 dark:text-white"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="w-2/3">
                <label className="block text-sm font-medium mb-1">الفواتير</label>
                <select
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900 dark:text-white"
                  value={invoiceId}
                  onChange={(e) => handleInvoiceSelect(e.target.value)}
                  disabled={isSearching}
                >
                  <option value="">-- اختر فاتورة --</option>
                  {invoicesByDate.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {new Date(inv.created_at).toLocaleTimeString('ar-EG')} - الإجمالي: {inv.total_amount} ج.م (رقم: {inv.id.slice(0,8)}) - البائع: {inv.user_name || 'غير محدد'}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Items Section */}
          {invoice && (
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-bold text-slate-800 dark:text-white">أصناف الفاتورة</h2>
                <div className="text-sm text-slate-500 flex gap-4">
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
                          {item.quantity_sold} {item.unit === 'large' ? 'علبة' : item.unit === 'medium' ? 'شريط' : 'وحدة'}
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
                              newItems[idx].unit = e.target.value;
                              // Approximate unit price adjustment (simplified for UI display)
                              // In a real scenario, fetch exact price for the unit. 
                              // Here we just let the backend handle the proper inventory deduction by unit.
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
          )}
        </div>

        <div className="space-y-6">
          {/* Settings Section */}
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 space-y-4">
            <h2 className="text-lg font-bold text-slate-800 dark:text-white">بيانات المرتجع</h2>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">طريقة الاسترداد *</label>
              <select
                className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:border-blue-500"
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value as any)}
              >
                <option value="cash">استرداد نقدي (كاش)</option>
                {invoice?.patient_id && (
                  <option value="patient_account">إضافة لرصيد المريض (آجل)</option>
                )}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">سبب المرتجع / ملاحظات</label>
              <textarea
                className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:border-blue-500"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="اختياري..."
              />
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
            <div className="flex justify-between items-center mb-6">
              <span className="text-slate-600 dark:text-slate-400">إجمالي قيمة المرتجع</span>
              <span className="text-2xl font-bold text-slate-900 dark:text-white">{totalRefund.toFixed(2)} ج.م</span>
            </div>
            
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || activeReturns.length === 0}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="w-5 h-5" />
              {isSubmitting ? 'جاري الحفظ...' : 'تنفيذ المرتجع'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { getSuppliersAction, createPurchaseReturnAction, getPurchasesReportsAction, getPurchaseInvoiceDetailsAction } from '@/app/actions-client/purchases';
import { Search, Save, Trash2, ArrowRight, FileText } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'react-hot-toast';

export default function PurchaseReturnClient() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('');
  
  // Invoice state
  const [invoices, setInvoices] = useState<any[]>([]);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>('');
  const [isLoadingInvoices, setIsLoadingInvoices] = useState(false);
  
  const [reason, setReason] = useState<string>('');
  const [refundMethod, setRefundMethod] = useState<'cash' | 'credit'>('credit');
  const [items, setItems] = useState<any[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    getSuppliersAction().then(res => {
      if (res.success) setSuppliers(res.data);
    });
  }, []);

  // Fetch invoices when supplier changes
  useEffect(() => {
    if (!selectedSupplierId) {
      setInvoices([]);
      setSelectedInvoiceId('');
      setItems([]);
      return;
    }
    const fetchInvoices = async () => {
      setIsLoadingInvoices(true);
      const res = await getPurchasesReportsAction({ supplierId: selectedSupplierId });
      setIsLoadingInvoices(false);
      if (res.success && res.data) {
        setInvoices(res.data);
      }
    };
    fetchInvoices();
  }, [selectedSupplierId]);

  // Fetch items when invoice changes
  const handleInvoiceSelect = async (invId: string) => {
    setSelectedInvoiceId(invId);
    if (!invId) {
      setItems([]);
      return;
    }
    
    setIsLoadingInvoices(true);
    const res = await getPurchaseInvoiceDetailsAction(invId);
    setIsLoadingInvoices(false);
    
    if (res.success && res.data) {
      // Map to return items format with 0 quantity returned by default
      setItems(res.data.map((item: any) => ({
        drug_id: item.drug_id,
        drug_name: item.trade_name,
        quantity: 0, // This is the return quantity
        max_quantity: item.quantity, // Max allowed to return
        unit_price: item.cost_price || 0,
        original_unit: item.unit || 'large',
        unit: item.unit || 'large',
        base_price: item.cost_price || 0, // Store original base cost price
        large_to_medium: item.large_to_medium || 1,
        medium_to_small: item.medium_to_small || 1,
      })));
    } else {
      toast.error('لم يتم العثور على تفاصيل الفاتورة');
      setItems([]);
    }
  };

  const updateItem = (index: number, field: string, value: any) => {
    setItems(prev => {
      const newItems = [...prev];
      if (field === 'quantity') {
        const max = newItems[index].max_quantity;
        if (value > max) value = max;
        if (value < 0) value = 0;
      }
      
      if (field === 'unit') {
        // Recalculate price based on unit change, from original base cost price
        const item = newItems[index];
        const oldUnit = item.unit;
        let originalBasePrice = item.base_price;
        
        // If the original invoice unit was 'medium', the cost_price we have is already medium. Let's find true 'large' base price:
        if (item.original_unit === 'medium') {
            originalBasePrice = item.base_price * item.large_to_medium;
        } else if (item.original_unit === 'small') {
            originalBasePrice = item.base_price * item.large_to_medium * item.medium_to_small;
        }

        if (value === 'large') {
          newItems[index].unit_price = originalBasePrice;
        } else if (value === 'medium') {
          newItems[index].unit_price = originalBasePrice / item.large_to_medium;
        } else if (value === 'small') {
          newItems[index].unit_price = originalBasePrice / (item.large_to_medium * item.medium_to_small);
        }
      }

      newItems[index] = { ...newItems[index], [field]: value };
      return newItems;
    });
  };

  // Only consider items with quantity > 0
  const activeItems = items.filter(i => i.quantity > 0);
  const totalAmount = activeItems.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);

  const handleSubmit = async () => {
    if (!selectedSupplierId) {
      toast.error('يرجى اختيار المورد');
      return;
    }
    if (activeItems.length === 0) {
      toast.error('يرجى تحديد كمية لمرتجع واحد على الأقل');
      return;
    }
    if (activeItems.some(i => !i.unit_price || i.unit_price <= 0)) {
      toast.error('تأكد من صحة الأسعار');
      return;
    }

    setIsSubmitting(true);
    const res = await createPurchaseReturnAction({
      supplier_id: Number(selectedSupplierId),
      reason,
      refund_method: refundMethod,
      items: activeItems
    });

    if (res.success) {
      toast.success('تم إنشاء مرتجع المشتريات بنجاح');
      router.push('/purchases');
    } else {
      toast.error('حدث خطأ: ' + res.error);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">إضافة مرتجع مشتريات</h1>
          <p className="text-slate-500">إرجاع بضاعة إلى المورد وتحديث المخزون والحسابات</p>
        </div>
        <Link href="/purchases" className="btn btn-ghost flex items-center gap-2">
          <ArrowRight className="w-4 h-4" />
          رجوع
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Invoice Selection Section */}
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 mb-6">
            <h2 className="text-lg font-bold mb-4 text-slate-800 dark:text-white">تحديد الفاتورة المرتجعة</h2>
            <div className="flex gap-4">
              <div className="w-1/2">
                <label className="block text-sm font-medium mb-1">المورد</label>
                <select
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={selectedSupplierId}
                  onChange={(e) => setSelectedSupplierId(e.target.value)}
                >
                  <option value="">-- اختر المورد --</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>{s.name_ar}</option>
                  ))}
                </select>
              </div>
              <div className="w-1/2">
                <label className="block text-sm font-medium mb-1">فاتورة الشراء</label>
                <select
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={selectedInvoiceId}
                  onChange={(e) => handleInvoiceSelect(e.target.value)}
                  disabled={!selectedSupplierId || isLoadingInvoices}
                >
                  <option value="">-- اختر الفاتورة --</option>
                  {invoices.map(inv => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoice_number || inv.id.slice(0, 8)} - الإجمالي: {inv.total_amount} ({new Date(inv.created_at).toLocaleDateString('ar-EG')})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Items Section */}
          {selectedInvoiceId && (
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6">
              <h2 className="text-lg font-bold mb-4 text-slate-800 dark:text-white">الأصناف المرتجعة</h2>
              
              <div className="overflow-x-auto">
                <table className="w-full text-right text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400">
                      <th className="p-3 font-medium">الصنف</th>
                      <th className="p-3 font-medium w-24">الكمية المشتراة</th>
                      <th className="p-3 font-medium w-32">الكمية المرتجعة</th>
                      <th className="p-3 font-medium w-32">سعر الإرجاع</th>
                      <th className="p-3 font-medium w-32">الإجمالي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-500">
                        لم يتم إضافة أصناف بعد
                      </td>
                    </tr>
                  )}
                  {items.map((item, idx) => (
                    <tr key={idx} className="group">
                      <td className="p-3 font-medium text-slate-800 dark:text-slate-200">{item.drug_name}</td>
                      <td className="p-3 text-slate-500">
                        {item.max_quantity} {item.original_unit === 'large' ? 'علبة' : item.original_unit === 'medium' ? 'شريط' : 'وحدة'}
                      </td>
                      <td className="p-3 flex items-center justify-center gap-2">
                        <input
                          type="number"
                          min="0"
                          className="w-20 p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white"
                          value={item.quantity}
                          onChange={(e) => updateItem(idx, 'quantity', Number(e.target.value))}
                        />
                        <select
                          className="w-24 p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white text-sm"
                          value={item.unit || 'large'}
                          onChange={(e) => updateItem(idx, 'unit', e.target.value)}
                        >
                          <option value="large">علبة</option>
                          <option value="medium">شريط</option>
                          <option value="small">وحدة</option>
                        </select>
                      </td>
                      <td className="p-3">
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          className="w-full p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white"
                          value={item.unit_price}
                          onChange={(e) => updateItem(idx, 'unit_price', Number(e.target.value))}
                        />
                      </td>
                      <td className="p-3 font-semibold text-slate-800 dark:text-slate-200">
                        {(item.quantity * item.unit_price).toFixed(2)} ج.م
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
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">المورد *</label>
              <select
                className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                value={selectedSupplierId}
                onChange={(e) => setSelectedSupplierId(e.target.value)}
              >
                <option value="">-- اختر المورد --</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.name_ar}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">طريقة الاسترداد *</label>
              <select
                className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value as any)}
              >
                <option value="credit">خصم من حساب المورد (آجل)</option>
                <option value="cash">استرداد نقدي (كاش)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">سبب المرتجع / ملاحظات</label>
              <textarea
                className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
            <div className="flex justify-between items-center mb-6">
              <span className="text-slate-600 dark:text-slate-400">إجمالي المرتجع</span>
              <span className="text-2xl font-bold text-slate-900 dark:text-white">{totalAmount.toFixed(2)} ج.م</span>
            </div>
            
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || items.length === 0}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-lg font-semibold transition-colors disabled:opacity-50"
            >
              <Save className="w-5 h-5" />
              {isSubmitting ? 'جاري الحفظ...' : 'حفظ المرتجع'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

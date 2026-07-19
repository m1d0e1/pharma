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
  const listRef = React.useRef<HTMLDivElement>(null);
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

  const [selectedIndex, setSelectedIndex] = useState<number>(-1);

  useEffect(() => {
    getSuppliersAction().then(res => {
      if (res.success) setSuppliers(res.data);
    });
  }, []);

  // Fetch invoices when supplier changes
  useEffect(() => {
    if (!selectedSupplierId) {
      setInvoices([]);
      setSelectedIndex(-1);
      setItems([]);
      return;
    }
    const fetchInvoices = async () => {
      setIsLoadingInvoices(true);
      const res = await getPurchasesReportsAction({ supplierId: selectedSupplierId });
      setIsLoadingInvoices(false);
      if (res.success && res.data) {
        const list = res.data;
        setInvoices(list);
        setSelectedIndex(list.length > 0 ? 0 : -1);
      }
    };
    fetchInvoices();
  }, [selectedSupplierId]);

  // Fetch items when selectedIndex changes
  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex < invoices.length) {
      handleInvoiceSelect(invoices[selectedIndex].id);
    } else {
      setSelectedInvoiceId('');
      setItems([]);
    }
  }, [selectedIndex, invoices]);

  // Scroll selected button into view
  useEffect(() => {
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
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
        return;
      }

      if (invoices.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev < invoices.length - 1 ? prev + 1 : prev));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : 0));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [invoices]);

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
        purchase_invoice_item_id: item.id,
        inventory_id: item.inventory_id,
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
        expiry_date: item.inventory_expiry_date || item.expiry_date,
        batch_number: item.batch_number,
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
      purchase_invoice_id: selectedInvoiceId,
      supplier_id: Number(selectedSupplierId),
      reason,
      refund_method: refundMethod,
      items: activeItems
    });

    if (res.success) {
      toast.success('تم إنشاء مرتجع المشتريات بنجاح');
      router.push('/purchases/returns');
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
        {/* Left column: Supplier Selection & Invoices List */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-4">
            <label className="block text-xs font-bold text-slate-500 mb-2">المورد</label>
            <select
              className="w-full p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold text-slate-900 dark:text-white"
              value={selectedSupplierId}
              onChange={(e) => setSelectedSupplierId(e.target.value)}
            >
              <option value="">-- اختر المورد --</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name_ar}</option>
              ))}
            </select>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-4">
            <h2 className="text-sm font-black mb-3 text-slate-800 dark:text-white flex justify-between items-center">
              <span>الفواتير المتاحة</span>
              <span className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-xs px-2 py-0.5 rounded-full font-black">
                {invoices.length}
              </span>
            </h2>

            <div ref={listRef} className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
              {!selectedSupplierId ? (
                <div className="py-12 text-center text-slate-400 font-bold text-xs">يرجى اختيار مورد أولاً</div>
              ) : invoices.length === 0 ? (
                <div className="py-12 text-center text-slate-400 font-bold text-xs">لا توجد فواتير مشتريات لهذا المورد</div>
              ) : (
                invoices.map((inv, idx) => (
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
                      <span className="font-black text-xs text-slate-800 dark:text-slate-100">رقم الفاتورة: {inv.invoice_number || inv.id.slice(0, 8)}</span>
                      <span className="text-[10px] text-slate-400 font-bold">
                        {new Date(inv.created_at).toLocaleDateString('ar-EG')}
                      </span>
                    </div>
                    <div className="flex justify-between items-center w-full mt-1">
                      <span className="text-sm font-black text-blue-600 dark:text-blue-400">{inv.total_amount.toFixed(2)} ج.م</span>
                      <span className="text-[9px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded font-black text-slate-500">
                        {inv.payment_method === 'cash' ? 'نقدي' : 'آجل'}
                      </span>
                    </div>
                    <div className="text-[9px] text-slate-400 font-bold mt-1">المستلم: {inv.staff_name || 'غير محدد'}</div>
                  </button>
                ))
              )}
            </div>
            {invoices.length > 0 && (
              <div className="mt-3 text-[10px] text-slate-400 font-bold text-center border-t border-slate-100 dark:border-slate-700/50 pt-2">
                💡 استخدم الأسهم <span className="font-black text-slate-600 dark:text-slate-300">↑</span> و <span className="font-black text-slate-600 dark:text-slate-300">↓</span> للتنقل السريع
              </div>
            )}
          </div>
        </div>

        {/* Right column: Selected receipt items and refund details */}
        <div className="lg:col-span-2 space-y-6">
          {selectedInvoiceId ? (
            <div className="space-y-6">
              {/* Items Section */}
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
                              className="w-20 p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
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
                              className="w-full p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
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

              {/* Summary and settings panel */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Summary box */}
                <div className="bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-6 flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold text-slate-700 dark:text-slate-300 mb-2">إجمالي قيمة المرتجع</h3>
                    <span className="text-3xl font-black text-slate-900 dark:text-white">{totalAmount.toFixed(2)} ج.م</span>
                  </div>
                  
                  <button
                    onClick={handleSubmit}
                    disabled={isSubmitting || activeItems.length === 0}
                    className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white p-3.5 rounded-xl font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-6 shadow-md shadow-blue-500/10"
                  >
                    <Save className="w-5 h-5" />
                    {isSubmitting ? 'جاري الحفظ...' : 'تنفيذ المرتجع'}
                  </button>
                </div>

                {/* Settings panel */}
                <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 space-y-4">
                  <h3 className="font-bold text-slate-855 dark:text-white">خيارات المرتجع</h3>
                  
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">طريقة الاسترداد *</label>
                    <select
                      className="w-full p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:border-blue-500 font-bold"
                      value={refundMethod}
                      onChange={(e) => setRefundMethod(e.target.value as any)}
                    >
                      <option value="credit">خصم من حساب المورد (آجل)</option>
                      <option value="cash">استرداد نقدي (كاش)</option>
                    </select>
                  </div>

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

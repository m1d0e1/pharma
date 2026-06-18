'use client';

import React, { useState, useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook';
import { createPurchaseOrderAction } from '@/app/actions-client/purchases';
import { searchMasterDrugsAction } from '@/app/actions/master-drugs';
import { toast } from 'react-hot-toast';
import { X, Save, ShoppingCart, Plus, Trash2, Search, Loader2 } from 'lucide-react';

interface Props {
  initialItems: any[];
  onClose: () => void;
}

export default function PurchaseOrderModal({ initialItems, onClose }: Props) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const [supplier, setSupplier] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState(
    initialItems
      .filter(item => {
        const qty = item.suggested_order !== undefined ? item.suggested_order : Math.max(0, (item.min_stock_level * 2) - item.quantity);
        return qty > 0;
      })
      .map(item => ({
        drug_id: item.master_drugs.id,
        trade_name: item.master_drugs.trade_name_en || item.master_drugs.trade_name,
        quantity: item.suggested_order !== undefined ? item.suggested_order : Math.max(0, (item.min_stock_level * 2) - item.quantity),
        expected_price: item.master_drugs.official_price || 0,
      }))
  );

  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (searchQuery.length >= 2) {
        setSearching(true);
        const result = await searchMasterDrugsAction({ query: searchQuery });
        if (result.success) {
          setSearchResults(result.data || []);
        }
        setSearching(false);
      } else {
        setSearchResults([]);
      }
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery]);

  const addDrugToOrder = (drug: any) => {
    if (items.find(i => i.drug_id === drug.id)) {
      toast.error('هذا الصنف موجود بالفعل في الطلب');
      return;
    }
    setItems([...items, {
      drug_id: drug.id,
      trade_name: drug.trade_name_en || drug.trade_name,
      quantity: 1,
      expected_price: drug.official_price || 0
    }]);
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supplier) return toast.error('يرجى إدخال اسم المورد');
    if (items.length === 0) return toast.error('لا يوجد أصناف في الطلب');
    if (items.some(i => i.quantity <= 0)) return toast.error('لا يمكن طلب أصناف بكمية صفر');

    setLoading(true);
    try {
      const result = await createPurchaseOrderAction({
        supplier_name: supplier,
        notes,
        items: items.map(i => ({
          drug_id: i.drug_id,
          quantity: i.quantity,
          expected_price: i.expected_price
        }))
      });

      if (result.success) {
        toast.success('تم إنشاء أمر الشراء بنجاح: ' + result.po_id);
        onClose();
      } else {
        toast.error(result.error || 'فشل إنشاء الطلب');
      }
    } catch (error) {
      toast.error('حدث خطأ غير متوقع');
    } finally {
      setLoading(false);
    }
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: string, value: any) => {
    const newItems = [...items];
    (newItems[index] as any)[field] = value;
    setItems(newItems);
  };

  const totalAmount = items.reduce((sum, item) => sum + (item.quantity * item.expected_price), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 w-full max-w-5xl max-h-[90vh] rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden border border-slate-100 dark:border-slate-800">
        
        {/* Header */}
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
              <ShoppingCart className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">إنشاء أمر شراء جديد</h2>
              <p className="text-sm text-slate-500 font-bold">تجهيز طلبية المورد للأصناف الناقصة أو الجديدة</p>
            </div>
          </div>
          <button onClick={onClose} className="p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-slate-400 hover:text-red-500 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <div className="p-8 flex-1 overflow-y-auto space-y-8">
            {/* Supplier & Search */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
              <div className="md:col-span-4 space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">المورد / الشركة</label>
                <input 
                  type="text" 
                  required
                  value={supplier}
                  onChange={e => setSupplier(e.target.value)}
                  placeholder="اسم المورد..."
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-6 py-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                />
              </div>
              
              <div className="md:col-span-8 space-y-2 relative">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">إضافة صنف جديد للطلب</label>
                <div className="relative">
                  <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input 
                    type="text" 
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="ابحث عن دواء بالاسم التجاري أو المادة الفعالة..."
                    className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pr-12 pl-6 py-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                  />
                  {searching && <Loader2 className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-emerald-500 animate-spin" />}
                </div>

                {/* Search Results Dropdown */}
                {searchResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl z-[60] overflow-hidden max-h-60 overflow-y-auto">
                    {searchResults.map((drug) => (
                      <button
                        key={drug.id}
                        type="button"
                        onClick={() => addDrugToOrder(drug)}
                        className="w-full p-4 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-right"
                      >
                        <div>
                          <p className="font-bold text-slate-900 dark:text-white">{drug.trade_name_en || drug.trade_name}</p>
                          {drug.trade_name_en && (
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{drug.trade_name}</p>
                          )}
                        </div>
                        <div className="text-left">
                          <p className="text-sm font-black text-blue-600">{drug.official_price} ج.م</p>
                          <span className="text-[8px] bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full uppercase font-black">أضف للطلب</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">ملاحظات إضافية</label>
              <textarea 
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="مواعيد التوصيل، شروط الدفع، أو أي ملاحظات أخرى..."
                rows={2}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-6 py-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-blue-500 transition-all resize-none"
              />
            </div>

            {/* Items Table */}
            <div className="border border-slate-100 dark:border-slate-800 rounded-3xl overflow-hidden shadow-sm">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/50">
                    <th className="px-6 py-4 text-xs font-black text-slate-400">الصنف</th>
                    <th className="px-6 py-4 text-xs font-black text-slate-400 text-center">الكمية المطلوبة</th>
                    <th className="px-6 py-4 text-xs font-black text-slate-400 text-center">السعر التقديري</th>
                    <th className="px-6 py-4 text-xs font-black text-slate-400 text-center">الإجمالي</th>
                    <th className="px-6 py-4 text-xs font-black text-slate-400"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {items.map((item, idx) => (
                    <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                      <td className="px-6 py-4">
                        <span className="font-bold text-slate-900 dark:text-white">{item.trade_name}</span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <input 
                          type="number" 
                          min="1"
                          value={item.quantity}
                          onChange={e => updateItem(idx, 'quantity', parseInt(e.target.value) || 0)}
                          className="w-20 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-2 rounded-xl text-center font-black"
                        />
                      </td>
                      <td className="px-6 py-4 text-center">
                        <input 
                          type="number" 
                          step="0.01"
                          value={item.expected_price}
                          onChange={e => updateItem(idx, 'expected_price', parseFloat(e.target.value) || 0)}
                          className="w-24 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-2 rounded-xl text-center font-black"
                        />
                      </td>
                      <td className="px-6 py-4 text-center font-black text-blue-600">
                        {(item.quantity * item.expected_price).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button type="button" onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-600 p-2">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Footer */}
          <div className="p-8 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-xs font-black text-slate-400 uppercase tracking-widest">إجمالي مبلغ الطلب التقديري</span>
              <span className="text-3xl font-black text-slate-900 dark:text-white">
                {totalAmount.toLocaleString()} <span className="text-sm">ج.م</span>
              </span>
            </div>
            <div className="flex gap-4">
              <button type="button" onClick={onClose} className="px-8 py-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 font-black rounded-2xl">إلغاء</button>
              <button 
                type="submit" 
                disabled={loading}
                className="px-10 py-4 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl shadow-xl shadow-blue-500/20 flex items-center gap-3 disabled:opacity-50"
              >
                {loading ? <Plus className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                حفظ وإرسال الأمر
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

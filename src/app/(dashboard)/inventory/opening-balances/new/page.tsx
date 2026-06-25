'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { addOpeningBalanceAction } from '@/app/actions-client/inventory';
import { searchDrugsAction } from '@/app/actions-client/sales';
import { Search, Save, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'react-hot-toast';

export default function NewOpeningBalanceClient() {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedDrug, setSelectedDrug] = useState<any>(null);
  
  const [quantity, setQuantity] = useState(1);
  const [costPrice, setCostPrice] = useState(0);
  const [unitPrice, setUnitPrice] = useState(0);
  const [expiryDate, setExpiryDate] = useState('');
  
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSearch = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchTerm(val);
    if (val.length > 2) {
      const res = await searchDrugsAction(val);
      if (res.success) setSearchResults(res.data || []);
    } else {
      setSearchResults([]);
    }
  };

  const selectDrug = (drug: any) => {
    setSelectedDrug(drug);
    setCostPrice(drug.cost_price || 0);
    setUnitPrice(drug.base_price || 0);
    setSearchTerm('');
    setSearchResults([]);
  };

  const handleSubmit = async () => {
    if (!selectedDrug) return toast.error('يرجى اختيار صنف');
    if (!expiryDate) return toast.error('يرجى تحديد تاريخ الصلاحية');
    if (quantity <= 0) return toast.error('الكمية يجب أن تكون أكبر من 0');

    setIsSubmitting(true);
    const res = await addOpeningBalanceAction({
      drug_id: selectedDrug.id,
      quantity,
      cost_price: costPrice,
      unit_price: unitPrice,
      expiry_date: expiryDate
    });
    setIsSubmitting(false);

    if (res.success) {
      toast.success('تم إضافة الرصيد الإفتتاحي بنجاح');
      router.push('/inventory/opening-balances');
    } else {
      toast.error('حدث خطأ: ' + res.error);
    }
  };

  return (
    <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">إضافة رصيد إفتتاحي</h1>
          <p className="text-slate-500 font-bold">إدخال بضاعة أول المدة للمخزون</p>
        </div>
        <Link href="/inventory/opening-balances" className="btn btn-ghost flex items-center gap-2">
          <ArrowRight className="w-4 h-4" />
          رجوع
        </Link>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 p-8 shadow-sm max-w-3xl">
        <div className="space-y-6">
          {!selectedDrug ? (
            <div className="relative">
              <label className="block text-sm font-bold mb-2">ابحث عن الصنف</label>
              <div className="relative">
                <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={handleSearch}
                  className="w-full pl-4 pr-12 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="ادخل اسم الدواء بالعربية أو الإنجليزية..."
                />
              </div>
              {searchResults.length > 0 && (
                <div className="absolute z-10 w-full mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg max-h-60 overflow-y-auto">
                  {searchResults.map(drug => (
                    <div 
                      key={drug.id} 
                      onClick={() => selectDrug(drug)}
                      className="p-3 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer border-b border-slate-100 dark:border-slate-700 last:border-0"
                    >
                      <div className="font-bold">{drug.trade_name}</div>
                      <div className="text-xs text-slate-500">{drug.trade_name_en}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-xl flex justify-between items-center border border-blue-100 dark:border-blue-800/50">
              <div>
                <p className="text-xs text-blue-600 dark:text-blue-400 font-bold mb-1">الصنف المحدد</p>
                <p className="font-black text-slate-900 dark:text-white">{selectedDrug.trade_name}</p>
              </div>
              <button onClick={() => setSelectedDrug(null)} className="text-sm text-red-500 font-bold hover:underline">
                تغيير الصنف
              </button>
            </div>
          )}

          {selectedDrug && (
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-bold mb-2">الكمية (علبة)</label>
                <input
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-bold mb-2">تاريخ الصلاحية</label>
                <input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-bold mb-2">سعر التكلفة (للعلبة)</label>
                <input
                  type="number"
                  step="0.01"
                  value={costPrice}
                  onChange={(e) => setCostPrice(Number(e.target.value))}
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-bold mb-2">سعر البيع للجمهور (للعلبة)</label>
                <input
                  type="number"
                  step="0.01"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(Number(e.target.value))}
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          <div className="pt-6">
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !selectedDrug}
              className="w-full py-4 bg-blue-600 text-white rounded-xl font-black hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Save className="w-5 h-5" />
              {isSubmitting ? 'جاري الحفظ...' : 'حفظ الرصيد الإفتتاحي'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

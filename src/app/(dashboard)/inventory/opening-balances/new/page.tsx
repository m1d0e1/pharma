'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { addOpeningBalanceAction } from '@/app/actions-client/inventory';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { Search, Save, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'react-hot-toast';

export default function NewOpeningBalanceClient() {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedDrug, setSelectedDrug] = useState<any>(null);
  
  const [quantity, setQuantity] = useState(1);
  const [costPrice, setCostPrice] = useState<number | ''>('');
  const [unitPrice, setUnitPrice] = useState(0);
  const [expiryDate, setExpiryDate] = useState('');
  const [searchByActive, setSearchByActive] = useState(false);
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCommitted, setIsCommitted] = useState(false);
  const searchRequestId = useRef(0);
  const submissionRef = useRef(false);

  const handleSearch = async (e: React.ChangeEvent<HTMLInputElement>, byActive = searchByActive) => {
    const val = e.target.value;
    const requestId = ++searchRequestId.current;
    setSearchTerm(val);
    if (val.length > 2) {
      try {
        const res = await searchMasterDrugsAction({
          query: val,
          searchByActiveIngredient: byActive,
          status: 'active',
        });
        if (requestId !== searchRequestId.current) return;
        if (res.success) {
          setSearchResults((res.data || []).slice(0, 20));
        } else {
          setSearchResults([]);
          toast.error(res.error || 'فشل البحث في كتالوج الأدوية');
        }
      } catch {
        if (requestId !== searchRequestId.current) return;
        setSearchResults([]);
        toast.error('فشل البحث في كتالوج الأدوية');
      }
    } else {
      setSearchResults([]);
    }
  };

  const selectDrug = (drug: any) => {
    searchRequestId.current += 1;
    setSelectedDrug(drug);
    const knownPurchaseCost = drug.purchase_price != null
      ? Number(drug.purchase_price)
      : Number(drug.base_price) > 0
        ? Number(drug.base_price)
        : Number.NaN;
    setCostPrice(Number.isFinite(knownPurchaseCost) && knownPurchaseCost >= 0 ? knownPurchaseCost : '');
    setUnitPrice(Number(drug.min_price ?? drug.official_price ?? 0));
    setSearchTerm('');
    setSearchResults([]);
  };

  const handleSubmit = async () => {
    if (!selectedDrug) return toast.error('يرجى اختيار صنف');
    if (!expiryDate) return toast.error('يرجى تحديد تاريخ الصلاحية');
    if (quantity <= 0) return toast.error('الكمية يجب أن تكون أكبر من 0');
    if (costPrice === '' || !Number.isFinite(costPrice) || costPrice < 0) return toast.error('يرجى إدخال سعر تكلفة صحيح، أو صفر للصنف المجاني');

    if (submissionRef.current) return;
    submissionRef.current = true;
    setIsSubmitting(true);
    let committed = false;
    try {
      const res = await addOpeningBalanceAction({
        drug_id: selectedDrug.id,
        quantity,
        cost_price: costPrice,
        unit_price: unitPrice,
        expiry_date: expiryDate
      });

      if (res.success) {
        committed = true;
        setIsCommitted(true);
        toast.success('تم إضافة الرصيد الإفتتاحي بنجاح');
        try {
          router.push('/inventory/opening-balances');
        } catch {
          toast.error('تم إضافة الرصيد الإفتتاحي بنجاح لكن تعذر فتح قائمة الأرصدة الإفتتاحية');
        }
      } else {
        toast.error('حدث خطأ: ' + res.error);
      }
    } catch {
      toast.error('حدث خطأ أثناء حفظ الرصيد الإفتتاحي');
    } finally {
      if (!committed) submissionRef.current = false;
      setIsSubmitting(false);
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
              
              <div className="flex items-center gap-2 mt-2 px-1">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={searchByActive} 
                    onChange={(e) => {
                      setSearchByActive(e.target.checked);
                      handleSearch({ target: { value: searchTerm } } as any, e.target.checked);
                    }}
                    className="rounded text-blue-600 focus:ring-blue-500 border-slate-300 w-4 h-4"
                  />
                  <span>البحث بالمادة الفعالة</span>
                </label>
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
                <label htmlFor="opening-expiry" className="block text-sm font-bold mb-2">تاريخ الصلاحية</label>
                <input
                  id="opening-expiry"
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="opening-cost" className="block text-sm font-bold mb-2">سعر التكلفة (للعلبة)</label>
                <input
                  id="opening-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  value={costPrice}
                  onChange={(e) => setCostPrice(e.target.value === '' ? '' : Number(e.target.value))}
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
              disabled={isSubmitting || isCommitted || !selectedDrug}
              className="w-full py-4 bg-blue-600 text-white rounded-xl font-black hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Save className="w-5 h-5" />
              {isCommitted ? 'تم حفظ الرصيد الإفتتاحي' : isSubmitting ? 'جاري الحفظ...' : 'حفظ الرصيد الإفتتاحي'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

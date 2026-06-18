'use client'

import React, { useState } from 'react'
import { Search, Trash2, Filter, AlertTriangle } from 'lucide-react'
import { toast, Toaster } from 'react-hot-toast'
// Removed server action import

interface UnusedItem {
  id: number;
  trade_name: string;
  trade_name_en?: string;
  manufacturer?: string;
  official_price: number;
  is_medicine: number;
}

interface Props {
  initialItems: UnusedItem[];
  onDelete: (id: number) => Promise<{ success: boolean; error?: string }>;
}

export default function DeleteUnusedItemsClient({ initialItems, onDelete }: Props) {
  const [items, setItems] = useState<UnusedItem[]>(initialItems);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'medicine' | 'other'>('all');
  const [isDeleting, setIsDeleting] = useState<number | null>(null);

  const filteredItems = items.filter(item => {
    const matchesSearch = item.trade_name.includes(searchTerm) || 
                         (item.trade_name_en && item.trade_name_en.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesType = filterType === 'all' || 
                        (filterType === 'medicine' && item.is_medicine === 1) ||
                        (filterType === 'other' && item.is_medicine === 0);
    return matchesSearch && matchesType;
  });

  const handleDelete = async (id: number) => {
    if (!confirm('هل أنت متأكد من حذف هذا الصنف نهائياً؟')) return;
    
    setIsDeleting(id);
    const res = await onDelete(id);
    setIsDeleting(null);

    if (res.success) {
      setItems(items.filter(i => i.id !== id));
      toast.success('تم حذف الصنف بنجاح');
    } else {
      toast.error(res.error || 'فشل الحذف');
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      <Toaster position="top-center" />
      
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 space-y-6">
        <div className="flex flex-col md:flex-row gap-6 items-center">
          <div className="relative flex-1 w-full">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input 
              type="text" 
              placeholder="بحث بالكود أو الاسم..."
              className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none focus:ring-2 focus:ring-primary-500 font-bold dark:text-white"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          
          <div className="flex bg-slate-50 dark:bg-slate-800 p-1.5 rounded-2xl gap-2">
            <button 
              onClick={() => setFilterType('all')}
              className={`px-6 py-2.5 rounded-xl font-black transition-all ${filterType === 'all' ? 'bg-white dark:bg-slate-700 text-primary-600 shadow-sm' : 'text-slate-500 hover:bg-white/50'}`}
            >الكل</button>
            <button 
              onClick={() => setFilterType('medicine')}
              className={`px-6 py-2.5 rounded-xl font-black transition-all ${filterType === 'medicine' ? 'bg-white dark:bg-slate-700 text-primary-600 shadow-sm' : 'text-slate-500 hover:bg-white/50'}`}
            >أدوية</button>
            <button 
              onClick={() => setFilterType('other')}
              className={`px-6 py-2.5 rounded-xl font-black transition-all ${filterType === 'other' ? 'bg-white dark:bg-slate-700 text-primary-600 shadow-sm' : 'text-slate-500 hover:bg-white/50'}`}
            >غير أدوية</button>
          </div>
        </div>

        <div className="flex items-center gap-3 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-2xl text-amber-700 dark:text-amber-400">
           <AlertTriangle className="w-6 h-6 flex-shrink-0" />
           <p className="font-bold text-sm leading-relaxed">
             هذه القائمة تعرض الأصناف التي ليس لها رصيد حالي ولم يتم عليها أي عمليات بيع. الحذف من هنا نهائي ويقوم بتنظيف قاعدة البيانات.
           </p>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400">الكود</th>
                <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400">اسم الصنف</th>
                <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400">الاسم الأجنبي</th>
                <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400">الشركة</th>
                <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400">السعر</th>
                <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400 text-center">حذف</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-bold">
              {filteredItems.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                  <td className="px-6 py-4 text-slate-400">#{item.id}</td>
                  <td className="px-6 py-4 text-slate-900 dark:text-white font-black">{item.trade_name_en || item.trade_name}</td>
                  <td className="px-6 py-4 text-slate-500" dir="rtl">{item.trade_name_en ? item.trade_name : ''}</td>
                  <td className="px-6 py-4 text-slate-500 text-sm">{item.manufacturer || '---'}</td>
                  <td className="px-6 py-4">
                    <span className="px-3 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg">
                      {item.official_price} ج.م
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex justify-center">
                      <button 
                        disabled={isDeleting === item.id}
                        onClick={() => handleDelete(item.id)}
                        className="p-3 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-2xl transition-all disabled:opacity-50"
                      >
                        <Trash2 className={`w-6 h-6 ${isDeleting === item.id ? 'animate-pulse' : ''}`} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-20 text-center text-slate-400 font-black italic text-xl">
                    لا يوجد أصناف مطابقة للبحث أو القائمة فارغة.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      <div className="flex justify-between items-center px-4 font-black text-slate-500">
        <span>عدد الأصناف القابلة للحذف: {filteredItems.length}</span>
      </div>
    </div>
  )
}

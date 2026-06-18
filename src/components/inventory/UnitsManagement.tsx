'use client'

import React, { useState } from 'react'
import { Plus, Trash2, Save, X, Scale } from 'lucide-react'
import { toast, Toaster } from 'react-hot-toast'
import { addUnitAction } from '@/app/actions/master-drugs'

interface Unit {
  id: number;
  name_ar: string;
  name_en?: string;
}

interface Props {
  initialData: Unit[];
}

export default function UnitsManagement({ initialData }: Props) {
  const [items, setItems] = useState<Unit[]>(initialData);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newItem, setNewItem] = useState({ name_ar: '', name_en: '' });
  const [isSaving, setIsSaving] = useState(false);

  const handleAdd = async () => {
    if (!newItem.name_ar) {
      toast.error('يرجى إدخال الاسم بالعربي');
      return;
    }
    setIsSaving(true);
    const res = await addUnitAction(newItem);
    setIsSaving(false);

    if (res.success) {
      setItems([...items, { id: res.id as number, ...newItem }]);
      setNewItem({ name_ar: '', name_en: '' });
      setIsModalOpen(false);
      toast.success('تمت إضافة الوحدة بنجاح');
    } else {
      toast.error(res.error || 'فشل إضافة الوحدة');
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      <Toaster position="top-center" />
      
      <div className="flex justify-end">
        <button 
          onClick={() => setIsModalOpen(true)}
          className="px-8 py-4 bg-primary-600 text-white rounded-2xl font-black shadow-lg shadow-primary-500/20 hover:bg-primary-700 transition-all flex items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          إضافة وحدة جديدة
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {items.map((item) => (
          <div key={item.id} className="bg-white dark:bg-slate-900 p-6 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 flex justify-between items-center group hover:border-primary-500/30 transition-all">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center text-primary-600 group-hover:bg-primary-600 group-hover:text-white transition-all">
                <Scale className="w-6 h-6" />
              </div>
              <div>
                <span className="font-black text-lg text-slate-800 dark:text-white block">{item.name_ar}</span>
                <span className="text-xs text-slate-400 font-bold uppercase">{item.name_en || '---'}</span>
              </div>
            </div>
            <button className="p-2 text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        ))}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 w-full max-md rounded-[32px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95">
             <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                <h3 className="text-xl font-black text-slate-900 dark:text-white">إضافة وحدة قياس</h3>
                <button onClick={() => setIsModalOpen(false)}><X className="w-6 h-6 text-slate-400" /></button>
             </div>
             <div className="p-8 space-y-4">
                <div className="space-y-2">
                   <label className="text-sm font-black text-slate-700 dark:text-slate-300">الإسم بالعربي *</label>
                   <input 
                      type="text" 
                      className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none outline-none focus:ring-2 focus:ring-primary-500 font-bold dark:text-white"
                      value={newItem.name_ar}
                      onChange={(e) => setNewItem({ ...newItem, name_ar: e.target.value })}
                   />
                </div>
                <div className="space-y-2">
                   <label className="text-sm font-black text-slate-700 dark:text-slate-300">الإسم بالإنجليزي</label>
                   <input 
                      type="text" 
                      className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none outline-none focus:ring-2 focus:ring-primary-500 font-bold dark:text-white"
                      dir="ltr"
                      value={newItem.name_en}
                      onChange={(e) => setNewItem({ ...newItem, name_en: e.target.value })}
                   />
                </div>
             </div>
             <div className="p-6 bg-slate-50 dark:bg-slate-800/50 flex gap-4">
                <button 
                   onClick={() => setIsModalOpen(false)}
                   className="flex-1 py-4 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-2xl font-black border border-slate-200 dark:border-slate-700 hover:bg-slate-100"
                >
                   إلغاء
                </button>
                <button 
                   disabled={isSaving}
                   onClick={handleAdd}
                   className="flex-1 py-4 bg-primary-600 text-white rounded-2xl font-black shadow-lg shadow-primary-500/20 hover:bg-primary-700 transition-all flex items-center justify-center gap-2"
                >
                   <Save className="w-5 h-5" />
                   {isSaving ? 'جاري الحفظ...' : 'حفظ الوحدة'}
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  )
}

'use client'

import React, { useState } from 'react'
import { Plus, Trash2, Save, X, Search, FlaskConical } from 'lucide-react'
import { toast, Toaster } from 'react-hot-toast'
import { addScientificGroupAction } from '@/app/actions-client/master-drugs'

interface ScientificGroup {
  id: number;
  name_ar: string;
  name_en?: string;
}

interface Props {
  initialData: ScientificGroup[];
}

export default function ScientificGroupsManagement({ initialData }: Props) {
  const [items, setItems] = useState<ScientificGroup[]>(initialData);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newItem, setNewItem] = useState({ name_ar: '', name_en: '' });
  const [isSaving, setIsSaving] = useState(false);

  const filteredItems = items.filter(item => 
    item.name_ar.includes(searchTerm) || 
    (item.name_en && item.name_en.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const handleAdd = async () => {
    if (!newItem.name_ar) {
      toast.error('يرجى إدخال الاسم بالعربي');
      return;
    }
    setIsSaving(true);
    const res = await addScientificGroupAction(newItem);
    setIsSaving(false);

    if (res.success) {
      setItems([...items, { id: res.id as number, ...newItem }]);
      setNewItem({ name_ar: '', name_en: '' });
      setIsModalOpen(false);
      toast.success('تمت إضافة المجموعة بنجاح');
    } else {
      toast.error(res.error || 'فشل إضافة المجموعة');
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      <Toaster position="top-center" />
      
      <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 flex flex-col md:flex-row gap-4 items-center">
        <div className="relative flex-1">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input 
            type="text" 
            placeholder="بحث في المجموعات العلمية..."
            className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none focus:ring-2 focus:ring-primary-500 font-bold dark:text-white"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        
        <button 
          onClick={() => setIsModalOpen(true)}
          className="px-8 py-4 bg-primary-600 text-white rounded-2xl font-black shadow-lg shadow-primary-500/20 hover:bg-primary-700 transition-all flex items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          إضافة مجموعة جديدة
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 overflow-hidden">
        <table className="w-full text-right">
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr>
              <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400">الكود</th>
              <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400">الإسم (ع)</th>
              <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400">الإسم (En)</th>
              <th className="px-6 py-4 font-black text-slate-600 dark:text-slate-400 text-center">الإجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-bold">
            {filteredItems.map((item) => (
              <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                <td className="px-6 py-4 text-slate-400">#{item.id}</td>
                <td className="px-6 py-4 text-slate-900 dark:text-white">{item.name_ar}</td>
                <td className="px-6 py-4 text-slate-500" dir="ltr">{item.name_en || '---'}</td>
                <td className="px-6 py-4">
                  <div className="flex justify-center gap-2">
                    <button className="p-2 text-slate-300 hover:text-red-500 transition-colors">
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[32px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95">
             <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                <h3 className="text-xl font-black text-slate-900 dark:text-white">إضافة مجموعة علمية</h3>
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
                   {isSaving ? 'جاري الحفظ...' : 'حفظ المجموعة'}
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  )
}

'use client'

import React, { useState } from 'react'
import { Plus, Trash2, Save, X, FlaskConical, Tags, Stethoscope, FileText, Activity, ClipboardList } from 'lucide-react'
import { toast, Toaster } from 'react-hot-toast'
import { cn } from '@/lib/utils'

const Icons = {
  FlaskConical,
  Tags,
  Stethoscope,
  FileText,
  Activity,
  ClipboardList
}

interface Props {
  initialData: string[];
  title: string;
  icon: keyof typeof Icons;
}

export default function GenericManagementClient({ initialData, title, icon }: Props) {
  const [data, setData] = useState<string[]>(initialData);
  const [newItem, setNewItem] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);

  const Icon = Icons[icon];

  const handleAdd = () => {
    if (!newItem) return;
    if (data.includes(newItem)) {
      toast.error('هذا البيان موجود بالفعل');
      return;
    }
    setData([...data, newItem]);
    setNewItem('');
    setIsModalOpen(false);
    toast.success('تمت الإضافة بنجاح');
  };

  return (
    <div className="space-y-6">
      <Toaster position="top-center" />
      
      <div className="flex justify-end">
        <button 
          onClick={() => setIsModalOpen(true)}
          className="px-8 py-4 bg-primary-600 text-white rounded-2xl font-black shadow-lg shadow-primary-500/20 hover:bg-primary-700 transition-all flex items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          إضافة {title}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {data.map((item, idx) => (
          <div key={idx} className="bg-white dark:bg-slate-900 p-6 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 flex justify-between items-center group hover:border-primary-500/30 transition-all">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center text-primary-600 group-hover:bg-primary-600 group-hover:text-white transition-all">
                <Icon className="w-6 h-6" />
              </div>
              <span className="font-black text-lg text-slate-800 dark:text-white">{item}</span>
            </div>
            <button className="p-2 text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        ))}
        {data.length === 0 && (
          <div className="col-span-full py-20 bg-slate-50 dark:bg-slate-800/30 rounded-[40px] border-2 border-dashed border-slate-200 dark:border-slate-700 flex flex-col items-center justify-center text-slate-400 gap-4">
             <Icon className="w-16 h-16 opacity-20" />
             <p className="font-black text-xl italic">لا توجد بيانات مضافة بعد</p>
          </div>
        )}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[32px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95">
             <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                <h3 className="text-xl font-black text-slate-900 dark:text-white">إضافة {title} جديدة</h3>
                <button onClick={() => setIsModalOpen(false)}><X className="w-6 h-6 text-slate-400" /></button>
             </div>
             <div className="p-8 space-y-4">
                <div className="space-y-2">
                   <label className="text-sm font-black text-slate-700 dark:text-slate-300">الاسم</label>
                   <input 
                      type="text" 
                      className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none outline-none focus:ring-2 focus:ring-primary-500 font-bold dark:text-white"
                      value={newItem}
                      onChange={(e) => setNewItem(e.target.value)}
                      autoFocus
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
                   onClick={handleAdd}
                   className="flex-1 py-4 bg-primary-600 text-white rounded-2xl font-black shadow-lg shadow-primary-500/20 hover:bg-primary-700 transition-all flex items-center justify-center gap-2"
                >
                   <Save className="w-5 h-5" />
                   حفظ
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  )
}

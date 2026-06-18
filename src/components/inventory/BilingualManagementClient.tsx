'use client'

import React, { useState, useEffect } from 'react'
import * as LucideIcons from 'lucide-react'
import { Plus, Trash2, Search, Save, X, Activity, Edit } from 'lucide-react'
import { toast, Toaster } from 'react-hot-toast'

interface Item {
  id: number;
  name_ar: string;
  name_en?: string;
}

interface Props {
  initialData: Item[];
  title: string;
  iconName: string;
  onAdd: (data: { name_ar: string, name_en?: string }) => Promise<{ success: boolean, id?: any, error?: string }>;
  onUpdate?: (id: number, data: { name_ar: string, name_en?: string }) => Promise<{ success: boolean, error?: string }>;
  onDelete?: (id: number) => Promise<{ success: boolean, error?: string }>;
}

export default function BilingualManagementClient({ 
  initialData, 
  title, 
  iconName, 
  onAdd,
  onUpdate,
  onDelete 
}: Props) {
  const Icon = (LucideIcons as any)[iconName] || Activity;
  const [items, setItems] = useState<Item[]>(initialData);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [formData, setFormData] = useState({ name_ar: '', name_en: '' });
  const [isSaving, setIsSaving] = useState(false);

  const ITEMS_PER_PAGE = 50;
  const [currentPage, setCurrentPage] = useState(1);

  // Reset to first page when searching
  const handleSearch = (val: string) => {
    setSearchTerm(val);
    setCurrentPage(1);
  };

  const filteredItems = items.filter(item => 
    item.name_ar.includes(searchTerm) || 
    (item.name_en && item.name_en.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
  const currentItems = filteredItems.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  const handleOpenAdd = () => {
    setEditingItem(null);
    setFormData({ name_ar: '', name_en: '' });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (item: Item) => {
    setEditingItem(item);
    setFormData({ name_ar: item.name_ar, name_en: item.name_en || '' });
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name_ar) {
      toast.error('يرجى إدخال الاسم بالعربي');
      return;
    }
    setIsSaving(true);
    
    if (editingItem && onUpdate) {
      const res = await onUpdate(editingItem.id, formData);
      if (res.success) {
        setItems(items.map(i => i.id === editingItem.id ? { ...i, ...formData } : i));
        toast.success(`تم تحديث ${title} بنجاح`);
        setIsModalOpen(false);
      } else {
        toast.error(res.error || 'فشل التحديث');
      }
    } else {
      const res = await onAdd(formData);
      if (res.success) {
        setItems([{ id: res.id as number, ...formData }, ...items]);
        toast.success(`تمت إضافة ${title} بنجاح`);
        setIsModalOpen(false);
      } else {
        toast.error(res.error || `فشل إضافة ${title}`);
      }
    }
    setIsSaving(false);
  };

  const handleDelete = async (id: number) => {
    if (!onDelete) return;
    if (!confirm('هل أنت متأكد من الحذف؟')) return;

    const res = await onDelete(id);
    if (res.success) {
      setItems(items.filter(i => i.id !== id));
      toast.success(`تم حذف ${title} بنجاح`);
    } else {
      toast.error(res.error || 'فشل الحذف');
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      if (e.key === 'Escape') {
        setIsModalOpen(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, formData, editingItem, items, isSaving]);

  return (
    <div className="space-y-6" dir="rtl">
      <Toaster position="top-center" />
      
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-soft border border-slate-100 dark:border-slate-800 flex flex-wrap gap-4 items-center justify-between">
        <div className="relative flex-1 min-w-[300px]">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input 
            type="text"
            placeholder={`بحث في ${title}...`}
            className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none outline-none focus:ring-4 focus:ring-primary-500/10 font-bold dark:text-white"
            value={searchTerm}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        <button 
          onClick={handleOpenAdd}
          className="px-8 py-4 bg-primary-600 text-white rounded-2xl font-black shadow-lg shadow-primary-500/20 hover:bg-primary-700 transition-all flex items-center gap-2"
        >
          <Plus className="w-6 h-6" />
          إضافة {title} جديد
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {currentItems.map((item) => (
          <div key={item.id} className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-soft group hover:border-primary-500/30 transition-all flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-start mb-4">
                <div className="w-12 h-12 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center text-slate-400 group-hover:bg-primary-500 group-hover:text-white transition-all">
                  <Icon className="w-6 h-6" />
                </div>
                <span className="text-xs font-black text-slate-300">#{item.id}</span>
              </div>
              <h3 className="text-xl font-black text-slate-900 dark:text-white mb-1">{item.name_ar}</h3>
              <p className="text-slate-400 font-bold uppercase text-xs tracking-widest">{item.name_en || '---'}</p>
            </div>
            
            <div className="mt-6 pt-6 border-t border-slate-50 dark:border-slate-800 flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-all">
               <button 
                 onClick={() => handleOpenEdit(item)}
                 className="p-3 text-slate-400 hover:text-primary-500 rounded-xl hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-all"
               >
                 <Edit className="w-5 h-5" />
               </button>
               {onDelete && (
                 <button 
                   onClick={() => handleDelete(item.id)}
                   className="p-3 text-slate-400 hover:text-red-500 rounded-xl hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
                 >
                   <Trash2 className="w-5 h-5" />
                 </button>
               )}
            </div>
          </div>
        ))}
        
        {filteredItems.length === 0 && (
          <div className="col-span-full py-20 text-center text-slate-400 italic font-bold">
             لا توجد بيانات تطابق بحثك.
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center items-center gap-4 mt-8">
          <button 
            disabled={currentPage === 1}
            onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
            className="px-6 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl font-black text-slate-600 disabled:opacity-50 hover:bg-slate-50 transition-all"
          >
            السابق
          </button>
          <div className="font-bold text-slate-500 bg-white dark:bg-slate-900 px-6 py-3 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
            {currentPage} / {totalPages}
          </div>
          <button 
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
            className="px-6 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl font-black text-slate-600 disabled:opacity-50 hover:bg-slate-50 transition-all"
          >
            التالي
          </button>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[32px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95">
             <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white">
                  {editingItem ? `تعديل ${title}` : `إضافة ${title}`}
                </h3>
                <button onClick={() => setIsModalOpen(false)}><X className="w-8 h-8 text-slate-400" /></button>
             </div>
             <div className="p-8 space-y-6">
                <div className="space-y-2">
                   <label className="text-sm font-black text-slate-700 dark:text-slate-300 mr-2">الإسم بالعربي *</label>
                   <input 
                      type="text" 
                      className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none outline-none focus:ring-4 focus:ring-primary-500/10 font-black dark:text-white border-2 border-transparent focus:border-primary-500"
                      value={formData.name_ar}
                      onChange={(e) => setFormData({ ...formData, name_ar: e.target.value })}
                   />
                </div>
                <div className="space-y-2">
                   <label className="text-sm font-black text-slate-700 dark:text-slate-300 mr-2">الإسم بالإنجليزي</label>
                   <input 
                      type="text" 
                      className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none outline-none focus:ring-4 focus:ring-primary-500/10 font-black dark:text-white border-2 border-transparent focus:border-primary-500"
                      dir="ltr"
                      value={formData.name_en}
                      onChange={(e) => setFormData({ ...formData, name_en: e.target.value })}
                   />
                </div>
             </div>
             <div className="p-8 bg-slate-50 dark:bg-slate-800/50 flex gap-4">
                <button 
                   onClick={() => setIsModalOpen(false)}
                   className="flex-1 py-5 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-2xl font-black border border-slate-200 dark:border-slate-700 hover:bg-slate-100"
                >إلغاء</button>
                <button 
                   disabled={isSaving}
                   onClick={handleSave}
                   className="flex-1 py-5 bg-primary-600 text-white rounded-2xl font-black shadow-lg shadow-primary-500/20 hover:bg-primary-700 transition-all flex items-center justify-center gap-2"
                >
                   <Save className="w-6 h-6" />
                   {isSaving ? 'جاري الحفظ...' : 'حفظ'}
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  )
}

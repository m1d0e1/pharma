'use client'

import React, { useState, useMemo } from 'react'
import { Plus, Trash2, ChevronRight, ChevronDown, Folder, FolderOpen, Save, X, Edit3 } from 'lucide-react'
import { toast, Toaster } from 'react-hot-toast'

interface Category {
  id: number;
  parent_id: number | null;
  name_ar: string;
  name_en?: string;
}

interface Props {
  initialData: Category[];
  onAdd: (data: { name_ar: string, name_en?: string, parent_id: number | null }) => Promise<{ success: boolean, id?: any, error?: string }>;
  onUpdate: (id: number, data: { name_ar: string, name_en?: string, parent_id: number | null }) => Promise<{ success: boolean, error?: string }>;
  onDelete: (id: number) => Promise<{ success: boolean, error?: string }>;
}

export default function ProductCategoriesManagement({ initialData, onAdd, onUpdate, onDelete }: Props) {
  const [items, setItems] = useState<Category[]>(initialData);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Category | null>(null);
  const [formData, setFormData] = useState({ name_ar: '', name_en: '', parent_id: null as number | null });
  const [isSaving, setIsSaving] = useState(false);

  // Build tree structure
  const treeData = useMemo(() => {
    const map = new Map<number | null, any[]>();
    items.forEach(item => {
      const parentId = item.parent_id;
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId)!.push({ ...item, children: [] });
    });
    
    const build = (parentId: number | null): any[] => {
      const children = map.get(parentId) || [];
      return children.map(child => ({
        ...child,
        children: build(child.id)
      }));
    };
    
    return build(null);
  }, [items]);

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };

  const handleOpenAdd = (parentId: number | null = null) => {
    setEditingItem(null);
    setFormData({ name_ar: '', name_en: '', parent_id: parentId });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (category: Category) => {
    setEditingItem(category);
    setFormData({ 
      name_ar: category.name_ar, 
      name_en: category.name_en || '', 
      parent_id: category.parent_id 
    });
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name_ar) {
      toast.error('يرجى إدخال الاسم بالعربي');
      return;
    }
    setIsSaving(true);
    
    if (editingItem) {
      const res = await onUpdate(editingItem.id, formData);
      if (res.success) {
        setItems(items.map(i => i.id === editingItem.id ? { ...i, ...formData } : i));
        toast.success('تم تحديث المجموعة بنجاح');
        setIsModalOpen(false);
      } else {
        toast.error(res.error || 'فشل التحديث');
      }
    } else {
      const res = await onAdd(formData);
      if (res.success) {
        setItems([...items, { id: res.id as number, ...formData }]);
        toast.success('تمت إضافة المجموعة بنجاح');
        setIsModalOpen(false);
      } else {
        toast.error(res.error || 'فشل الإضافة');
      }
    }
    setIsSaving(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('هل أنت متأكد من حذف هذه المجموعة؟')) return;
    
    const res = await onDelete(id);
    if (res.success) {
      setItems(items.filter(i => i.id !== id));
      setSelectedId(null);
      toast.success('تم حذف المجموعة');
    } else {
      toast.error(res.error || 'فشل الحذف');
    }
  };

  const renderNode = (node: any, depth = 0) => {
    const isExpanded = expandedIds.has(node.id);
    const hasChildren = node.children.length > 0;
    const isSelected = selectedId === node.id;

    return (
      <div key={node.id} className="select-none">
        <div 
          className={`flex items-center gap-2 py-2 px-3 rounded-xl cursor-pointer transition-all ${isSelected ? 'bg-primary-600 text-white shadow-md shadow-primary-500/20' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'}`}
          onClick={() => setSelectedId(node.id)}
          style={{ marginRight: `${depth * 24}px` }}
        >
          <div 
            className="p-1 hover:bg-black/5 rounded-md transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(node.id);
            }}
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
            ) : (
              <div className="w-4 h-4" />
            )}
          </div>
          {isExpanded ? <FolderOpen className={`w-5 h-5 ${isSelected ? 'text-white' : 'text-amber-500'}`} /> : <Folder className={`w-5 h-5 ${isSelected ? 'text-white' : 'text-amber-500'}`} />}
          <span className="font-bold">{node.name_ar}</span>
          <span className={`text-xs font-bold uppercase opacity-60 mr-auto ${isSelected ? 'text-white/80' : ''}`}>{node.name_en}</span>
        </div>
        
        {isExpanded && node.children.length > 0 && (
          <div className="mt-1 animate-in slide-in-from-right-2 duration-200">
            {node.children.map((child: any) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const selectedCategory = items.find(i => i.id === selectedId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8" dir="rtl">
      <Toaster position="top-center" />
      
      {/* Tree Side */}
      <div className="lg:col-span-5 space-y-6">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-soft border border-slate-100 dark:border-slate-800 h-[600px] flex flex-col">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
              <Folder className="w-6 h-6 text-primary-500" />
              شجرة المجموعات
            </h3>
            <button 
              onClick={() => handleOpenAdd(selectedId)}
              className="p-3 bg-slate-900 dark:bg-slate-700 text-white rounded-2xl hover:bg-slate-800 transition-all shadow-lg shadow-slate-900/20"
            >
              <Plus className="w-6 h-6" />
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1">
            {treeData.map(node => renderNode(node))}
            {treeData.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4 italic font-bold">
                <Folder className="w-12 h-12 opacity-20" />
                <span>لا توجد مجموعات معرفة بعد.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Detail Side */}
      <div className="lg:col-span-7">
        <div className="bg-white dark:bg-slate-900 p-10 rounded-[40px] shadow-soft border border-slate-100 dark:border-slate-800 h-full min-h-[400px]">
          {selectedCategory ? (
            <div className="space-y-8 animate-in fade-in duration-500">
              <div className="flex justify-between items-start">
                <div>
                  <span className="inline-block px-4 py-1.5 bg-primary-100 dark:bg-primary-900/30 text-primary-600 rounded-xl text-sm font-black mb-3">كود المجموعة: {selectedCategory.id}</span>
                  <h2 className="text-3xl font-black text-slate-900 dark:text-white">{selectedCategory.name_ar}</h2>
                  <p className="text-slate-400 font-bold mt-1 uppercase tracking-widest">{selectedCategory.name_en || '---'}</p>
                </div>
                <div className="flex gap-2">
                   <button 
                     onClick={() => handleOpenEdit(selectedCategory)}
                     className="p-4 bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-primary-600 rounded-3xl transition-all border border-transparent hover:border-primary-500/30 shadow-sm"
                   >
                     <Edit3 className="w-6 h-6" />
                   </button>
                   <button 
                     onClick={() => handleDelete(selectedCategory.id)}
                     className="p-4 bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-red-600 rounded-3xl transition-all border border-transparent hover:border-red-500/30 shadow-sm"
                   >
                     <Trash2 className="w-6 h-6" />
                   </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 pt-8 border-t border-slate-50 dark:border-slate-800">
                 <div className="bg-slate-50 dark:bg-slate-800/50 p-6 rounded-3xl">
                    <span className="block text-xs font-black text-slate-400 mb-2">المجموعة الأب</span>
                    <span className="font-black text-slate-700 dark:text-white">
                       {items.find(i => i.id === selectedCategory.parent_id)?.name_ar || 'مجموعة رئيسية'}
                    </span>
                 </div>
                 <div className="bg-slate-50 dark:bg-slate-800/50 p-6 rounded-3xl">
                    <span className="block text-xs font-black text-slate-400 mb-2">عدد المجموعات الفرعية</span>
                    <span className="font-black text-slate-700 dark:text-white text-2xl">
                       {items.filter(i => i.parent_id === selectedCategory.id).length}
                    </span>
                 </div>
              </div>
              
              <div className="pt-6">
                <button 
                  onClick={() => handleOpenAdd(selectedCategory.id)}
                  className="w-full py-5 bg-primary-600 text-white rounded-[24px] font-black shadow-lg shadow-primary-500/20 hover:bg-primary-700 transition-all flex items-center justify-center gap-3"
                >
                  <Plus className="w-6 h-6" />
                  إضافة مجموعة فرعية جديدة هنا
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-300 gap-6">
               <div className="w-24 h-24 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center">
                  <ChevronRight className="w-12 h-12 rotate-45" />
               </div>
               <p className="text-xl font-black italic">قم باختيار مجموعة من الشجرة لعرض تفاصيلها أو تعديلها</p>
            </div>
          )}
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[32px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95">
             <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white">
                  {editingItem ? 'تعديل مجموعة' : 'إضافة مجموعة'}
                </h3>
                <button onClick={() => setIsModalOpen(false)}><X className="w-8 h-8 text-slate-400" /></button>
             </div>
             <div className="p-8 space-y-6">
                <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700">
                   <span className="block text-xs font-black text-slate-400 mb-1">تابعة لـ</span>
                   <span className="font-black text-primary-600">
                      {items.find(i => i.id === formData.parent_id)?.name_ar || 'مجموعة رئيسية (Top Level)'}
                   </span>
                </div>
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
                   {isSaving ? 'جاري الحفظ...' : 'حفظ المجموعة'}
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  )
}

'use client';

import React, { useState, useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook';
import { X, Package, Calendar, History, BarChart2, Info, ArrowLeftRight, ShieldCheck, TrendingUp, AlertTriangle, Truck, DollarSign, Layers, ArrowRight, Edit, Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'react-hot-toast';
import { getDrugDetailsFullAction } from '@/app/actions-client/inventory';
import { updateMasterDrugAction, searchMasterDrugsAction, addDrugAlternativeAction, removeDrugAlternativeAction, addDrugInteractionAction, removeDrugInteractionAction } from '@/app/actions-client/master-drugs';

interface DrugDetailsModalProps {
  drugId: number | string;
  onClose: () => void;
}

export default function DrugDetailsModal({ drugId, onClose }: DrugDetailsModalProps) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const [activeTab, setActiveTab] = useState<'info' | 'expiry' | 'stock' | 'alternatives' | 'usage' | 'consumption' | 'units_suppliers' | 'financial' | 'advanced'>('info');
  const [altSubTab, setAltSubTab] = useState<'alternatives' | 'conflicts'>('alternatives');
  const [loading, setLoading] = useState(true);
  const [drugData, setDrugData] = useState<any>(null);
  
  const [currentId, setCurrentId] = useState(drugId);
  const [history, setHistory] = useState<(number | string)[]>([]);

  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<any>(null);

  const [altSearchQuery, setAltSearchQuery] = useState('');
  const [altSearchResults, setAltSearchResults] = useState<any[]>([]);
  const [isSearchingAlt, setIsSearchingAlt] = useState(false);

  const [conflictIngredientA, setConflictIngredientA] = useState('');
  const [conflictIngredientB, setConflictIngredientB] = useState('');
  const [conflictSeverity, setConflictSeverity] = useState('minor');
  const [expandedConflicts, setExpandedConflicts] = useState<number[]>([]);

  React.useEffect(() => {
    setCurrentId(drugId);
    setHistory([]);
  }, [drugId]);

  const loadDrugDetails = async (id: number | string) => {
    setLoading(true);
    try {
      const result = await getDrugDetailsFullAction(id);
      if (result.success) {
        setDrugData(result.data);
        setFormData(result.data);
      }
    } catch (error) {
      console.error('Failed to load drug details:', error);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    loadDrugDetails(currentId);
  }, [currentId]);

  const handleSearchAlt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setAltSearchQuery(query);
    if (query.length > 2) {
      setIsSearchingAlt(true);
      const res = await searchMasterDrugsAction(query);
      if (res.success && res.data) {
        setAltSearchResults(res.data);
      }
      setIsSearchingAlt(false);
    } else {
      setAltSearchResults([]);
    }
  };

  const handleAddAlternative = async (altId: number) => {
     const res = await addDrugAlternativeAction(drugData.id, altId);
     if (res.success) {
        toast.success('تمت إضافة البديل بنجاح');
        setAltSearchQuery('');
        setAltSearchResults([]);
        loadDrugDetails(currentId);
     } else {
        toast.error(res.error || 'حدث خطأ');
     }
  };

  const handleRemoveAlternative = async (altId: number, e: React.MouseEvent) => {
     e.stopPropagation();
     const res = await removeDrugAlternativeAction(drugData.id, altId);
     if (res.success) {
        toast.success('تمت إزالة البديل بنجاح');
        loadDrugDetails(currentId);
     } else {
        toast.error(res.error || 'حدث خطأ');
     }
  };

  const handleAddConflict = async () => {
    if (!conflictIngredientA || !conflictIngredientB) {
       toast.error('يجب إدخال المواد الفعالة');
       return;
    }
    const res = await addDrugInteractionAction(conflictIngredientA, conflictIngredientB, conflictSeverity);
    if (res.success) {
       toast.success('تمت إضافة التفاعل الدوائي بنجاح');
       setConflictIngredientB('');
       loadDrugDetails(currentId);
    } else {
       toast.error(res.error || 'حدث خطأ');
    }
  };

  const handleRemoveConflict = async (id: number) => {
    const res = await removeDrugInteractionAction(id);
    if (res.success) {
       toast.success('تمت إزالة التفاعل الدوائي بنجاح');
       loadDrugDetails(currentId);
    } else {
       toast.error(res.error || 'حدث خطأ');
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl animate-pulse flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="font-bold text-slate-500">جاري تحميل بيانات الصنف...</p>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    try {
      const res = await updateMasterDrugAction(currentId as number, formData);
      if (res.success) {
        toast.success('تم حفظ التعديلات بنجاح');
        setDrugData(formData);
        setIsEditing(false);
      } else {
        toast.error(res.error || 'فشل الحفظ');
      }
    } catch(err) {
       toast.error('حدث خطأ أثناء الحفظ');
    }
  };

  const tabs = [
    { id: 'info', label: 'بيانات الصنف', icon: Info },
    { id: 'units_suppliers', label: 'الوحدات والموردين', icon: Truck },
    { id: 'expiry', label: 'توارِيخ الصلاحية', icon: Calendar },
    { id: 'stock', label: 'أرصدة المخازن', icon: Package },
    { id: 'alternatives', label: 'البدائل', icon: ArrowLeftRight },
    { id: 'usage', label: 'دواعي الاستعمال', icon: ShieldCheck },
    { id: 'consumption', label: 'م. استهلاك', icon: TrendingUp },
  ];

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 w-full max-w-5xl rounded-[40px] shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in duration-300" dir="rtl">
        
        {/* Header */}
        <div className="p-8 bg-gradient-to-r from-blue-600 to-indigo-700 text-white flex justify-between items-center shrink-0">
          <div className="flex items-center gap-6">
             <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center border border-white/20">
                <Package className="w-8 h-8" />
             </div>
             <div>
               <h3 className="text-3xl font-black">{drugData?.trade_name || drugData?.trade_name_en || drugData?.active_ingredient || 'صنف بدون اسم'}</h3>
               <p className="text-blue-100 font-bold mt-1">
                 {drugData?.trade_name_en && `${drugData.trade_name_en} | `}
                 {drugData?.active_ingredient}
               </p>
             </div>
          </div>
          <div className="flex items-center gap-2">
            {isEditing ? (
              <>
                <button onClick={handleSave} className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl transition-all font-bold flex items-center gap-2">
                  <Save className="w-4 h-4" /> حفظ
                </button>
                <button onClick={() => { setIsEditing(false); setFormData(drugData); }} className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl transition-all font-bold">
                  إلغاء
                </button>
              </>
            ) : (
              <button onClick={() => setIsEditing(true)} className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl transition-all font-bold flex items-center gap-2">
                <Edit className="w-4 h-4" /> تعديل
              </button>
            )}
            {history.length > 0 && (
              <button 
                onClick={() => {
                  const newHistory = [...history];
                  const prevId = newHistory.pop();
                  setHistory(newHistory);
                  if (prevId) setCurrentId(prevId);
                }} 
                className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl transition-all"
                title="رجوع للصنف السابق"
              >
                <ArrowRight className="w-6 h-6" />
              </button>
            )}
            <button onClick={onClose} className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl transition-all">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Tabs Bar */}
        <div className="flex bg-slate-50 dark:bg-slate-800/50 p-2 gap-2 border-b border-slate-100 dark:border-slate-800 shrink-0 overflow-x-auto no-scrollbar">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={cn(
                "flex items-center gap-2 px-6 py-3 rounded-2xl font-black text-sm transition-all whitespace-nowrap",
                activeTab === tab.id 
                  ? "bg-white dark:bg-slate-900 text-blue-600 shadow-sm border border-slate-100 dark:border-slate-700" 
                  : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              )}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-slate-50/30 dark:bg-slate-950/30">
          {activeTab === 'info' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-in fade-in slide-in-from-bottom-4">
              <InfoItem label="كود 1" value={isEditing ? formData?.id : drugData?.id} isEditing={false} />
              <InfoItem label="كود 2" value={isEditing ? formData?.code_2 : drugData?.code_2 || '---'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, code_2: val})} />
              <InfoItem label="الباركود" value={isEditing ? formData?.barcode : drugData?.barcode || '---'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, barcode: val})} />
              <InfoItem label="الشركة المنتجة" value={isEditing ? formData?.manufacturer : drugData?.manufacturer || '---'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, manufacturer: val})} />
              <InfoItem label="المادة الفعالة" value={isEditing ? formData?.active_ingredient : drugData?.active_ingredient || '---'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, active_ingredient: val})} />
              <InfoItem label="نسبة المادة" value={isEditing ? formData?.active_ingredient_ratio : drugData?.active_ingredient_ratio || '---'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, active_ingredient_ratio: val})} />
              <InfoItem label="المجموعة العلمية" value={isEditing ? formData?.category : drugData?.scientific_group || drugData?.category || '---'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, category: val})} />
              <InfoItem label="طبيعة الصنف" value={isEditing ? formData?.item_nature : drugData?.item_nature || '---'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, item_nature: val})} />
              <InfoItem label="طريقة الاستخدام" value={isEditing ? formData?.usage_method : drugData?.usage_method || '---'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, usage_method: val})} />
              <InfoItem label="المنشأ" value={isEditing ? formData?.origin : drugData?.origin || 'محلل'} isEditing={isEditing} onChange={(val: string) => setFormData({...formData, origin: val})} />
              <InfoItem label="السعر الرسمي" value={isEditing ? formData?.official_price : `${drugData?.official_price} ج.م`} type="number" isEditing={isEditing} onChange={(val: string) => setFormData({...formData, official_price: Number(val)})} color="text-emerald-600" />
              <InfoItem label="سعر البيع" value={isEditing ? formData?.min_price : `${drugData?.min_price} ج.م`} isEditing={false} color="text-blue-600" />
              
              <div className="col-span-full grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                 <StatusTag label="أدوية" active={isEditing ? formData?.is_medicine : drugData?.is_medicine} isEditing={isEditing} onChange={(val: boolean) => setFormData({...formData, is_medicine: val ? 1 : 0})} />
                 <StatusTag label="خدمة" active={isEditing ? formData?.is_service : drugData?.is_service} isEditing={isEditing} onChange={(val: boolean) => setFormData({...formData, is_service: val ? 1 : 0})} />
                 <StatusTag label="تبريد" active={isEditing ? formData?.is_refrigerated : drugData?.is_refrigerated} isEditing={isEditing} onChange={(val: boolean) => setFormData({...formData, is_refrigerated: val ? 1 : 0})} />
                 <StatusTag label="مزمن" active={isEditing ? formData?.is_chronic : drugData?.is_chronic} isEditing={isEditing} onChange={(val: boolean) => setFormData({...formData, is_chronic: val ? 1 : 0})} />
                 <StatusTag label="صلاحية" active={isEditing ? formData?.has_expiry : drugData?.has_expiry} isEditing={isEditing} onChange={(val: boolean) => setFormData({...formData, has_expiry: val ? 1 : 0})} />
                 <StatusTag label="صنف جدول" active={isEditing ? formData?.is_table : drugData?.is_table} isEditing={isEditing} onChange={(val: boolean) => setFormData({...formData, is_table: val ? 1 : 0})} />
              </div>

              <div className="col-span-full bg-amber-50 dark:bg-amber-900/10 p-5 rounded-3xl border border-amber-100 dark:border-amber-900/20">
                <p className="text-[10px] font-black text-amber-800 dark:text-amber-400 uppercase tracking-widest mb-1">ملاحظات إضافية</p>
                {isEditing ? (
                  <textarea 
                    value={formData?.notes || ''} 
                    onChange={(e) => setFormData({...formData, notes: e.target.value})}
                    className="w-full bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-sm font-bold text-slate-700 dark:text-slate-300 min-h-[100px]"
                  />
                ) : (
                  <p className="font-bold text-slate-700 dark:text-slate-300 text-sm">{drugData?.notes || 'لا يوجد ملاحظات مسجلة لهذا الصنف حالياً'}</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'units_suppliers' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                   <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 space-y-4 shadow-sm">
                      <h4 className="font-black text-xs text-slate-400 uppercase tracking-widest flex items-center gap-2">
                         <Layers className="w-4 h-4" /> تعريف الوحدات
                      </h4>
                      <div className="space-y-3">
                         <UnitRow 
                            label="الوحدة الكبرى" 
                            value={isEditing ? formData?.large_unit : drugData?.large_unit || drugData?.units?.large} 
                            isEditing={isEditing} 
                            onChange={(val: string) => setFormData({...formData, large_unit: val})}
                         />
                         <UnitRow 
                            label="الوحدة المتوسطة" 
                            value={isEditing ? formData?.medium_unit : drugData?.medium_unit || drugData?.units?.medium} 
                            factor={isEditing ? formData?.large_to_medium : drugData?.large_to_medium} 
                            isEditing={isEditing} 
                            onChange={(val: string) => setFormData({...formData, medium_unit: val})}
                            onChangeFactor={(val: number) => setFormData({...formData, large_to_medium: val})}
                         />
                         <UnitRow 
                            label="الوحدة الصغرى" 
                            value={isEditing ? formData?.small_unit : drugData?.small_unit || drugData?.units?.small} 
                            factor={isEditing ? formData?.medium_to_small : drugData?.medium_to_small} 
                            isEditing={isEditing} 
                            onChange={(val: string) => setFormData({...formData, small_unit: val})}
                            onChangeFactor={(val: number) => setFormData({...formData, medium_to_small: val})}
                         />
                      </div>
                   </div>

                   <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 space-y-4 shadow-sm">
                      <h4 className="font-black text-xs text-slate-400 uppercase tracking-widest flex items-center gap-2">
                         <TrendingUp className="w-4 h-4" /> حدود الطلب
                      </h4>
                      <div className="space-y-3">
                         <UnitRow 
                            label="الحد الأقصى" 
                            value={isEditing ? formData?.max_limit : drugData?.max_limit || 0} 
                            isEditing={isEditing} 
                            type="number"
                            onChange={(val: number) => setFormData({...formData, max_limit: val})}
                         />
                         <UnitRow 
                            label="الحد الأدنى" 
                            value={isEditing ? formData?.min_limit : drugData?.min_limit || 0} 
                            isEditing={isEditing} 
                            type="number"
                            onChange={(val: number) => setFormData({...formData, min_limit: val})}
                         />
                         <UnitRow 
                            label="نقطة الطلب" 
                            value={isEditing ? formData?.reorder_point : drugData?.reorder_point || 0} 
                            isEditing={isEditing} 
                            type="number"
                            onChange={(val: number) => setFormData({...formData, reorder_point: val})}
                         />
                      </div>
                   </div>

                   <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 space-y-4 shadow-sm">
                      <h4 className="font-black text-xs text-slate-400 uppercase tracking-widest flex items-center gap-2">
                         <DollarSign className="w-4 h-4" /> القيم الافتراضية
                      </h4>
                      <div className="space-y-3">
                         <UnitRow 
                            label="كمية الشراء" 
                            value={isEditing ? formData?.default_purchase_qty : drugData?.default_purchase_qty || 1} 
                            isEditing={isEditing} 
                            type="number"
                            onChange={(val: number) => setFormData({...formData, default_purchase_qty: val})}
                         />
                         <UnitRow 
                            label="الضريبة %" 
                            value={isEditing ? formData?.tax_percent : drugData?.tax_percent || 0} 
                            isEditing={isEditing} 
                            type="number"
                            onChange={(val: number) => setFormData({...formData, tax_percent: val})}
                         />
                         <UnitRow 
                            label="الخصم %" 
                            value={isEditing ? formData?.discount_percent : drugData?.discount_percent || 0} 
                            isEditing={isEditing} 
                            type="number"
                            onChange={(val: number) => setFormData({...formData, discount_percent: val})}
                         />
                      </div>
                   </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 overflow-hidden shadow-hard">
                   <div className="p-6 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center">
                      <h4 className="font-black text-slate-900 dark:text-white flex items-center gap-2">
                         <Truck className="w-5 h-5 text-primary-500" /> سجل الموردين والأسعار
                      </h4>
                   </div>
                   <div className="overflow-x-auto">
                      <table className="w-full text-right">
                         <thead className="bg-slate-50/50 dark:bg-slate-900/50">
                            <tr>
                               <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">المورد</th>
                               <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase text-center">سعر الشراء</th>
                               <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase text-center">الضريبة</th>
                               <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase text-center">سعر البيع</th>
                               <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase text-center">الخصم</th>
                               <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase text-left">التاريخ</th>
                            </tr>
                         </thead>
                         <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {drugData?.supplier_history?.length > 0 ? drugData.supplier_history.map((h: any, idx: number) => (
                               <tr key={idx} className="hover:bg-primary-500/5 transition-colors">
                                  <td className="px-6 py-4 font-bold text-slate-700 dark:text-slate-200">{h.supplier_name}</td>
                                  <td className="px-6 py-4 font-black text-center text-blue-600">{h.cost_price?.toFixed(2)}</td>
                                  <td className="px-6 py-4 font-bold text-center text-slate-500">{h.tax_percent}%</td>
                                  <td className="px-6 py-4 font-black text-center text-emerald-600">{h.selling_price?.toFixed(2)}</td>
                                  <td className="px-6 py-4 font-bold text-center text-rose-500">{h.discount_percent}%</td>
                                  <td className="px-6 py-4 font-bold text-left text-slate-400 text-xs">{h.invoice_date}</td>
                               </tr>
                            )) : (
                               <tr>
                                  <td colSpan={6} className="py-12 text-center text-slate-400 font-bold italic">لا يوجد سجل مشتريات لهذا الصنف حالياً</td>
                               </tr>
                            )}
                         </tbody>
                      </table>
                   </div>
                </div>
             </div>
          )}

          {activeTab === 'expiry' && (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
               {drugData?.expiry_batches?.length > 0 ? (
                 <table className="w-full text-right border-collapse">
                    <thead className="bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
                      <tr>
                        <th className="p-4 text-xs font-black text-slate-500">رقم التشغيلة</th>
                        <th className="p-4 text-xs font-black text-slate-500">تاريخ الصلاحية</th>
                        <th className="p-4 text-xs font-black text-slate-500 text-center">الكمية المتاحة</th>
                        <th className="p-4 text-xs font-black text-slate-500">الحالة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {drugData.expiry_batches.map((batch: any, i: number) => (
                        <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                          <td className="p-4 font-bold">{batch.batch_number || '---'}</td>
                          <td className="p-4 font-bold text-blue-600">{batch.expiry_date}</td>
                          <td className="p-4 font-black text-center">{batch.quantity}</td>
                          <td className="p-4">
                             <span className={cn(
                               "px-3 py-1 rounded-full text-[10px] font-bold",
                               batch.is_expired ? "bg-red-100 text-red-600" : "bg-emerald-100 text-emerald-600"
                             )}>
                               {batch.is_expired ? 'منتهي الصلاحية' : 'صالح'}
                             </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                 </table>
               ) : (
                 <NoData icon={Calendar} message="لا يوجد بيانات صلاحية مسجلة حالياً" />
               )}
            </div>
          )}

          {activeTab === 'stock' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
               <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <StockCard label="المخزن الرئيسي" value={drugData?.total_stock} color="bg-blue-500" />
                  <StockCard label="الصيدلية" value={drugData?.total_stock} color="bg-emerald-500" />
                  <StockCard label="أرصدة محجوزة" value="0" color="bg-slate-400" />
               </div>
               
               <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-100 dark:border-slate-700">
                  <h4 className="font-black mb-4 text-slate-500 text-xs uppercase tracking-widest">توزيع الوحدات (الأرصدة الصغرى)</h4>
                  <div className="flex justify-between items-center bg-slate-50 dark:bg-slate-900/50 p-6 rounded-2xl border border-slate-100 dark:border-slate-800">
                     <UnitBalance label={`علبة (${drugData?.units?.large})`} value={drugData?.total_stock} />
                     <div className="w-px h-10 bg-slate-200 dark:bg-slate-700" />
                     <UnitBalance label={`شريط (${drugData?.units?.medium})`} value={drugData?.total_stock * (drugData?.large_to_medium || 1)} />
                     <div className="w-px h-10 bg-slate-200 dark:bg-slate-700" />
                     <UnitBalance label={`قرص (${drugData?.units?.small})`} value={drugData?.total_stock * (drugData?.large_to_medium || 1) * (drugData?.medium_to_small || 1)} />
                  </div>
               </div>
            </div>
          )}

          {activeTab === 'alternatives' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
               {/* Sub-Tabs Selector */}
               <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl w-fit">
                  <button 
                    onClick={() => setAltSubTab('alternatives')}
                    className={cn(
                      "px-6 py-2 rounded-xl text-xs font-black transition-all",
                      altSubTab === 'alternatives' ? "bg-white dark:bg-slate-900 text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                    )}
                  >الأصناف البديلة</button>
                  <button 
                    onClick={() => setAltSubTab('conflicts')}
                    className={cn(
                      "px-6 py-2 rounded-xl text-xs font-black transition-all",
                      altSubTab === 'conflicts' ? "bg-white dark:bg-slate-900 text-rose-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                    )}
                  >الأدوية المتعارضة</button>
               </div>

                {altSubTab === 'alternatives' ? (
                 <div className="space-y-4">
                    {isEditing && (
                      <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-100 dark:border-slate-700 relative">
                         <input 
                           type="text" 
                           placeholder="بحث عن دواء لإضافته كبديل..." 
                           value={altSearchQuery}
                           onChange={handleSearchAlt}
                           className="w-full bg-slate-50 dark:bg-slate-900 border-none rounded-xl p-3 text-sm font-bold text-slate-800 dark:text-white"
                         />
                         {altSearchResults.length > 0 && (
                            <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-xl shadow-xl max-h-60 overflow-y-auto z-10 p-2 space-y-1">
                               {altSearchResults.map((res: any) => (
                                  <div 
                                    key={res.id} 
                                    onClick={() => handleAddAlternative(res.id)}
                                    className="p-3 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg cursor-pointer flex justify-between items-center"
                                  >
                                     <div>
                                        <p className="font-bold text-sm text-slate-800 dark:text-white">{res.trade_name}</p>
                                        <p className="text-[10px] text-slate-500">{res.active_ingredient}</p>
                                     </div>
                                     <button className="text-xs font-bold text-blue-600 bg-blue-50 dark:bg-blue-900/30 px-3 py-1 rounded-md">إضافة</button>
                                  </div>
                               ))}
                            </div>
                         )}
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                       {drugData?.alternatives?.length > 0 ? [...drugData.alternatives].sort((a: any, b: any) => (b.total_stock || 0) - (a.total_stock || 0)).map((alt: any) => (
                         <div 
                            key={alt.id} 
                            onClick={() => {
                              if (!isEditing) {
                                setHistory(prev => [...prev, currentId]);
                                setCurrentId(alt.id);
                              }
                            }}
                            className={cn(
                              "bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-100 dark:border-slate-700 flex justify-between items-center transition-all group relative",
                              !isEditing && "hover:border-blue-500 hover:shadow-lg cursor-pointer"
                            )}
                         >
                            <div>
                              <p className="font-black text-slate-800 dark:text-white group-hover:text-blue-600 transition-colors">{alt.trade_name}</p>
                              <p className="text-[10px] text-slate-400 font-bold">{alt.active_ingredient}</p>
                            </div>
                            <div className="text-left flex items-center gap-4">
                               <div>
                                   <p className="font-black text-blue-600 text-lg" dir="ltr">{alt.min_price} EGP</p>
                                   <p className="text-[10px] font-bold text-slate-400" dir="ltr">{(alt as any).total_stock || 0} in stock</p>
                                </div>
                               {isEditing && (
                                  <button 
                                    onClick={(e) => handleRemoveAlternative(alt.id, e)}
                                    className="bg-rose-50 dark:bg-rose-900/20 text-rose-600 p-2 rounded-xl hover:bg-rose-100 dark:hover:bg-rose-900/40 transition-colors"
                                  >
                                     <X className="w-4 h-4" />
                                  </button>
                               )}
                            </div>
                         </div>
                       )) : (
                         <div className="col-span-full">
                            <NoData icon={ArrowLeftRight} message="لا يوجد بدائل مسجلة لهذا الصنف" />
                         </div>
                       )}
                    </div>
                 </div>
               ) : (
                 <div className="space-y-4">
                    {isEditing && (
                      <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-100 dark:border-slate-700 flex flex-col md:flex-row gap-3 items-end">
                         <div className="flex-1 w-full space-y-1">
                            <label className="text-[10px] font-bold text-slate-500">المادة الفعالة الأولى</label>
                            <input 
                              type="text" 
                              value={conflictIngredientA || (drugData?.active_ingredient || '')} 
                              onChange={(e) => setConflictIngredientA(e.target.value)}
                              className="w-full bg-slate-50 dark:bg-slate-900 border-none rounded-xl p-3 text-sm font-bold"
                            />
                         </div>
                         <div className="flex-1 w-full space-y-1">
                            <label className="text-[10px] font-bold text-slate-500">المادة الفعالة المتعارضة</label>
                            <input 
                              type="text" 
                              value={conflictIngredientB} 
                              onChange={(e) => setConflictIngredientB(e.target.value)}
                              placeholder="أدخل المادة المتعارضة..."
                              className="w-full bg-slate-50 dark:bg-slate-900 border-none rounded-xl p-3 text-sm font-bold"
                            />
                         </div>
                         <div className="w-full md:w-32 space-y-1">
                            <label className="text-[10px] font-bold text-slate-500">الخطورة</label>
                            <select 
                              value={conflictSeverity}
                              onChange={(e) => setConflictSeverity(e.target.value)}
                              className="w-full bg-slate-50 dark:bg-slate-900 border-none rounded-xl p-3 text-sm font-bold"
                            >
                               <option value="minor">بسيطة</option>
                               <option value="moderate">متوسطة</option>
                               <option value="major">خطيرة</option>
                            </select>
                         </div>
                         <button 
                           onClick={handleAddConflict}
                           className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl transition-all h-[44px]"
                         >
                            إضافة
                         </button>
                      </div>
                    )}
                    {drugData?.conflicts?.length > 0 ? drugData.conflicts.map((conf: any, idx: number) => {
                      const isExpanded = expandedConflicts.includes(idx);
                      return (
                      <div key={idx} className="bg-rose-50 dark:bg-rose-900/10 p-5 rounded-2xl border border-rose-100 dark:border-rose-900/20 flex gap-4 items-start justify-between cursor-pointer transition-all hover:bg-rose-100 dark:hover:bg-rose-900/20" onClick={() => {
                        if (isExpanded) {
                          setExpandedConflicts(prev => prev.filter(i => i !== idx));
                        } else {
                          setExpandedConflicts(prev => [...prev, idx]);
                        }
                      }}>
                         <div className="flex gap-4 w-full">
                            <div className="p-3 bg-rose-100 dark:bg-rose-900/30 rounded-xl text-rose-600 shrink-0 h-fit">
                               <AlertTriangle className="w-5 h-5" />
                            </div>
                            <div className="w-full">
                               <div className="flex justify-between items-center w-full">
                                 <div>
                                   <p className="font-black text-rose-800 dark:text-rose-300 mb-1">{conf.trade_name}</p>
                                   <p className="text-xs font-bold text-rose-600/70 mb-2">تداخل بسبب: {conf.conflicting_ingredient}</p>
                                 </div>
                                 <div className="px-3 py-1 bg-white dark:bg-slate-800 rounded-lg w-fit text-[10px] font-black text-rose-500 uppercase tracking-widest border border-rose-100 dark:border-rose-900/30">
                                    درجة الخطورة: {conf.severity}
                                 </div>
                               </div>
                               {isExpanded && conf.description && (
                                 <div className="mt-3 p-3 bg-white dark:bg-slate-800/50 rounded-xl border border-rose-100 dark:border-rose-900/30 animate-in fade-in slide-in-from-top-2">
                                   <p className="text-sm font-bold text-slate-600 dark:text-slate-400 leading-relaxed">{conf.description}</p>
                                 </div>
                               )}
                            </div>
                         </div>
                         {isEditing && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleRemoveConflict(conf.interaction_id); }}
                              className="text-rose-500 hover:text-rose-700 p-2 bg-white dark:bg-slate-800 rounded-lg border border-rose-100 dark:border-rose-900/30 shrink-0"
                            >
                               <X className="w-4 h-4" />
                            </button>
                         )}
                      </div>
                    )}) : (
                      <NoData icon={AlertTriangle} message="لا يوجد تفاعلات دوائية مسجلة معروفة لهذا الصنف" />
                    )}
                 </div>
               )}
            </div>
          )}

          {activeTab === 'usage' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
               <div className="bg-blue-50 dark:bg-blue-900/10 p-6 rounded-3xl border border-blue-100 dark:border-blue-900/20">
                  <h4 className="font-black text-blue-800 dark:text-blue-300 mb-2 flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5" /> دواعي الاستعمال (Indications)
                  </h4>
                  {isEditing ? (
                    <textarea 
                      value={formData?.indications || ''} 
                      onChange={(e) => setFormData({...formData, indications: e.target.value})}
                      className="w-full bg-white dark:bg-slate-900 border border-blue-200 dark:border-blue-800 rounded-xl p-3 text-sm font-bold text-slate-700 dark:text-slate-300 min-h-[100px]"
                      placeholder="أدخل دواعي الاستعمال هنا..."
                    />
                  ) : (
                    <p className="font-bold text-slate-700 dark:text-slate-300 leading-relaxed">
                      {drugData?.indications || 'لا توجد بيانات مسجلة عن دواعي الاستعمال.'}
                    </p>
                  )}
               </div>
               <div className="bg-rose-50 dark:bg-rose-900/10 p-6 rounded-3xl border border-rose-100 dark:border-rose-900/20">
                  <h4 className="font-black text-rose-800 dark:text-rose-300 mb-2 flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5" /> التحذيرات والآثار الجانبية
                  </h4>
                  {isEditing ? (
                    <textarea 
                      value={formData?.side_effects || ''} 
                      onChange={(e) => setFormData({...formData, side_effects: e.target.value})}
                      className="w-full bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-800 rounded-xl p-3 text-sm font-bold text-slate-700 dark:text-slate-300 min-h-[100px]"
                      placeholder="أدخل التحذيرات والآثار الجانبية هنا..."
                    />
                  ) : drugData?.side_effects ? (
                    <p className="font-bold text-slate-700 dark:text-slate-300 leading-relaxed">
                      {drugData.side_effects}
                    </p>
                  ) : (
                    <p className="font-bold text-slate-500 dark:text-slate-400 text-sm">
                      لا توجد بيانات مسجلة عن التحذيرات والآثار الجانبية.
                    </p>
                  )}
               </div>
            </div>
          )}

          {activeTab === 'consumption' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
               <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-8 rounded-[2rem] text-white flex justify-between items-center shadow-xl shadow-blue-500/20">
                  <div>
                     <p className="text-blue-100 font-bold text-sm mb-1 uppercase tracking-widest">متوسط الاستهلاك الشهري</p>
                     <h3 className="text-4xl font-black">
                        {((drugData?.consumption_stats?.reduce((s:any,c:any)=>s+c.net_sales, 0) || 0) / (drugData?.consumption_stats?.length || 1)).toFixed(2)} 
                        <span className="text-xl mr-2 opacity-80">علبة / شهر</span>
                     </h3>
                  </div>
                  <TrendingUp className="w-16 h-16 opacity-20" />
               </div>

               <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 overflow-hidden shadow-sm">
                  <table className="w-full text-right" dir="rtl">
                    <thead className="bg-slate-50 dark:bg-slate-900/50">
                      <tr>
                        <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase">السنة</th>
                        <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase">الشهر</th>
                        <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase">صافي المبيعات</th>
                        <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase">عدد العمليات</th>
                        <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase text-left">الإجمالي</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 dark:divide-slate-700">
                      {drugData?.consumption_stats?.length > 0 ? drugData.consumption_stats.map((stat: any, idx: number) => (
                        <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors">
                          <td className="px-8 py-5 font-black text-slate-500">{stat.year}</td>
                          <td className="px-8 py-5 font-black text-slate-800 dark:text-white">{stat.month}</td>
                          <td className="px-8 py-5 font-black text-emerald-600">{stat.net_sales}</td>
                          <td className="px-8 py-5 font-bold text-slate-500">{stat.transactions}</td>
                          <td className="px-8 py-5 font-black text-blue-600 text-left">{(stat.net_sales * (drugData?.min_price || 0)).toLocaleString()} ج.م</td>
                        </tr>
                      )) : (
                        <tr>
                          <td colSpan={5} className="py-20 text-center text-slate-400 font-bold italic">لا يوجد سجل استهلاك لهذا الصنف بعد</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
               </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-8 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-center shrink-0">
          <button 
            onClick={onClose}
            className="px-12 py-4 bg-slate-800 text-white rounded-2xl font-black hover:bg-slate-700 transition-all shadow-xl"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value, color = "text-slate-800 dark:text-white", isEditing, onChange, type = "text" }: any) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
      {isEditing ? (
        <input 
          type={type}
          value={value || ''}
          onChange={(e) => onChange && onChange(e.target.value)}
          className="w-full bg-slate-100 dark:bg-slate-800 border-none rounded-lg p-2 text-sm font-bold text-slate-900 dark:text-white"
        />
      ) : (
        <p className={cn("font-black text-sm", color)}>{value}</p>
      )}
    </div>
  );
}

function StatusTag({ label, active, isEditing, onChange }: any) {
   return (
      <div 
         onClick={() => isEditing && onChange && onChange(!active)}
         className={cn(
            "px-4 py-2 rounded-xl text-[10px] font-black border transition-all flex items-center justify-center gap-2",
            active 
               ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 border-emerald-100 dark:border-emerald-800" 
               : "bg-slate-50 dark:bg-slate-800/50 text-slate-400 border-slate-100 dark:border-slate-800 opacity-50",
            isEditing && "cursor-pointer hover:ring-2 hover:ring-emerald-500/50"
         )}>
         {active ? <ShieldCheck className="w-3 h-3" /> : null}
         {label}
      </div>
   );
}

function UnitRow({ label, value, factor, isEditing, onChange, onChangeFactor, type = "text" }: any) {
   return (
      <div className="flex justify-between items-center text-sm">
         <span className="font-bold text-slate-500">{label}</span>
         <div className="flex items-center gap-2">
            {isEditing && onChange ? (
               <input 
                 type={type}
                 value={value || ''} 
                 onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
                 className="w-20 bg-slate-100 dark:bg-slate-800 border-none rounded p-1 text-center font-black text-slate-800 dark:text-white"
               />
            ) : (
               <span className="font-black text-slate-800 dark:text-white">{value || '---'}</span>
            )}
            
            {factor !== undefined && (
               isEditing && onChangeFactor ? (
                 <input 
                   type="number"
                   value={factor || ''} 
                   onChange={(e) => onChangeFactor(Number(e.target.value))}
                   className="w-12 text-[10px] bg-slate-100 dark:bg-slate-800 border-none rounded p-1 text-center text-slate-600 dark:text-slate-300"
                 />
               ) : (
                 <span className="text-[10px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">{factor}</span>
               )
            )}
         </div>
      </div>
   );
}

function StockCard({ label, value, color }: any) {
  return (
    <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-100 dark:border-slate-700 flex flex-col items-center text-center shadow-sm">
      <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center text-white mb-4 shadow-lg", color)}>
        <Package className="w-6 h-6" />
      </div>
      <p className="text-xs font-black text-slate-400 mb-1">{label}</p>
      <p className="text-3xl font-black text-slate-800 dark:text-white">{value}</p>
    </div>
  );
}

function UnitBalance({ label, value }: any) {
  return (
    <div className="text-center px-4">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{label}</p>
      <p className="text-xl font-black text-slate-800 dark:text-white">{Number(value).toFixed(2)}</p>
    </div>
  );
}

function NoData({ icon: Icon, message }: any) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-slate-300">
      <Icon className="w-20 h-20 opacity-20 mb-4" />
      <p className="font-bold text-lg">{message}</p>
    </div>
  );
}

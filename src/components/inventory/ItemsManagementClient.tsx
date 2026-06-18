'use client'

import nextDynamic from 'next/dynamic'
import React, { useState, useEffect } from 'react'
import {
   Search,
   Plus,
   Edit,
   Copy,
   X,
   Save,
   Info,
   Layers,
   Truck,
   AlertCircle,
   Package,
   Activity,
   ChevronDown,
   Filter,
   DollarSign,
   Barcode,
   FlaskConical,
   Factory,
   Globe,
   Settings,
   History,
   Eye,
   Trash2
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { toast, Toaster } from 'react-hot-toast'
import { useSearchParams } from 'next/navigation'
import { dbSelect, dbExecute } from '@/lib/db/tauri'
import { deleteMasterDrugAction } from '@/app/actions-client/master-drugs'
import { getClientSession } from '@/lib/auth/local'

async function searchMasterDrugsAction(optionsOrQuery: any) {
  try {
    const options = typeof optionsOrQuery === 'string' ? { query: optionsOrQuery } : optionsOrQuery;
    const { query, type = 'all', status = 'all', minPrice, maxPrice } = options;
    
    if (!query && type === 'all' && status === 'all' && minPrice === undefined && maxPrice === undefined) {
      const data = await dbSelect('SELECT * FROM master_drugs ORDER BY trade_name ASC LIMIT 100');
      return { success: true, data };
    }

    let sql = 'SELECT * FROM master_drugs WHERE 1=1';
    const params: any[] = [];

    if (query) {
      const likeQuery = `%${query}%`;
      sql += ' AND (trade_name LIKE ? OR trade_name_en LIKE ? OR active_ingredient LIKE ? OR barcode LIKE ?)';
      params.push(likeQuery, likeQuery, likeQuery, likeQuery);
    }

    if (type === 'medicine') {
      sql += ' AND is_medicine = 1 AND is_service = 0';
    } else if (type === 'non-medicine') {
      sql += ' AND is_medicine = 0 AND is_service = 0';
    } else if (type === 'service') {
      sql += ' AND is_service = 1';
    }

    if (status === 'stopped') {
      sql += ' AND stop_dealing = 1';
    } else if (status === 'active') {
      sql += ' AND (stop_dealing = 0 OR stop_dealing IS NULL)';
    }

    if (minPrice !== undefined && !isNaN(minPrice)) {
      sql += ' AND official_price >= ?';
      params.push(minPrice);
    }
    if (maxPrice !== undefined && !isNaN(maxPrice)) {
      sql += ' AND official_price <= ?';
      params.push(maxPrice);
    }

    sql += ' ORDER BY trade_name ASC LIMIT 100';
    const data = await dbSelect(sql, params);
    return { success: true, data };
  } catch (err: any) {
    console.error(err);
    return { success: false, error: err.message };
  }
}

async function addMasterDrugAction(data: any) {
  try {
    const localUser = await getClientSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const result = await dbExecute(`
      INSERT INTO master_drugs (
        trade_name, trade_name_en, generic_name, active_ingredient, barcode, 
        official_price, category, manufacturer, is_medicine, is_service, 
        is_refrigerated, is_chronic, has_expiry, no_return, origin, notes,
        large_unit, small_unit, medium_unit, large_to_medium, medium_to_small,
        min_limit, max_limit, reorder_point, default_purchase_qty, prevent_fractions,
        tax_percent, discount_percent, stop_dealing, code_2, item_nature,
        scientific_group, usage_method, active_ingredient_ratio, is_table
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.trade_name,
      data.trade_name_en || null,
      data.generic_name || null,
      data.active_ingredient || null,
      data.barcode || null,
      data.official_price || 0,
      data.category || null,
      data.manufacturer || null,
      data.is_medicine ?? 1,
      data.is_service ?? 0,
      data.is_refrigerated ?? 0,
      data.is_chronic ?? 0,
      data.has_expiry ?? 1,
      data.no_return ?? 0,
      data.origin || null,
      data.notes || null,
      data.large_unit || null,
      data.small_unit || null,
      data.medium_unit || null,
      data.large_to_medium || null,
      data.medium_to_small || null,
      data.min_limit || null,
      data.max_limit || null,
      data.reorder_point || null,
      data.default_purchase_qty || null,
      data.prevent_fractions ?? 0,
      data.tax_percent ?? 0,
      data.discount_percent ?? 0,
      data.stop_dealing ?? 0,
      data.code_2 || null,
      data.item_nature || null,
      data.scientific_group || null,
      data.usage_method || null,
      data.active_ingredient_ratio || null,
      data.is_table ?? 0
    ]);

    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [
      localUser.id,
      'ADD_MASTER_DRUG',
      `أضاف الصنف: ${data.trade_name}`
    ]);

    return { success: true, id: result.lastInsertId };
  } catch (error: any) {
    console.error('Add master drug error:', error);
    return { success: false, error: error.message };
  }
}

async function updateMasterDrugAction(id: number, data: any) {
  try {
    const localUser = await getClientSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    await dbExecute(`
      UPDATE master_drugs SET
        trade_name = ?, trade_name_en = ?, generic_name = ?, active_ingredient = ?, barcode = ?, 
        official_price = ?, category = ?, manufacturer = ?, is_medicine = ?, is_service = ?, 
        is_refrigerated = ?, is_chronic = ?, has_expiry = ?, no_return = ?, origin = ?, notes = ?,
        large_unit = ?, small_unit = ?, medium_unit = ?, large_to_medium = ?, medium_to_small = ?,
        min_limit = ?, max_limit = ?, reorder_point = ?, default_purchase_qty = ?, prevent_fractions = ?,
        tax_percent = ?, discount_percent = ?, stop_dealing = ?,
        code_2 = ?, item_nature = ?, scientific_group = ?, usage_method = ?,
        active_ingredient_ratio = ?, is_table = ?
      WHERE id = ?
    `, [
      data.trade_name,
      data.trade_name_en || null,
      data.generic_name || null,
      data.active_ingredient || null,
      data.barcode || null,
      data.official_price || 0,
      data.category || null,
      data.manufacturer || null,
      data.is_medicine ?? 1,
      data.is_service ?? 0,
      data.is_refrigerated ?? 0,
      data.is_chronic ?? 0,
      data.has_expiry ?? 1,
      data.no_return ?? 0,
      data.origin || null,
      data.notes || null,
      data.large_unit || null,
      data.small_unit || null,
      data.medium_unit || null,
      data.large_to_medium || null,
      data.medium_to_small || null,
      data.min_limit || null,
      data.max_limit || null,
      data.reorder_point || null,
      data.default_purchase_qty || null,
      data.prevent_fractions ?? 0,
      data.tax_percent ?? 0,
      data.discount_percent ?? 0,
      data.stop_dealing ?? 0,
      data.code_2 || null,
      data.item_nature || null,
      data.scientific_group || null,
      data.usage_method || null,
      data.active_ingredient_ratio || null,
      data.is_table ?? 0,
      id
    ]);

    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [
      localUser.id,
      'UPDATE_MASTER_DRUG',
      `عدل الصنف: ${data.trade_name}`
    ]);

    return { success: true };
  } catch (error: any) {
    console.error('Update master drug error:', error);
    return { success: false, error: error.message };
  }
}

interface MasterDrug {
   id: number;
   trade_name: string;
   trade_name_en?: string;
   generic_name?: string;
   active_ingredient?: string;
   barcode?: string;
   official_price: number;
   category?: string;
   manufacturer?: string;
   is_medicine: number;
   is_service: number;
   is_refrigerated: number;
   is_chronic: number;
   has_expiry: number;
   no_return: number;
   origin?: string;
   notes?: string;
   stop_dealing?: number;
   large_unit?: string;
   small_unit?: string;
   medium_unit?: string;
   large_to_medium?: number;
   medium_to_small?: number;
   min_limit?: number;
   max_limit?: number;
   reorder_point?: number;
   default_purchase_qty?: number;
   tax_percent?: number;
   discount_percent?: number;
   code_2?: string;
   item_nature?: string;
   scientific_group?: string;
   usage_method?: string;
   active_ingredient_ratio?: string;
   is_table?: number;
}

interface Props {
   initialItems: MasterDrug[];
}

type FilterType = 'medicine' | 'non-medicine' | 'service' | 'all';
type FilterStatus = 'stopped' | 'active' | 'all';

const DrugDetailsModal = nextDynamic(() => import('@/components/pos/DrugDetailsModal'), { ssr: false });

function ContextMenuItem({ icon: Icon, label, onClick, color = "text-slate-700 dark:text-slate-300" }: any) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-all text-right font-bold text-xs ${color}`}
    >
      <Icon className="w-4 h-4 opacity-50" />
      <span>{label}</span>
    </button>
  );
}

export default function ItemsManagementClient({ initialItems }: Props) {
   const searchParams = useSearchParams();
   const [items, setItems] = useState<MasterDrug[]>(initialItems);
   const [searchTerm, setSearchTerm] = useState('');
   const [filterType, setFilterType] = useState<FilterType>('all');
   const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
   const [minPrice, setMinPrice] = useState<string>('');
   const [maxPrice, setMaxPrice] = useState<string>('');

   const [contextMenu, setContextMenu] = useState<{ x: number, y: number, drugId: number | string } | null>(null);

   const [isModalOpen, setIsModalOpen] = useState(false);
   const [detailsDrugId, setDetailsDrugId] = useState<number | null>(null);
   const [editingItem, setEditingItem] = useState<Partial<MasterDrug>>({});
   const [activeTab, setActiveTab] = useState<'basic' | 'units' | 'financial' | 'advanced'>('basic');
   const [isSaving, setIsSaving] = useState(false);
   const [purchaseHistory, setPurchaseHistory] = useState<any[]>([]);

   useEffect(() => {
      const editId = searchParams?.get('edit');
      if (editId) {
         const id = parseInt(editId);
         dbSelect('SELECT * FROM master_drugs WHERE id = ?', [id]).then((res: any) => {
            if (res && res[0]) {
               setEditingItem(res[0]);
               setIsModalOpen(true);
            }
         });
      }
   }, [searchParams]);

   useEffect(() => {
     const handleClickOutside = () => setContextMenu(null);
     document.addEventListener('click', handleClickOutside);
     return () => document.removeEventListener('click', handleClickOutside);
   }, []);

   
   const handleDelete = async (id: number) => {
      try {
         const res = await deleteMasterDrugAction(id);
         if (res.success) {
            setItems(items.filter(i => i.id !== id));
            toast.success('تم حذف الصنف بنجاح');
         } else {
            toast.error(res.error || 'فشل الحذف');
         }
      } catch (err: any) {
         toast.error(err.message || 'فشل الحذف');
      }
   };

   const handleContextMenu = (e: React.MouseEvent, drugId: number | string) => {
     e.preventDefault();
     setContextMenu({ x: e.clientX, y: e.clientY, drugId });
   };

   const loadPurchaseHistory = async (drugId: number) => {
      try {
         const data = await dbSelect(`
           SELECT pi.invoice_date, pi.invoice_number, pii.quantity, pii.cost_price, s.name_ar as supplier_name
           FROM purchase_invoice_items pii
           JOIN purchase_invoices pi ON pii.invoice_id = pi.id
           JOIN suppliers s ON pi.supplier_id = s.id
           WHERE pii.drug_id = ? AND pi.status = 'completed'
           ORDER BY pi.invoice_date DESC
           LIMIT 5
         `, [drugId]);
         setPurchaseHistory(data);
      } catch (err) {
         console.error('Failed to load purchase history:', err);
      }
   };

   // Advanced search effect
   useEffect(() => {
      const delayDebounceFn = setTimeout(async () => {
         const options = {
            query: searchTerm,
            type: filterType,
            status: filterStatus,
            minPrice: minPrice ? parseFloat(minPrice) : undefined,
            maxPrice: maxPrice ? parseFloat(maxPrice) : undefined
         };

         const res = await searchMasterDrugsAction(options);
         if (res.success && res.data) {
            setItems(res.data);
         }
      }, 400);

      return () => clearTimeout(delayDebounceFn);
   }, [searchTerm, filterType, filterStatus, minPrice, maxPrice]);

   const openAddModal = () => {
      setEditingItem({
         trade_name: '',
         trade_name_en: '',
         active_ingredient: '',
         barcode: '',
         official_price: 0,
         is_medicine: 1,
         is_service: 0,
         has_expiry: 1,
         is_refrigerated: 0,
         is_chronic: 0,
         no_return: 0,
         stop_dealing: 0
      });
      setActiveTab('basic');
      setIsModalOpen(true);
   };

    const openEditModal = (item: MasterDrug) => {
       setEditingItem(item);
       setPurchaseHistory([]); // Reset previous
       if (item.id) loadPurchaseHistory(item.id);
       setActiveTab('basic');
       setIsModalOpen(true);
    };

   const handleCopy = (item: MasterDrug) => {
      const { id, ...rest } = item;
      setEditingItem({ ...rest, trade_name: `${rest.trade_name} (نسخة)` });
      setActiveTab('basic');
      setIsModalOpen(true);
   };

   const handleSave = async () => {
      if (!editingItem.trade_name_en) {
         toast.error('Please enter the English trade name');
         return;
      }
      setIsSaving(true);

      let res;
      if (editingItem.id) {
         res = await updateMasterDrugAction(editingItem.id, editingItem);
      } else {
         res = await addMasterDrugAction(editingItem);
      }

      setIsSaving(false);
      if (res.success) {
         toast.success(editingItem.id ? 'تم تحديث الصنف بنجاح' : 'تم إضافة الصنف بنجاح');
         setIsModalOpen(false);

         // Refresh list
         const searchOptions = {
            query: searchTerm,
            type: filterType,
            status: filterStatus,
            minPrice: minPrice ? parseFloat(minPrice) : undefined,
            maxPrice: maxPrice ? parseFloat(maxPrice) : undefined
         };
         const refreshRes = await searchMasterDrugsAction(searchOptions);
         if (refreshRes.success && refreshRes.data) {
            setItems(refreshRes.data);
         }
      } else {
         toast.error(res.error || 'فشل الحفظ');
      }
   };

   const updateField = (field: keyof MasterDrug, value: any) => {
      setEditingItem(prev => ({ ...prev, [field]: value }));
   };

   return (
      <div className="space-y-8 animate-in fade-in duration-700" dir="rtl">
         <Toaster position="top-center" />

         {/* PREMIUM FILTER HEADER */}
         <div className="bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-950 p-10 rounded-[48px] shadow-soft border border-slate-100 dark:border-slate-800 space-y-8 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-96 h-96 bg-primary-500/5 rounded-full -ml-48 -mt-48 blur-3xl" />

            <div className="flex flex-wrap items-center justify-between gap-8 relative z-10">
               <div className="flex items-center gap-5">
                  <div className="w-16 h-16 bg-gradient-to-br from-primary-500 to-primary-700 rounded-3xl flex items-center justify-center text-white shadow-xl shadow-primary-500/30">
                     <Package className="w-8 h-8" />
                  </div>
                  <div>
                     <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Inventory Management</h1>
                     <p className="text-slate-500 font-bold flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-primary-500 animate-pulse" />
                        Master Inventory Management
                     </p>
                  </div>
               </div>

               <button
                  onClick={openAddModal}
                  className="px-12 py-5 bg-primary-600 text-white rounded-[24px] font-black shadow-2xl shadow-primary-500/30 hover:bg-primary-700 hover:-translate-y-1 active:scale-95 transition-all flex items-center gap-3 group"
               >
                  <Plus className="w-6 h-6 group-hover:rotate-90 transition-transform" />
                  إضافة صنف جديد
               </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-10 border-t border-slate-200/60 dark:border-slate-800/60 relative z-10">
               {/* Search Box */}
               <div className="lg:col-span-5 relative group">
                  <div className="absolute inset-y-0 right-0 pr-5 flex items-center pointer-events-none">
                     <Search className="w-5 h-5 text-slate-400 group-focus-within:text-primary-500 transition-colors" />
                  </div>
                  <input
                     type="text"
                     placeholder="Search by English Trade Name, Active Ingredient, or Barcode..."
                     className="w-full pr-14 pl-6 py-5 bg-white dark:bg-slate-800/50 rounded-3xl outline-none border-2 border-transparent focus:border-primary-500/20 shadow-inner-lg font-bold dark:text-white transition-all text-lg"
                     value={searchTerm}
                     onChange={(e) => setSearchTerm(e.target.value)}
                  />
               </div>

               {/* Type Select */}
               <div className="lg:col-span-4 flex bg-white dark:bg-slate-800/50 p-2 rounded-3xl border-2 border-transparent shadow-inner-lg">
                  {(['all', 'medicine', 'non-medicine', 'service'] as const).map((t) => (
                     <button
                        key={t}
                        onClick={() => setFilterType(t)}
                        className={cn(
                           "flex-1 py-4 text-sm font-black rounded-2xl transition-all",
                           filterType === t
                              ? "bg-primary-600 text-white shadow-xl shadow-primary-500/20 scale-105"
                              : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                        )}
                     >
                        {t === 'all' && 'الكل'}
                        {t === 'medicine' && 'أدوية'}
                        {t === 'non-medicine' && 'غير أدوية'}
                        {t === 'service' && 'خدمة'}
                     </button>
                  ))}
               </div>

               {/* Price & Status Actions */}
               <div className="lg:col-span-3 flex gap-4">
                  <div className="flex-1 flex items-center gap-3 bg-white dark:bg-slate-800/50 px-6 py-2 rounded-3xl shadow-inner-lg">
                     <DollarSign className="w-4 h-4 text-emerald-500" />
                     <input
                        type="number"
                        placeholder="من"
                        className="w-full bg-transparent border-none outline-none text-center font-black dark:text-white text-base"
                        value={minPrice}
                        onChange={(e) => setMinPrice(e.target.value)}
                     />
                     <span className="text-slate-300">|</span>
                     <input
                        type="number"
                        placeholder="إلى"
                        className="w-full bg-transparent border-none outline-none text-center font-black dark:text-white text-base"
                        value={maxPrice}
                        onChange={(e) => setMaxPrice(e.target.value)}
                     />
                  </div>
               </div>
            </div>
         </div>

         {/* ITEMS DISPLAY */}
         <div className="bg-white dark:bg-slate-900/60 backdrop-blur-xl rounded-[48px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden relative">
            <div className="overflow-x-auto custom-scrollbar">
               <table className="w-full text-right border-collapse">
                  <thead>
                     <tr className="bg-slate-50/50 dark:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800">
                        <th className="px-10 py-7 font-black text-slate-400 text-xs uppercase tracking-widest">ID</th>
                        <th className="px-10 py-7 font-black text-slate-400 text-xs uppercase tracking-widest">Trade Name (English)</th>
                        <th className="px-10 py-7 font-black text-slate-400 text-xs uppercase tracking-widest">Scientific Info</th>
                        <th className="px-10 py-7 font-black text-slate-400 text-xs uppercase tracking-widest text-center">Official Price</th>
                        <th className="px-10 py-7 font-black text-slate-400 text-xs uppercase tracking-widest">Manufacturer</th>
                        <th className="px-10 py-7 font-black text-slate-400 text-xs uppercase tracking-widest text-center">الإجراءات</th>
                     </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                     {items.map((item) => (
                        <tr key={item.id} onContextMenu={(e) => handleContextMenu(e, item.id)} className={cn(
                           "group hover:bg-primary-500/5 dark:hover:bg-primary-500/5 transition-all duration-300",
                           item.stop_dealing === 1 && "bg-rose-50/30 dark:bg-rose-900/10 opacity-75"
                        )}>
                           <td className="px-10 py-6">
                              <span className="font-black text-slate-400 group-hover:text-primary-600 transition-colors">#{item.id}</span>
                           </td>
                           <td className="px-10 py-6">
                              <div>
                                 <div className="font-black text-lg text-slate-900 dark:text-white group-hover:translate-x-1 transition-transform inline-block">
                                    {item.trade_name_en || item.trade_name || item.active_ingredient || '---'}
                                 </div>
                                 {item.trade_name && (
                                    <div className="font-bold text-slate-400 uppercase text-[10px] tracking-widest mt-1">
                                       {item.trade_name}
                                    </div>
                                  )}
                              </div>
                           </td>
                           <td className="px-10 py-6">
                              <div className="flex flex-col gap-1">
                                 <div className="flex items-center gap-2">
                                    <FlaskConical className="w-3.5 h-3.5 text-primary-500" />
                                    <span className="text-xs font-black text-slate-600 dark:text-slate-300 truncate max-w-[200px]">
                                       {item.active_ingredient || '---'}
                                    </span>
                                 </div>
                                 <div className="flex items-center gap-2">
                                    <Barcode className="w-3.5 h-3.5 text-slate-400" />
                                    <span className="text-[10px] font-bold text-slate-400 tracking-wider">
                                       {item.barcode || '---'}
                                    </span>
                                 </div>
                              </div>
                           </td>
                           <td className="px-10 py-6 text-center">
                              <div className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 rounded-2xl font-black border border-emerald-100 dark:border-emerald-800/30">
                                 <span className="text-lg">{item.official_price}</span>
                                 <span className="text-[10px] opacity-70">ج.م</span>
                              </div>
                           </td>
                           <td className="px-10 py-6">
                              <div className="flex items-center gap-3">
                                 <div className="w-8 h-8 bg-slate-100 dark:bg-slate-800 rounded-lg flex items-center justify-center">
                                    <Factory className="w-4 h-4 text-slate-400" />
                                 </div>
                                 <span className="text-xs font-black text-slate-500 uppercase tracking-tight">{item.manufacturer || '---'}</span>
                              </div>
                           </td>
                           <td className="px-10 py-6">
                              <div className="flex justify-center gap-3 opacity-0 group-hover:opacity-100 transition-all scale-95 group-hover:scale-100">
                                 <button
                                    onClick={() => setDetailsDrugId(item.id)}
                                    className="p-3 bg-white dark:bg-slate-800 text-slate-500 rounded-2xl shadow-soft hover:bg-slate-100 dark:hover:bg-slate-700 transition-all active:scale-90"
                                    title="عرض التفاصيل الكاملة"
                                 >
                                    <Eye className="w-5 h-5" />
                                 </button>
                                 <button
                                    onClick={() => openEditModal(item)}
                                    className="p-3 bg-white dark:bg-slate-800 text-primary-600 rounded-2xl shadow-soft hover:bg-primary-600 hover:text-white transition-all active:scale-90"
                                 >
                                    <Edit className="w-5 h-5" />
                                 </button>
                                 <button
                                    onClick={() => handleCopy(item)}
                                    className="p-3 bg-white dark:bg-slate-800 text-slate-400 rounded-2xl shadow-soft hover:bg-slate-900 dark:hover:bg-slate-700 hover:text-white transition-all active:scale-90"
                                    title="نسخ بيانات الصنف"
                                 >
                                    <Copy className="w-5 h-5" />
                                 </button>
                              </div>
                           </td>
                        </tr>
                     ))}
                  </tbody>
               </table>
            </div>

            <div className="p-10 bg-slate-50/50 dark:bg-slate-800/40 flex justify-between items-center border-t border-slate-100 dark:border-slate-800">
               <div className="flex items-center gap-4">
                  <div className="w-3 h-3 rounded-full bg-primary-500" />
                  <p className="text-sm font-black text-slate-500">إجمالي الأصناف: <span className="text-slate-900 dark:text-white ml-1">{items.length}</span></p>
               </div>
               <div className="flex gap-2">
                  <button className="px-6 py-3 bg-white dark:bg-slate-800 rounded-2xl text-xs font-black text-slate-400 disabled:opacity-50 border border-slate-100 dark:border-slate-700">السابق</button>
                  <button className="px-6 py-3 bg-white dark:bg-slate-800 rounded-2xl text-xs font-black text-slate-400 disabled:opacity-50 border border-slate-100 dark:border-slate-700">التالي</button>
               </div>
            </div>
         </div>

         {/* PREMIUM MODAL */}
         {isModalOpen && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/70 backdrop-blur-md animate-in fade-in duration-300 overflow-y-auto">
               <div className="bg-white dark:bg-slate-900 w-full max-w-6xl rounded-[56px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden my-auto animate-in zoom-in slide-in-from-bottom-10 duration-500">
                  {/* Modal Header */}
                  <div className="p-10 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/30 dark:bg-slate-800/20">
                     <div className="flex items-center gap-6">
                        <div className="w-20 h-20 bg-gradient-to-br from-primary-600 to-primary-800 rounded-[32px] flex items-center justify-center text-white shadow-2xl shadow-primary-500/20">
                           {editingItem.id ? <Edit className="w-10 h-10" /> : <Plus className="w-10 h-10" />}
                        </div>
                        <div>
                           <h2 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                              {editingItem.id ? 'تعديل بيانات الصنف' : 'إضافة صنف جديد لقاعدة البيانات'}
                           </h2>
                           <p className="text-slate-500 font-bold mt-1">
                              {editingItem.id ? `تحرير: ${editingItem.trade_name_en || editingItem.trade_name}` : 'Product Information & Configuration'}
                           </p>
                        </div>
                     </div>
                     <button
                        onClick={() => setIsModalOpen(false)}
                        className="p-5 bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 hover:bg-rose-50 dark:hover:bg-rose-900/20 text-slate-400 hover:text-rose-500 transition-all shadow-sm active:scale-90"
                     >
                        <X className="w-8 h-8" />
                     </button>
                  </div>

                  {/* Modal Tabs */}
                  <div className="flex bg-slate-50 dark:bg-slate-900 p-2 gap-3 mx-10 mt-10 rounded-[32px] border border-slate-100 dark:border-slate-800/60 overflow-x-auto no-scrollbar">
                     <button onClick={() => setActiveTab('basic')} className={cn(
                        "flex-1 min-w-[150px] py-5 px-8 rounded-2xl font-black transition-all flex items-center justify-center gap-3 relative overflow-hidden",
                        activeTab === 'basic' ? "bg-white dark:bg-slate-700 text-primary-600 shadow-xl" : "text-slate-400 hover:text-slate-600 dark:text-slate-500"
                     )}>
                        <Info className="w-6 h-6" /> البيانات الأساسية
                        {activeTab === 'basic' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary-600" />}
                     </button>
                     <button onClick={() => setActiveTab('units')} className={cn(
                        "flex-1 min-w-[150px] py-5 px-8 rounded-2xl font-black transition-all flex items-center justify-center gap-3 relative overflow-hidden",
                        activeTab === 'units' ? "bg-white dark:bg-slate-700 text-primary-600 shadow-xl" : "text-slate-400 hover:text-slate-600 dark:text-slate-500"
                     )}>
                        <Layers className="w-6 h-6" /> الوحدات والأسعار
                        {activeTab === 'units' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary-600" />}
                     </button>
                     <button onClick={() => setActiveTab('financial')} className={cn(
                        "flex-1 min-w-[150px] py-5 px-8 rounded-2xl font-black transition-all flex items-center justify-center gap-3 relative overflow-hidden",
                        activeTab === 'financial' ? "bg-white dark:bg-slate-700 text-primary-600 shadow-xl" : "text-slate-400 hover:text-slate-600 dark:text-slate-500"
                     )}>
                        <DollarSign className="w-6 h-6" /> البيانات المالية
                        {activeTab === 'financial' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary-600" />}
                     </button>
                     <button onClick={() => setActiveTab('advanced')} className={cn(
                        "flex-1 min-w-[150px] py-5 px-8 rounded-2xl font-black transition-all flex items-center justify-center gap-3 relative overflow-hidden",
                        activeTab === 'advanced' ? "bg-white dark:bg-slate-700 text-primary-600 shadow-xl" : "text-slate-400 hover:text-slate-600 dark:text-slate-500"
                     )}>
                        <Settings className="w-6 h-6" /> خيارات متقدمة
                        {activeTab === 'advanced' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary-600" />}
                     </button>
                  </div>

                  <div className="p-12 max-h-[55vh] overflow-y-auto custom-scrollbar">
                     {activeTab === 'basic' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10 animate-in slide-in-from-left-4 duration-500">
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">Trade Name (English) *</label>
                              <input type="text" dir="ltr" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.trade_name_en || ''} onChange={(e) => updateField('trade_name_en', e.target.value)} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">Arabic Name (Optional)</label>
                              <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.trade_name || ''} onChange={(e) => updateField('trade_name', e.target.value)} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">المادة الفعالة</label>
                              <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.active_ingredient || ''} onChange={(e) => updateField('active_ingredient', e.target.value)} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">الباركود</label>
                              <div className="relative">
                                 <Barcode className="absolute right-5 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-300" />
                                 <input type="text" className="w-full pr-14 pl-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.barcode || ''} onChange={(e) => updateField('barcode', e.target.value)} />
                              </div>
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">السعر الرسمي</label>
                              <div className="relative">
                                 <DollarSign className="absolute right-5 top-1/2 -translate-y-1/2 w-6 h-6 text-emerald-500/50" />
                                 <input type="number" className="w-full pr-14 pl-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-black text-emerald-600 dark:text-emerald-400 transition-all text-lg shadow-inner-lg" value={editingItem.official_price || 0} onChange={(e) => updateField('official_price', parseFloat(e.target.value))} />
                              </div>
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">الشركة المصنعة</label>
                              <div className="relative">
                                 <Factory className="absolute right-5 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-300" />
                                 <input type="text" className="w-full pr-14 pl-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.manufacturer || ''} onChange={(e) => updateField('manufacturer', e.target.value)} />
                              </div>
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">كود 2</label>
                              <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.code_2 || ''} onChange={(e) => updateField('code_2', e.target.value)} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">نسبة المادة الفعالة</label>
                              <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.active_ingredient_ratio || ''} onChange={(e) => updateField('active_ingredient_ratio', e.target.value)} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">المجموعة العلمية</label>
                              <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.scientific_group || ''} onChange={(e) => updateField('scientific_group', e.target.value)} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">طبيعة الصنف</label>
                              <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.item_nature || ''} onChange={(e) => updateField('item_nature', e.target.value)} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">طريقة الاستخدام</label>
                              <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.usage_method || ''} onChange={(e) => updateField('usage_method', e.target.value)} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">المنشأ</label>
                              <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white transition-all text-lg shadow-inner-lg" value={editingItem.origin || ''} onChange={(e) => updateField('origin', e.target.value)} />
                           </div>
                        </div>
                     )}

                     {activeTab === 'units' && (
                        <div className="space-y-10 animate-in slide-in-from-right-4 duration-500">
                           <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                              <div className="space-y-3">
                                 <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">الوحدة الكبرى (Box)</label>
                                 <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white shadow-inner-lg" value={editingItem.large_unit || ''} onChange={(e) => updateField('large_unit', e.target.value)} />
                              </div>
                              <div className="space-y-3">
                                 <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">الوحدة المتوسطة (Strip)</label>
                                 <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white shadow-inner-lg" value={editingItem.medium_unit || ''} onChange={(e) => updateField('medium_unit', e.target.value)} />
                              </div>
                              <div className="space-y-3">
                                 <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">الوحدة الصغرى (Tab)</label>
                                 <input type="text" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white shadow-inner-lg" value={editingItem.small_unit || ''} onChange={(e) => updateField('small_unit', e.target.value)} />
                              </div>
                           </div>

                           <div className="grid grid-cols-1 md:grid-cols-2 gap-10 p-10 bg-primary-500/5 rounded-[40px] border border-primary-500/10">
                              <div className="space-y-3">
                                 <label className="text-sm font-black text-primary-700 dark:text-primary-300">معامل التحويل (كبرى {'<-'} متوسطة)</label>
                                 <input type="number" className="w-full px-8 py-5 bg-white dark:bg-slate-800 border-2 border-transparent focus:border-primary-500 rounded-3xl outline-none font-black text-primary-600 text-xl shadow-sm" value={editingItem.large_to_medium || ''} onChange={(e) => updateField('large_to_medium', parseInt(e.target.value))} />
                              </div>
                              <div className="space-y-3">
                                 <label className="text-sm font-black text-primary-700 dark:text-primary-300">معامل التحويل (متوسطة {'<-'} صغرى)</label>
                                 <input type="number" className="w-full px-8 py-5 bg-white dark:bg-slate-800 border-2 border-transparent focus:border-primary-500 rounded-3xl outline-none font-black text-primary-600 text-xl shadow-sm" value={editingItem.medium_to_small || ''} onChange={(e) => updateField('medium_to_small', parseInt(e.target.value))} />
                              </div>
                           </div>

                           <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                              <div className="space-y-3">
                                 <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">كمية الطلب الافتراضية</label>
                                 <input type="number" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white shadow-inner-lg" value={editingItem.default_purchase_qty || ''} onChange={(e) => updateField('default_purchase_qty', parseInt(e.target.value))} />
                              </div>
                              <div className="space-y-3">
                                 <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">نسبة الضريبة (%)</label>
                                 <input type="number" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white shadow-inner-lg" value={editingItem.tax_percent || 0} onChange={(e) => updateField('tax_percent', parseFloat(e.target.value))} />
                              </div>
                              <div className="space-y-3">
                                 <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">نسبة الخصم (%)</label>
                                 <input type="number" className="w-full px-7 py-5 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-bold dark:text-white shadow-inner-lg" value={editingItem.discount_percent || 0} onChange={(e) => updateField('discount_percent', parseFloat(e.target.value))} />
                              </div>
                           </div>
                        </div>
                     )}

                     {activeTab === 'financial' && (
                        <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
                           <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                              <div className="bg-emerald-50 dark:bg-emerald-900/10 p-8 rounded-[40px] border border-emerald-100 dark:border-emerald-900/20">
                                 <div className="flex items-center gap-4 mb-4">
                                    <DollarSign className="w-8 h-8 text-emerald-600" />
                                    <h4 className="font-black text-emerald-900 dark:text-emerald-400">تحليل الربحية والأسعار</h4>
                                 </div>
                                 <div className="grid grid-cols-2 gap-6">
                                    <div className="space-y-1">
                                       <p className="text-[10px] font-black text-emerald-600/60 uppercase">سعر البيع الحالي</p>
                                       <p className="text-2xl font-black">{editingItem.official_price} ج.م</p>
                                    </div>
                                    <div className="space-y-1">
                                       <p className="text-[10px] font-black text-emerald-600/60 uppercase">متوسط التكلفة</p>
                                       <p className="text-2xl font-black text-slate-500">---</p>
                                    </div>
                                 </div>
                              </div>
                              <div className="bg-blue-50 dark:bg-blue-900/10 p-8 rounded-[40px] border border-blue-100 dark:border-blue-900/20">
                                 <div className="flex items-center gap-4 mb-4">
                                    <History className="w-8 h-8 text-blue-600" />
                                    <h4 className="font-black text-blue-900 dark:text-blue-400">آخر حركات الشراء</h4>
                                 </div>
                                 <div className="space-y-4">
                                    {purchaseHistory.length > 0 ? (
                                       <div className="overflow-hidden rounded-2xl border border-blue-100 dark:border-blue-800">
                                          <table className="w-full text-right text-xs">
                                             <thead className="bg-blue-100 dark:bg-blue-800/50">
                                                <tr>
                                                   <th className="p-3 font-black">التاريخ</th>
                                                   <th className="p-3 font-black">المورد</th>
                                                   <th className="p-3 font-black text-center">الكمية</th>
                                                   <th className="p-3 font-black text-center">السعر</th>
                                                </tr>
                                             </thead>
                                             <tbody className="divide-y divide-blue-100 dark:divide-blue-800">
                                                {purchaseHistory.map((h, i) => (
                                                   <tr key={i} className="bg-white/50 dark:bg-transparent">
                                                      <td className="p-3 font-bold">{h.invoice_date}</td>
                                                      <td className="p-3 font-bold">{h.supplier_name}</td>
                                                      <td className="p-3 font-black text-center text-blue-600">{h.quantity}</td>
                                                      <td className="p-3 font-black text-center text-emerald-600">{h.cost_price.toFixed(2)}</td>
                                                   </tr>
                                                ))}
                                             </tbody>
                                          </table>
                                       </div>
                                    ) : (
                                       <p className="text-xs font-bold text-blue-400 italic">لا توجد حركات شراء مسجلة حالياً لهذا الصنف</p>
                                    )}
                                 </div>
                              </div>
                           </div>

                           <div className="bg-slate-50 dark:bg-slate-950/50 p-10 rounded-[40px] border border-slate-100 dark:border-slate-800">
                              <h4 className="text-lg font-black mb-6 flex items-center gap-3">
                                 <Activity className="w-6 h-6 text-primary-500" /> تقرير مبيعات الصنف (آخر 30 يوم)
                              </h4>
                              <div className="h-40 flex items-center justify-center border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-3xl text-slate-400 font-bold italic">
                                 إحصائيات المبيعات التفصيلية سيتم عرضها هنا
                              </div>
                           </div>
                        </div>
                     )}
                   {activeTab === 'advanced' && (
                  <div className="space-y-8 animate-in slide-in-from-top-4 duration-500">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                           {[
                              { field: 'is_medicine', label: 'صنف دوائي' },
                              { field: 'is_service', label: 'صنف خدمي' },
                              { field: 'is_refrigerated', label: 'يحتاج تبريد' },
                              { field: 'is_chronic', label: 'مرض مزمن' },
                              { field: 'has_expiry', label: 'له تاريخ صلاحية' },
                              { field: 'no_return', label: 'غير قابل للارتجاع' },
                              { field: 'stop_dealing', label: 'إيقاف التعامل' },
                              { field: 'is_table', label: 'صنف جدول' }
                           ].map((opt) => (
                              <label key={opt.field} className="flex items-center gap-4 p-6 bg-slate-50 dark:bg-slate-800/50 rounded-3xl border-2 border-transparent hover:border-primary-500/20 cursor-pointer transition-all group">
                                 <div className={cn(
                                    "w-8 h-8 rounded-xl border-2 flex items-center justify-center transition-all shadow-sm",
                                    editingItem[opt.field as keyof MasterDrug] ? "bg-primary-600 border-primary-600 text-white" : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                                 )}>
                                    {editingItem[opt.field as keyof MasterDrug] ? <X className="w-5 h-5 rotate-45" /> : null}
                                 </div>
                                 <input
                                    type="checkbox"
                                    className="hidden"
                                    checked={!!editingItem[opt.field as keyof MasterDrug]}
                                    onChange={() => updateField(opt.field as keyof MasterDrug, editingItem[opt.field as keyof MasterDrug] ? 0 : 1)}
                                 />
                                 <span className="font-black text-slate-700 dark:text-slate-300 group-hover:text-primary-600 transition-colors">{opt.label}</span>
                              </label>
                           ))}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 p-10 bg-slate-50 dark:bg-slate-900/50 rounded-[40px] border border-slate-100 dark:border-slate-800">
                           <div className="space-y-3">
                              <label className="text-xs font-black text-rose-500 uppercase tracking-widest mr-2">الحد الأدنى للنقص</label>
                              <input type="number" className="w-full px-7 py-5 bg-white dark:bg-slate-800 border-2 border-transparent focus:border-rose-500/20 rounded-3xl outline-none font-black text-rose-600 shadow-sm" value={editingItem.min_limit || ''} onChange={(e) => updateField('min_limit', parseInt(e.target.value))} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-primary-500 uppercase tracking-widest mr-2">نقطة إعادة الطلب</label>
                              <input type="number" className="w-full px-7 py-5 bg-white dark:bg-slate-800 border-2 border-transparent focus:border-primary-500/20 rounded-3xl outline-none font-black text-primary-600 shadow-sm" value={editingItem.reorder_point || ''} onChange={(e) => updateField('reorder_point', parseInt(e.target.value))} />
                           </div>
                           <div className="space-y-3">
                              <label className="text-xs font-black text-emerald-500 uppercase tracking-widest mr-2">الحد الأقصى (السقف)</label>
                              <input type="number" className="w-full px-7 py-5 bg-white dark:bg-slate-800 border-2 border-transparent focus:border-emerald-500/20 rounded-3xl outline-none font-black text-emerald-600 shadow-sm" value={editingItem.max_limit || ''} onChange={(e) => updateField('max_limit', parseInt(e.target.value))} />
                           </div>
                        </div>
                     </div>
               )}
                  </div>

                  {/* Modal Footer */}
                  <div className="p-10 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex justify-end gap-6">
                     <button
                        onClick={() => setIsModalOpen(false)}
                        className="px-12 py-5 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-[28px] font-black text-slate-700 dark:text-white hover:bg-slate-50 transition-all active:scale-95 shadow-sm"
                     >
                        إلغاء التغييرات
                     </button>
                     <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="px-16 py-5 bg-gradient-to-r from-primary-600 to-primary-700 text-white rounded-[28px] font-black shadow-2xl shadow-primary-500/40 hover:from-primary-700 hover:to-primary-800 hover:-translate-y-1 transition-all flex items-center gap-3 disabled:opacity-50 active:scale-95"
                     >
                        {isSaving ? 'جاري المعالجة...' : <><Save className="w-7 h-7" /> حفظ البيانات</>}
                     </button>
                  </div>
               </div>
            </div>
         )}

      {contextMenu && (
        <div 
          className="fixed z-[300] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden w-64 animate-in fade-in zoom-in duration-200"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className="p-2 space-y-1">
            <ContextMenuItem 
              icon={Info} 
              label="معلومات الصنف" 
              onClick={() => {
                setDetailsDrugId(contextMenu.drugId as number);
                setContextMenu(null);
              }} 
            />
            <ContextMenuItem 
              icon={Edit} 
              label="تعديل بيانات الصنف" 
              onClick={() => {
                
                const drug = items.find(i => String(i.id) === String(contextMenu.drugId)); if (drug) { setEditingItem(drug); setIsModalOpen(true); } setContextMenu(null);
              }} 
            />
            <div className="h-px bg-slate-100 dark:bg-slate-800 my-1 mx-2" />
            <ContextMenuItem 
              icon={Trash2} 
              label="حذف الصنف نهائياً" 
              color="text-red-500"
              onClick={() => {
                if(confirm('هل أنت متأكد من حذف الصنف؟')) { handleDelete(contextMenu.drugId as number); setContextMenu(null); }
              }} 
            />
          </div>
        </div>
      )}

      {detailsDrugId && (
        <DrugDetailsModal 
          drugId={detailsDrugId} 
          onClose={() => setDetailsDrugId(null)} 
        />
      )}
</div>
   )
}

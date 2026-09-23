'use client'

import React, { useState, useEffect, useRef } from 'react'
import { Search, Plus, Trash2, ChevronLeft, Stethoscope, Package, Loader2 } from 'lucide-react'
import { toast, Toaster } from 'react-hot-toast'
import { dbSelect } from '@/lib/db/tauri'
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local'
import { addDrugIndicationAction, deleteDrugIndicationAction } from '@/app/actions-client/master-drugs'

interface Indication {
  id: number;
  name_ar: string;
  name_en?: string;
}

interface Drug {
  id: number;
  trade_name: string;
  trade_name_en?: string;
  official_price: number;
  manufacturer: string;
}

interface Props {
  indications: Indication[];
}

export default function DrugIndicationsClient({ indications }: Props) {
  const [selectedIndicationId, setSelectedIndicationId] = useState<number | null>(indications[0]?.id || null);
  const [linkedDrugs, setLinkedDrugs] = useState<Drug[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Drug[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const linkedRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const mutationKeysRef = useRef<Set<string>>(new Set());
  const selectedIndicationRef = useRef<number | null>(selectedIndicationId);

  useEffect(() => {
    let active = true;
    getClientSession().then(user => {
      if (active) setCanManage(hasUserPermissionSync(user, 'can_manage_inventory'));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    selectedIndicationRef.current = selectedIndicationId;
    if (selectedIndicationId) {
      fetchLinkedDrugs(selectedIndicationId);
    }
  }, [selectedIndicationId]);

  const fetchLinkedDrugs = async (id: number) => {
    const requestId = ++linkedRequestRef.current;
    setIsLoading(true);
    try {
      const data = await dbSelect(`
        SELECT m.*, i.id as link_id FROM master_drugs m
        JOIN drug_indications i ON m.id = i.drug_id
        WHERE i.indication_id = ?
      `, [id]);
      if (requestId === linkedRequestRef.current) {
        setLinkedDrugs(data);
      }
    } catch (err) {
      if (requestId === linkedRequestRef.current) {
        console.error('Failed to fetch linked drugs:', err);
      }
    } finally {
      if (requestId === linkedRequestRef.current) {
        setIsLoading(false);
      }
    }
  };

  const handleSearch = async (query: string) => {
    const requestId = ++searchRequestRef.current;
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    try {
      const likeQuery = `%${query}%`;
      const data = await dbSelect(`
        SELECT * FROM master_drugs 
        WHERE (trade_name LIKE ? OR trade_name_en LIKE ? OR active_ingredient LIKE ? OR barcode LIKE ?) 
        LIMIT 100
      `, [likeQuery, likeQuery, likeQuery, likeQuery]);
      if (requestId === searchRequestRef.current) {
        setSearchResults(data);
      }
    } catch (err) {
      if (requestId === searchRequestRef.current) {
        console.error('Failed to search drugs:', err);
      }
    } finally {
      if (requestId === searchRequestRef.current) {
        setIsSearching(false);
      }
    }
  };

  const handleAddLink = async (drugId: number) => {
    if (!selectedIndicationId) return;
    const indicationId = selectedIndicationId;
    const mutationKey = `add:${indicationId}:${drugId}`;
    if (mutationKeysRef.current.has(mutationKey)) return;
    mutationKeysRef.current.add(mutationKey);
    try {
      const result = await addDrugIndicationAction(drugId, indicationId);
      if (!result.success) throw new Error(result.error || 'فشل الربط');
      toast.success('تم ربط الصنف بنجاح');
      if (selectedIndicationRef.current === indicationId) {
        void fetchLinkedDrugs(indicationId);
      }
      setSearchQuery('');
      setSearchResults([]);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'فشل الربط');
    } finally {
      mutationKeysRef.current.delete(mutationKey);
    }
  };

  const handleRemoveLink = async (drugId: number) => {
    if (!selectedIndicationId) return;
    const indicationId = selectedIndicationId;
    const mutationKey = `remove:${indicationId}:${drugId}`;
    if (mutationKeysRef.current.has(mutationKey)) return;
    if (!confirm('هل أنت متأكد من حذف هذا الربط؟')) return;
    mutationKeysRef.current.add(mutationKey);

    try {
      const result = await deleteDrugIndicationAction(drugId, indicationId);
      if (!result.success) throw new Error(result.error || 'فشل الحذف');
      toast.success('تم حذف الربط');
      if (selectedIndicationRef.current === indicationId) {
        void fetchLinkedDrugs(indicationId);
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'فشل الحذف');
    } finally {
      mutationKeysRef.current.delete(mutationKey);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8" dir="rtl">
      <Toaster position="top-center" />
      
      {/* Indications Sidebar */}
      <div className="lg:col-span-4 space-y-6">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-soft border border-slate-100 dark:border-slate-800 h-[600px] flex flex-col">
          <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2 mb-6">
            <Stethoscope className="w-6 h-6 text-primary-500" />
            دواعي الاستعمال
          </h3>
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
            {indications.map(ind => (
              <button
                key={ind.id}
                onClick={() => setSelectedIndicationId(ind.id)}
                className={`w-full text-right p-4 rounded-2xl font-bold transition-all flex items-center justify-between group ${
                  selectedIndicationId === ind.id 
                  ? 'bg-primary-600 text-white shadow-lg shadow-primary-500/20' 
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400'
                }`}
              >
                   <div className="flex flex-col">
                      <span>{ind.name_ar}</span>
                      {ind.name_en && (
                        <span className={`text-[10px] uppercase opacity-60 ${selectedIndicationId === ind.id ? 'text-white' : ''}`}>{ind.name_en}</span>
                      )}
                   </div>
                <ChevronLeft className={`w-4 h-4 transition-transform ${selectedIndicationId === ind.id ? '-translate-x-1' : 'opacity-0 group-hover:opacity-100'}`} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Linked Drugs Main */}
      <div className="lg:col-span-8 flex flex-col gap-8">
        {/* Search/Add Box */}
        {canManage && <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-soft border border-slate-100 dark:border-slate-800 relative">
          <h3 className="text-lg font-black text-slate-900 dark:text-white mb-4">إضافة صنف لهذا الداعي</h3>
          <div className="relative">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input 
              type="text"
              placeholder="ابحث عن دواء لربطه..."
              className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none outline-none focus:ring-4 focus:ring-primary-500/10 font-bold dark:text-white"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
            />
            {isSearching && <Loader2 className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 animate-spin text-primary-500" />}
          </div>

          {searchResults.length > 0 && (
            <div className="absolute left-8 right-8 top-full mt-2 bg-white dark:bg-slate-900 rounded-3xl shadow-hard border border-slate-100 dark:border-slate-800 z-50 max-h-[300px] overflow-y-auto">
               {searchResults.map(drug => (
                 <div key={drug.id} className="p-4 hover:bg-slate-50 dark:hover:bg-slate-800 flex justify-between items-center border-b border-slate-50 dark:border-slate-800 last:border-0">
                    <div className="flex flex-col">
                       <span className="font-black text-slate-900 dark:text-white">{drug.trade_name}</span>
                       <span className="text-xs text-slate-400">{drug.manufacturer}</span>
                    </div>
                    <button 
                      onClick={() => handleAddLink(drug.id)}
                      aria-label={`ربط ${drug.trade_name}`}
                      className="p-2 bg-primary-100 text-primary-600 rounded-xl hover:bg-primary-600 hover:text-white transition-all"
                    >
                       <Plus className="w-5 h-5" />
                    </button>
                 </div>
               ))}
            </div>
          )}
        </div>}

        {/* Linked Items List */}
        <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-soft border border-slate-100 dark:border-slate-800 flex-1 min-h-[400px]">
          <div className="flex justify-between items-center mb-8">
            <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-3">
              <Package className="w-6 h-6 text-primary-500" />
              الأصناف المرتبطة
              <span className="px-3 py-1 bg-primary-100 text-primary-600 rounded-xl text-sm">{linkedDrugs.length}</span>
            </h3>
          </div>

          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
               <Loader2 className="w-12 h-12 animate-spin text-primary-200" />
               <p className="font-bold text-slate-400">جاري تحميل الأصناف...</p>
            </div>
          ) : linkedDrugs.length > 0 ? (
            <div className="overflow-x-auto">
               <table className="w-full text-right">
                  <thead>
                     <tr className="border-b border-slate-100 dark:border-slate-800">
                        <th className="py-4 font-black text-slate-400 text-sm">اسم الصنف</th>
                        <th className="py-4 font-black text-slate-400 text-sm">الشركة</th>
                        <th className="py-4 font-black text-slate-400 text-sm text-center">السعر</th>
                        {canManage && <th className="py-4 font-black text-slate-400 text-sm">إجراء</th>}
                     </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                     {linkedDrugs.map(drug => (
                        <tr key={drug.id} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-all">
                           <td className="py-5">
                              <div className="flex flex-col">
                                 <span className="font-black text-slate-900 dark:text-white">{drug.trade_name}</span>
                                 <span className="text-[10px] uppercase text-slate-400">{drug.trade_name_en || '---'}</span>
                              </div>
                           </td>
                           <td className="py-5">
                              <span className="text-sm font-bold text-slate-600 dark:text-slate-400">{drug.manufacturer}</span>
                           </td>
                           <td className="py-5 text-center">
                              <span className="font-black text-primary-600">{drug.official_price} <span className="text-[10px]">ج.م</span></span>
                           </td>
                           {canManage && <td className="py-5">
                              <button 
                                onClick={() => handleRemoveLink(drug.id)}
                                aria-label={`حذف ربط ${drug.trade_name}`}
                                className="p-3 text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-2xl transition-all"
                              >
                                 <Trash2 className="w-5 h-5" />
                              </button>
                           </td>}
                        </tr>
                     ))}
                  </tbody>
               </table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-64 gap-6 text-slate-300">
               <Package className="w-16 h-16 opacity-20" />
               <p className="text-xl font-black italic">لا توجد أصناف مرتبطة بهذا الداعي حالياً</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

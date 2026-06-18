'use client'

import React, { useState, useEffect } from 'react'
import { Search, Plus, Trash2, X, Activity, FlaskConical, Save } from 'lucide-react'
import { toast, Toaster } from 'react-hot-toast'
import { dbSelect, dbExecute } from '@/lib/db/tauri'
import { cn } from '@/lib/utils'

interface MasterDrug {
  id: number;
  trade_name: string;
  trade_name_en?: string;
  active_ingredient?: string;
  medical_group?: string;
  manufacturer?: string;
}

export default function DrugAlternativesClient() {
  const [selectedDrug, setSelectedDrug] = useState<MasterDrug | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<MasterDrug[]>([]);
  const [alternatives, setAlternatives] = useState<MasterDrug[]>([]);
  const [activeTab, setActiveTab] = useState<'alternatives' | 'conflicts' | 'food'>('alternatives');
  const [isSearchingAlt, setIsSearchingAlt] = useState(false);
  const [altSearchTerm, setAltSearchTerm] = useState('');
  const [altSearchResults, setAltSearchResults] = useState<MasterDrug[]>([]);
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [foodInteractions, setFoodInteractions] = useState<any[]>([]);
  const [newFoodInteraction, setNewFoodInteraction] = useState('');

  // Helper for searching master drugs locally
  const localSearchMasterDrugs = async (query: string) => {
    try {
      const likeQuery = `%${query}%`;
      return await dbSelect(`
        SELECT * FROM master_drugs 
        WHERE (trade_name LIKE ? OR trade_name_en LIKE ? OR active_ingredient LIKE ? OR barcode LIKE ?) 
        LIMIT 100
      `, [likeQuery, likeQuery, likeQuery, likeQuery]);
    } catch (err) {
      console.error('Failed to search master drugs:', err);
      return [];
    }
  }

  // Search for main drug
  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (searchTerm.length >= 2) {
        const data = await localSearchMasterDrugs(searchTerm);
        setSearchResults(data);
      }
    }, 300);
    return () => clearTimeout(delayDebounceFn);
  }, [searchTerm]);

  // Search for alternatives
  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (altSearchTerm.length >= 2) {
        const data = await localSearchMasterDrugs(altSearchTerm);
        setAltSearchResults(data);
      }
    }, 300);
    return () => clearTimeout(delayDebounceFn);
  }, [altSearchTerm]);

  const selectDrug = async (drug: MasterDrug) => {
    setSelectedDrug(drug);
    setSearchTerm('');
    setSearchResults([]);
    // Fetch current alternatives (manual + same active ingredient)
    try {
      const data = await dbSelect(`
        SELECT m.*,
               CASE WHEN m.active_ingredient = ? AND m.active_ingredient IS NOT NULL AND m.active_ingredient != '' THEN 1 ELSE 0 END as is_auto,
               (SELECT SUM(quantity) FROM inventory WHERE drug_id = m.id) as total_stock
        FROM master_drugs m
        WHERE (m.active_ingredient = ? 
               AND m.active_ingredient IS NOT NULL 
               AND m.active_ingredient != '' 
               AND m.id != ?)
           OR m.id IN (
               SELECT alternative_id FROM drug_alternatives WHERE drug_id = ?
               UNION
               SELECT drug_id FROM drug_alternatives WHERE alternative_id = ?
           )
      `, [drug.active_ingredient, drug.active_ingredient, drug.id, drug.id, drug.id]);
      setAlternatives((data as any[]).sort((a: any, b: any) => (b.total_stock || 0) - (a.total_stock || 0)));

      // Fetch Interactions (Conflicts + Food)
      if (drug.active_ingredient) {
        // Split compound active ingredients: "MEBEVERINE + SULPIRIDE" → ["MEBEVERINE", "SULPIRIDE"]
        const ingredientParts = drug.active_ingredient
          .split(/[+,;]/)
          .map((p: string) => p.trim())
          .filter((p: string) => p.length > 0);

        let allFoodItems: any[] = [];
        const conflictingMap = new Map<number, any>(); // keyed by drug id to deduplicate

        for (const ingredient of ingredientParts) {
          // Case-insensitive search in drug_interactions
          const interactions = await dbSelect(`
            SELECT id, ingredient_a, ingredient_b, severity, description_ar, description_en
            FROM drug_interactions
            WHERE UPPER(ingredient_a) = UPPER(?) OR UPPER(ingredient_b) = UPPER(?)
          `, [ingredient, ingredient]) as any[];

          // Separate food vs drug conflicts
          const foodItems = interactions.filter((i: any) => i.severity === 'food');
          allFoodItems = [...allFoodItems, ...foodItems];

          // Sort conflicts by severity so major conflicts are processed first
          const conflictItems = interactions
            .filter((i: any) => i.severity !== 'food')
            .sort((a: any, b: any) => {
              const weight = (s: string) => s === 'major' ? 3 : s === 'moderate' ? 2 : 1;
              return weight(b.severity) - weight(a.severity);
            });

          for (const interaction of conflictItems) {
            // Stop processing if we already found enough conflicting drugs to display (prevent UI lag)
            if (conflictingMap.size >= 250) break;

            // Determine which side is the "other" ingredient
            const isA = interaction.ingredient_a.toUpperCase() === ingredient.toUpperCase();
            const otherIngredient = isA ? interaction.ingredient_b : interaction.ingredient_a;

            // Find drugs in master_drugs whose active_ingredient CONTAINS this ingredient (case-insensitive)
            const drugsWithOtherIngredient = await dbSelect(`
              SELECT id, trade_name, official_price, active_ingredient, manufacturer
              FROM master_drugs
              WHERE UPPER(active_ingredient) LIKE UPPER(?) AND id != ?
              LIMIT 30
            `, [`%${otherIngredient}%`, drug.id]) as any[];

            for (const d of drugsWithOtherIngredient) {
              if (conflictingMap.size >= 250) break;
              if (!conflictingMap.has(d.id)) {
                conflictingMap.set(d.id, {
                  ...d,
                  interaction_id: interaction.id,
                  severity: interaction.severity,
                  description: interaction.description_ar || interaction.description_en,
                  conflicting_ingredient: otherIngredient,
                  source_ingredient: ingredient,
                });
              }
            }
          }
        }

        setFoodInteractions(allFoodItems);
        setConflicts(Array.from(conflictingMap.values()));
      } else {
        setConflicts([]);
        setFoodInteractions([]);
      }
    } catch (err) {
      console.error('Failed to load alternatives or interactions:', err);
    }
  };

  const handleAddAlternative = async (alt: MasterDrug) => {
    if (!selectedDrug) return;
    if (alt.id === selectedDrug.id) {
      toast.error('لا يمكن إضافة الصنف كبديل لنفسه');
      return;
    }
    try {
      await dbExecute('INSERT OR IGNORE INTO drug_alternatives (drug_id, alternative_id) VALUES (?, ?)', [selectedDrug.id, alt.id]);
      
      // Re-fetch to maintain proper list order and flags
      const data = await dbSelect(`
        SELECT m.*,
               CASE WHEN m.active_ingredient = ? AND m.active_ingredient IS NOT NULL AND m.active_ingredient != '' THEN 1 ELSE 0 END as is_auto,
               (SELECT SUM(quantity) FROM inventory WHERE drug_id = m.id) as total_stock
        FROM master_drugs m
        WHERE (m.active_ingredient = ? 
               AND m.active_ingredient IS NOT NULL 
               AND m.active_ingredient != '' 
               AND m.id != ?)
           OR m.id IN (
               SELECT alternative_id FROM drug_alternatives WHERE drug_id = ?
               UNION
               SELECT drug_id FROM drug_alternatives WHERE alternative_id = ?
           )
      `, [selectedDrug.active_ingredient, selectedDrug.active_ingredient, selectedDrug.id, selectedDrug.id, selectedDrug.id]);
      setAlternatives((data as any[]).sort((a: any, b: any) => (b.total_stock || 0) - (a.total_stock || 0)));
      
      toast.success('تمت إضافة البديل');
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'فشل الإضافة');
    }
  };

  const handleRemoveAlternative = async (altId: number, isAuto: boolean) => {
    if (!selectedDrug) return;
    if (isAuto) {
       toast.error('هذا البديل مرتبط تلقائياً بناءً على المادة الفعالة ولا يمكن حذفه.');
       return;
    }
    try {
      await dbExecute('DELETE FROM drug_alternatives WHERE (drug_id = ? AND alternative_id = ?) OR (drug_id = ? AND alternative_id = ?)', [selectedDrug.id, altId, altId, selectedDrug.id]);
      
      // Re-fetch
      const data = await dbSelect(`
        SELECT m.*,
               CASE WHEN m.active_ingredient = ? AND m.active_ingredient IS NOT NULL AND m.active_ingredient != '' THEN 1 ELSE 0 END as is_auto,
               (SELECT SUM(quantity) FROM inventory WHERE drug_id = m.id) as total_stock
        FROM master_drugs m
        WHERE (m.active_ingredient = ? 
               AND m.active_ingredient IS NOT NULL 
               AND m.active_ingredient != '' 
               AND m.id != ?)
           OR m.id IN (
               SELECT alternative_id FROM drug_alternatives WHERE drug_id = ?
               UNION
               SELECT drug_id FROM drug_alternatives WHERE alternative_id = ?
           )
      `, [selectedDrug.active_ingredient, selectedDrug.active_ingredient, selectedDrug.id, selectedDrug.id, selectedDrug.id]);
      setAlternatives((data as any[]).sort((a: any, b: any) => (b.total_stock || 0) - (a.total_stock || 0)));
      toast.success('تمت إزالة البديل');
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'فشل الحذف');
    }
  };

  const handleAddFoodInteraction = async () => {
    if (!selectedDrug || !selectedDrug.active_ingredient) {
       toast.error('لم يتم تحديد صنف بمادة فعالة');
       return;
    }
    if (!newFoodInteraction.trim()) {
       toast.error('الرجاء إدخال اسم الغذاء');
       return;
    }
    try {
      await dbExecute(
        'INSERT INTO drug_interactions (ingredient_a, ingredient_b, severity, source) VALUES (?, ?, ?, ?)',
        [selectedDrug.active_ingredient, newFoodInteraction.trim(), 'food', 'MANUAL']
      );
      setNewFoodInteraction('');
      selectDrug(selectedDrug);
      toast.success('تم إضافة التفاعل الغذائي');
    } catch(err: any) {
      console.error(err);
      toast.error(err.message || 'فشل الإضافة');
    }
  };

  const handleRemoveInteraction = async (interactionId: number) => {
    try {
      await dbExecute('DELETE FROM drug_interactions WHERE id = ?', [interactionId]);
      if (selectedDrug) selectDrug(selectedDrug);
      toast.success('تم الحذف بنجاح');
    } catch(err: any) {
      console.error(err);
      toast.error(err.message || 'فشل الحذف');
    }
  };

  return (
    <div className="space-y-8" dir="rtl">
      <Toaster position="top-center" />
      
      {/* Search Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800">
        <div className="relative max-w-2xl mx-auto">
          <label className="block text-sm font-black text-slate-500 mb-2 mr-4">تحديد الصنف الأساسي (كود أو إسم)</label>
          <div className="relative">
            <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-6 h-6 text-primary-500" />
            <input 
              type="text" 
              placeholder="ابحث عن الصنف لربط البدائل به..."
              className="w-full pr-14 pl-6 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none focus:ring-4 focus:ring-primary-500/10 font-black text-lg dark:text-white border-2 border-transparent focus:border-primary-500 transition-all"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-4 bg-white dark:bg-slate-900 rounded-3xl shadow-hard border border-slate-100 dark:border-slate-800 z-50 overflow-hidden animate-in slide-in-from-top-2">
              <div className="max-h-64 overflow-y-auto">
                {searchResults.map(drug => (
                  <button 
                    key={drug.id}
                    onClick={() => selectDrug(drug)}
                    className="w-full p-4 hover:bg-primary-50 dark:hover:bg-primary-900/20 text-right flex justify-between items-center border-b border-slate-50 dark:border-slate-800 last:border-none"
                  >
                    <div className="flex flex-col">
                      <span className="font-black text-slate-900 dark:text-white">{drug.trade_name}</span>
                      <span className="text-xs text-slate-400 font-bold">{drug.active_ingredient}</span>
                    </div>
                    <span className="text-sm font-black text-primary-600 bg-primary-100 dark:bg-primary-900/30 px-3 py-1 rounded-lg">#{drug.id}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedDrug && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
          {/* Main Drug Display */}
          <div className="bg-gradient-to-br from-primary-600 to-primary-800 p-8 rounded-[40px] shadow-lg text-white relative overflow-hidden">
            <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
              <div className="flex items-center gap-6">
                <div className="w-20 h-20 bg-white/20 backdrop-blur-md rounded-3xl flex items-center justify-center">
                  <Activity className="w-10 h-10" />
                </div>
                <div>
                  <h2 className="text-3xl font-black">{selectedDrug.trade_name}</h2>
                  <p className="font-bold opacity-80 mt-1">{selectedDrug.active_ingredient || 'مادة فعالة غير محددة'}</p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="bg-white/10 backdrop-blur-md p-4 rounded-2xl border border-white/20">
                  <span className="block text-xs font-black opacity-60">المجموعة العلمية</span>
                  <span className="font-bold">{selectedDrug.medical_group || '---'}</span>
                </div>
                <div className="bg-white/10 backdrop-blur-md p-4 rounded-2xl border border-white/20">
                  <span className="block text-xs font-black opacity-60">الشركة</span>
                  <span className="font-bold">{selectedDrug.manufacturer || '---'}</span>
                </div>
              </div>
            </div>
            <div className="absolute right-[-20px] top-[-20px] w-48 h-48 bg-white/5 rounded-full blur-3xl" />
          </div>

          {/* Alternatives Grid */}
          <div className="bg-white dark:bg-slate-900 rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden">
            <div className="flex border-b border-slate-100 dark:border-slate-800">
               <button 
                 onClick={() => setActiveTab('alternatives')}
                 className={`flex-1 py-6 font-black text-lg transition-all border-b-4 ${activeTab === 'alternatives' ? 'border-primary-600 text-primary-600 bg-primary-50/50' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
               >بدائل الصنف</button>
               <button 
                 onClick={() => setActiveTab('conflicts')}
                 className={`flex-1 py-6 font-black text-lg transition-all border-b-4 ${activeTab === 'conflicts' ? 'border-red-600 text-red-600 bg-red-50/50' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
               >الأصناف المتعارضة</button>
               <button 
                 onClick={() => setActiveTab('food')}
                 className={`flex-1 py-6 font-black text-lg transition-all border-b-4 ${activeTab === 'food' ? 'border-amber-600 text-amber-600 bg-amber-50/50' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
               >الأغذية</button>
            </div>

            <div className="p-8 space-y-6">
              {activeTab === 'alternatives' && (
                <>
                  <div className="flex justify-between items-center">
                    <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                      <FlaskConical className="w-6 h-6 text-primary-500" />
                      قائمة البدائل الدوائية
                    </h3>
                    <button 
                      onClick={() => setIsSearchingAlt(true)}
                      className="px-6 py-3 bg-slate-900 dark:bg-slate-700 text-white rounded-2xl font-black hover:bg-slate-800 transition-all flex items-center gap-2"
                    >
                      <Plus className="w-5 h-5" />
                      إضافة بديل
                    </button>
                  </div>

                  <div className="bg-slate-50 dark:bg-slate-800/50 rounded-3xl overflow-hidden">
                    <table className="w-full text-right">
                      <thead className="bg-slate-100 dark:bg-slate-800">
                        <tr>
                          <th className="px-6 py-4 font-black text-slate-600">كود</th>
                          <th className="px-6 py-4 font-black text-slate-600">اسم الصنف</th>
                          <th className="px-6 py-4 font-black text-slate-600">الرصيد المتاح</th>
                          <th className="px-6 py-4 font-black text-slate-600">السعر</th>
                          <th className="px-6 py-4 font-black text-slate-600">المادة الفعالة</th>
                          <th className="px-6 py-4 font-black text-slate-600">الشركة</th>
                          <th className="px-6 py-4 font-black text-slate-600 text-center">حذف</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-bold">
                        {alternatives.map(alt => (
                          <tr key={alt.id} className="hover:bg-white dark:hover:bg-slate-800 transition-all">
                            <td className="px-6 py-4 text-slate-400 text-sm">#{alt.id}</td>
                            <td className="px-6 py-4 text-slate-900 dark:text-white">{alt.trade_name}</td>
                            <td className="px-6 py-4 text-emerald-600 font-bold" dir="ltr">{(alt as any).total_stock || 0} in stock</td>
                            <td className="px-6 py-4 text-blue-600 font-black" dir="ltr">{(alt as any).official_price || 0} EGP</td>
                            <td className="px-6 py-4 text-slate-500">{alt.active_ingredient || '---'}</td>
                            <td className="px-6 py-4 text-slate-500 text-sm">{alt.manufacturer || '---'}</td>
                            <td className="px-6 py-4">
                              <div className="flex justify-center">
                                <button 
                                  onClick={() => handleRemoveAlternative(alt.id, (alt as any).is_auto === 1)}
                                  title={(alt as any).is_auto === 1 ? 'مرتبط تلقائياً (لا يمكن حذفه)' : 'حذف البديل'}
                                  className={cn(
                                    "p-2 rounded-xl transition-all",
                                    (alt as any).is_auto === 1 
                                      ? "text-slate-300 dark:text-slate-600 cursor-not-allowed" 
                                      : "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                                  )}
                                >
                                  <Trash2 className="w-5 h-5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {alternatives.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-6 py-12 text-center text-slate-400 italic">لا يوجد بدائل مضافة لهذا الصنف بعد.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {activeTab === 'conflicts' && (
                <>
                  <div className="flex justify-between items-center">
                    <h3 className="text-xl font-black text-red-600 flex items-center gap-3">
                      <Activity className="w-6 h-6" />
                      الأصناف المتعارضة دوائياً
                    </h3>
                    {conflicts.length > 0 && (
                      <span className="px-3 py-1 text-sm font-black bg-red-100 text-red-600 rounded-xl">
                        {conflicts.length} صنف متعارض
                      </span>
                    )}
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-800/50 rounded-3xl overflow-hidden">
                    <table className="w-full text-right">
                      <thead className="bg-red-50 dark:bg-red-900/20">
                        <tr>
                          <th className="px-6 py-4 font-black text-red-600">اسم الصنف المتعارض</th>
                          <th className="px-6 py-4 font-black text-red-600">المادة الفعالة المتعارضة</th>
                          <th className="px-6 py-4 font-black text-red-600">التفاصيل</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-bold">
                        {conflicts.map(conf => (
                          <tr key={conf.id} className="hover:bg-white dark:hover:bg-slate-800 transition-all">
                            <td className="px-6 py-4">
                              <span className="block text-slate-900 dark:text-white">{conf.trade_name}</span>
                              <span className="text-xs text-slate-400 font-bold">#{conf.id}</span>
                            </td>
                            <td className="px-6 py-4">
                              <span className="block text-slate-700 dark:text-slate-300">{conf.active_ingredient}</span>
                              <span className="inline-block mt-1 px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg text-xs">
                                يحتوي: {conf.conflicting_ingredient}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-slate-500 text-sm max-w-[220px] truncate" title={conf.description}>
                              {conf.description || '---'}
                            </td>
                          </tr>
                        ))}
                        {conflicts.length === 0 && (
                          <tr>
                            <td colSpan={3} className="px-6 py-12 text-center text-slate-400 italic">لا توجد أصناف متعارضة مسجلة.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {activeTab === 'food' && (
                <div className="space-y-6">
                  <div className="flex flex-col md:flex-row gap-4 items-end bg-amber-50 dark:bg-amber-900/10 p-6 rounded-3xl border border-amber-100 dark:border-amber-900/20">
                    <div className="flex-1 w-full space-y-2">
                      <label className="text-sm font-bold text-amber-700 dark:text-amber-500">إسم الغذاء المتعارض</label>
                      <input 
                        type="text" 
                        value={newFoodInteraction}
                        onChange={(e) => setNewFoodInteraction(e.target.value)}
                        placeholder="مثال: الحليب، الجريب فروت..."
                        className="w-full bg-white dark:bg-slate-900 border-none rounded-xl py-3 px-4 text-sm font-bold shadow-sm focus:ring-2 focus:ring-amber-500 outline-none"
                      />
                    </div>
                    <button 
                      onClick={handleAddFoodInteraction}
                      className="px-8 py-3 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-black shadow-sm transition-all h-[44px]"
                    >
                      إضافة التعارض الغذائي
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {foodInteractions.map(food => (
                      <div key={food.id} className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-700 flex justify-between items-center group">
                        <div className="flex items-center gap-4">
                           <div className="w-12 h-12 bg-amber-100 dark:bg-amber-900/30 text-amber-600 rounded-2xl flex items-center justify-center text-xl">
                             🍽️
                           </div>
                           <div>
                             <h4 className="font-black text-slate-900 dark:text-white text-lg">
                               {food.ingredient_a === selectedDrug?.active_ingredient ? food.ingredient_b : food.ingredient_a}
                             </h4>
                             <p className="text-sm font-bold text-slate-500">تعارض غذائي</p>
                           </div>
                        </div>
                        <button 
                          onClick={() => handleRemoveInteraction(food.id)}
                          className="w-10 h-10 flex items-center justify-center rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    ))}
                    {foodInteractions.length === 0 && (
                      <div className="col-span-full py-12 text-center text-slate-400 italic bg-slate-50 dark:bg-slate-800/50 rounded-3xl">
                        لا توجد تعارضات غذائية مسجلة لهذا الصنف.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Alternative Search Modal */}
      {isSearchingAlt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95">
             <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white">البحث عن بديل لـ {selectedDrug?.trade_name}</h3>
                <button onClick={() => setIsSearchingAlt(false)}><X className="w-8 h-8 text-slate-400 hover:text-red-500 transition-all" /></button>
             </div>
             <div className="p-8 space-y-6">
                <div className="relative">
                   <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-400" />
                   <input 
                      type="text" 
                      placeholder="ابحث عن الصنف البديل..."
                      className="w-full pr-14 pl-6 py-5 bg-slate-50 dark:bg-slate-800 rounded-3xl outline-none focus:ring-2 focus:ring-primary-500 font-bold dark:text-white"
                      value={altSearchTerm}
                      onChange={(e) => setAltSearchTerm(e.target.value)}
                      autoFocus
                   />
                </div>
                <div className="max-h-80 overflow-y-auto space-y-2 custom-scrollbar">
                   {altSearchResults.map(drug => (
                     <div key={drug.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-all group">
                        <div className="flex flex-col">
                           <span className="font-black text-slate-900 dark:text-white">{drug.trade_name}</span>
                           <span className="text-xs text-slate-400 font-bold">{drug.active_ingredient}</span>
                        </div>
                        <button 
                          onClick={() => handleAddAlternative(drug)}
                          className="px-6 py-2 bg-white dark:bg-slate-700 text-primary-600 rounded-xl font-black shadow-sm group-hover:bg-primary-600 group-hover:text-white transition-all"
                        >
                           إضافة كبديل
                        </button>
                     </div>
                   ))}
                   {altSearchTerm.length >= 2 && altSearchResults.length === 0 && (
                     <div className="text-center py-10 text-slate-400 italic">لا توجد نتائج بحث.</div>
                   )}
                </div>
             </div>
          </div>
        </div>
      )}
    </div>
  )
}

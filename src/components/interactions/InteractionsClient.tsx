'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { addInteractionAction, checkDrugInteractions, getInteractionsAction } from '@/app/actions/interactions';
import { toast } from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { Plus, Search, AlertTriangle, XCircle, AlertCircle, Info, ChevronRight, ChevronLeft, Loader2 } from 'lucide-react';
import { useDebounce } from '@/hooks/use-debounce';

const SEVERITY_CONFIG: Record<string, { label: string; color: string; icon: any; bg: string }> = {
  critical: { label: 'حرجة ⛔', color: 'text-red-700 dark:text-red-300', icon: XCircle, bg: 'bg-red-100 dark:bg-red-900/30 border-red-200 dark:border-red-800' },
  major: { label: 'خطيرة ⚠️', color: 'text-amber-700 dark:text-amber-300', icon: AlertTriangle, bg: 'bg-amber-100 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800' },
  moderate: { label: 'متوسطة ℹ️', color: 'text-yellow-700 dark:text-yellow-300', icon: AlertCircle, bg: 'bg-yellow-100 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800' },
  minor: { label: 'بسيطة', color: 'text-blue-700 dark:text-blue-300', icon: Info, bg: 'bg-blue-100 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800' },
};

interface Props {
  initialInteractions: any[];
  totalCount: number;
  userRole: string;
}

export default function InteractionsClient({ initialInteractions, totalCount, userRole }: Props) {
  const router = useRouter();
  const [interactions, setInteractions] = useState(initialInteractions);
  const [total, setTotal] = useState(totalCount);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 500);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  
  const [showAddForm, setShowAddForm] = useState(false);
  const [checkerInput, setCheckerInput] = useState('');
  const [checkerResults, setCheckerResults] = useState<any>(null);
  const [checkerLoading, setCheckerLoading] = useState(false);

  const [form, setForm] = useState({
    ingredient_a: '',
    ingredient_b: '',
    severity: 'moderate',
    description_ar: '',
    recommendation: '',
  });

  const fetchInteractions = useCallback(async (p: number, s: string, sev: string) => {
    setLoading(true);
    try {
      const res = await getInteractionsAction(p, 50, s, sev);
      if (res.success) {
        setInteractions(res.data || []);
        setTotal(res.total || 0);
      } else {
        toast.error(res.error || 'فشل تحميل البيانات');
      }
    } catch (error) {
      toast.error('حدث خطأ أثناء الاتصال بالخادم');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Skip initial fetch since we have initialInteractions
    if (page === 1 && debouncedSearch === '' && severityFilter === 'all') return;
    fetchInteractions(page, debouncedSearch, severityFilter);
  }, [page, debouncedSearch, severityFilter, fetchInteractions]);

  // Reset page when search or filter changes
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, severityFilter]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await addInteractionAction(form);
    if (result.success) {
      toast.success('تم إضافة التفاعل بنجاح');
      setShowAddForm(false);
      setForm({ ingredient_a: '', ingredient_b: '', severity: 'moderate', description_ar: '', recommendation: '' });
      fetchInteractions(1, debouncedSearch, severityFilter);
    } else {
      toast.error(result.error || 'فشل الإضافة');
    }
  };

  const handleCheck = async () => {
    const ingredients = checkerInput.split(',').map(s => s.trim()).filter(Boolean);
    if (ingredients.length < 2) {
      toast.error('أدخل مادتين فعالتين على الأقل مفصولتين بفاصلة');
      return;
    }
    setCheckerLoading(true);
    try {
      const result = await checkDrugInteractions(ingredients);
      if (result.success) {
        setCheckerResults(result.data);
        if (result.data.interactions.length === 0 && result.data.allergies.length === 0) {
          toast.success('✅ لا توجد تفاعلات معروفة');
        }
      }
    } finally {
      setCheckerLoading(false);
    }
  };

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="space-y-6">
      {/* Quick Checker */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-blue-600 dark:text-blue-400">
          <Search className="w-5 h-5" /> فحص سريع للتفاعلات
        </h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={checkerInput}
            onChange={e => setCheckerInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCheck()}
            placeholder="أدخل المواد الفعالة مفصولة بفاصلة (مثال: warfarin, aspirin)"
            className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-2xl font-bold focus:ring-2 focus:ring-blue-500 outline-none"
          />
          <button
            onClick={handleCheck}
            disabled={checkerLoading}
            className="bg-blue-600 text-white px-8 py-3 rounded-2xl font-bold hover:bg-blue-700 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {checkerLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'فحص'}
          </button>
        </div>

        {/* Checker Results */}
        {checkerResults && (
          <div className="mt-6 space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
            {checkerResults.interactions.length === 0 && checkerResults.allergies.length === 0 ? (
              <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-2xl border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 font-bold flex items-center gap-2">
                <Info className="w-5 h-5" /> لا توجد تفاعلات معروفة بين هذه المواد
              </div>
            ) : (
              <>
                {checkerResults.interactions.map((int: any, idx: number) => {
                  const config = SEVERITY_CONFIG[int.severity] || SEVERITY_CONFIG.minor;
                  const Icon = config.icon;
                  return (
                    <div key={idx} className={`p-4 rounded-2xl border ${config.bg}`}>
                      <div className="flex items-start gap-3">
                        <Icon className={`w-5 h-5 mt-0.5 ${config.color}`} />
                        <div>
                          <p className={`font-bold ${config.color}`}>
                            {int.ingredient_a} + {int.ingredient_b}
                          </p>
                          <p className="text-sm mt-1">{int.description_ar}</p>
                          {int.recommendation && (
                            <p className="text-xs mt-2 opacity-80 font-bold text-slate-700 dark:text-slate-300">💡 التوصية: {int.recommendation}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* Filter + Actions */}
      <div className="flex flex-wrap items-center gap-3 bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث عن مادة فعالة (مثال: warfarin)..."
            className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pr-10 pl-4 py-2.5 rounded-xl text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>

        {userRole === 'owner' && (
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="bg-blue-600 text-white px-5 py-2.5 rounded-xl font-bold text-sm hover:bg-blue-700 transition-all flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> إضافة تفاعل
          </button>
        )}
      </div>

      {/* Add Form */}
      {showAddForm && (
        <form onSubmit={handleAdd} className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl space-y-4 animate-in slide-in-from-top-4 duration-300">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Plus className="w-5 h-5 text-emerald-500" /> إضافة تفاعل دوائي جديد
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input type="text" required value={form.ingredient_a} onChange={e => setForm({...form, ingredient_a: e.target.value})} placeholder="المادة الفعالة الأولى" className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-xl font-bold" />
            <input type="text" required value={form.ingredient_b} onChange={e => setForm({...form, ingredient_b: e.target.value})} placeholder="المادة الفعالة الثانية" className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-xl font-bold" />

            <input type="text" value={form.recommendation} onChange={e => setForm({...form, recommendation: e.target.value})} placeholder="التوصية (اختياري)" className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-xl font-bold" />
          </div>
          <textarea required value={form.description_ar} onChange={e => setForm({...form, description_ar: e.target.value})} placeholder="وصف التفاعل بالتفصيل..." className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-xl font-bold" rows={2} />
          <div className="flex gap-3 pt-2">
            <button type="submit" className="bg-emerald-600 text-white px-10 py-3 rounded-xl font-bold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-200 dark:shadow-none">حفظ</button>
            <button type="button" onClick={() => setShowAddForm(false)} className="bg-slate-200 dark:bg-slate-800 px-8 py-3 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-700 transition-all">إلغاء</button>
          </div>
        </form>
      )}

      {/* Interactions Table */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden min-h-[400px] flex flex-col">
        <div className="flex-1 divide-y divide-slate-100 dark:divide-slate-800">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
              <p className="text-slate-400 font-bold">جاري تحميل التفاعلات...</p>
            </div>
          ) : interactions.length === 0 ? (
            <div className="text-center py-20 text-slate-400 font-bold">لا توجد تفاعلات مطابقة للبحث</div>
          ) : interactions.map((interaction: any) => {
            const config = SEVERITY_CONFIG[interaction.severity] || SEVERITY_CONFIG.minor;
            const Icon = config.icon;
            return (
              <div key={interaction.id} className="px-6 py-5 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors group">
                <div className="flex items-start gap-4">
                  <div className={`p-2.5 rounded-2xl transition-all group-hover:scale-110 ${config.bg}`}>
                    <Icon className={`w-6 h-6 ${config.color}`} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                      <span className="text-lg font-black text-slate-900 dark:text-white uppercase tracking-tight">{interaction.ingredient_a}</span>
                      <span className="text-slate-300 dark:text-slate-600 font-black">+</span>
                      <span className="text-lg font-black text-slate-900 dark:text-white uppercase tracking-tight">{interaction.ingredient_b}</span>
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed max-w-3xl">
                      {interaction.description_ar || interaction.description_en}
                    </p>
                    {interaction.recommendation && (
                      <div className="flex items-center gap-2 mt-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-100 dark:border-blue-900/40 w-fit">
                        <span className="text-xs text-blue-600 dark:text-blue-400 font-bold flex items-center gap-1.5">
                          💡 التوصية: {interaction.recommendation}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        {/* Pagination */}
        {totalPages > 1 && (
          <div className="p-6 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4">
            <div className="text-sm font-bold text-slate-500">
              عرض {interactions.length} من أصل {total.toLocaleString()} تفاعل
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1 || loading}
                className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 transition-all shadow-sm"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-1 px-4">
                <span className="text-sm font-black text-blue-600 dark:text-blue-400">{page}</span>
                <span className="text-sm font-bold text-slate-400">/</span>
                <span className="text-sm font-bold text-slate-500">{totalPages}</span>
              </div>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages || loading}
                className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 transition-all shadow-sm"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

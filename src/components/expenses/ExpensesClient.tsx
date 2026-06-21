'use client';

import React, { useState, useEffect } from 'react';
import { addExpenseAction, getExpensesAction, deleteExpenseAction, getExpenseSummaryAction } from '@/app/actions-client/expenses';
import { getExpenseDefinitionsAction } from '@/app/actions-client/finance';
import { toast } from 'react-hot-toast';
import { Trash2, Plus, Filter } from 'lucide-react';

const FALLBACK_CATEGORIES = [
  { code: 'RENT', name_ar: 'إيجار' },
  { code: 'SALARIES', name_ar: 'رواتب وأجور' },
  { code: 'ELECTRICITY', name_ar: 'كهرباء' },
  { code: 'WATER', name_ar: 'مياه' },
  { code: 'INTERNET', name_ar: 'إنترنت' },
  { code: 'TRANSPORT', name_ar: 'نقل ومواصلات' },
  { code: 'SUPPLIES', name_ar: 'مستلزمات ومواد' },
  { code: 'OTHER', name_ar: 'مصاريف متنوعة' },
];

export default function ExpensesClient() {
  const [expenses, setExpenses] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({
    totalRevenue: 0,
    totalExpenses: 0,
    totalReturns: 0,
    totalCOGS: 0,
    netProfit: 0,
    byCategory: []
  });
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    category: 'OTHER',
    amount: '',
    description: '',
    date: new Date().toLocaleDateString('en-CA'),
  });
  const [filterCategory, setFilterCategory] = useState('all');

  const loadCategories = async () => {
    try {
      const result = await getExpenseDefinitionsAction();
      if (result.success && result.data && result.data.length > 0) {
        setCategories(result.data);
        const firstCat = result.data[0]?.code || 'OTHER';
        setForm(f => ({ ...f, category: firstCat }));
      } else {
        setCategories(FALLBACK_CATEGORIES);
      }
    } catch (err) {
      console.error('Failed to load categories', err);
      setCategories(FALLBACK_CATEGORIES);
    }
  };

  const loadExpenses = async () => {
    setLoading(true);
    try {
      const result = await getExpensesAction({ 
        category: filterCategory !== 'all' ? filterCategory : undefined 
      });
      if (result.success) setExpenses(result.data as any[]);

      const summaryRes = await getExpenseSummaryAction();
      if (summaryRes.success && summaryRes.data) {
        setSummary(summaryRes.data);
      }
    } catch (err) {
      console.error('Error loading expenses/summary', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCategories();
  }, []);

  useEffect(() => {
    loadExpenses();
  }, [filterCategory]);

  const getCategoryLabel = (catCode: string) => {
    const list = categories.length > 0 ? categories : FALLBACK_CATEGORIES;
    const cat = list.find(c => c.code.toUpperCase() === catCode.toUpperCase());
    return cat ? cat.name_ar : catCode;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.amount || parseFloat(form.amount) <= 0) {
      toast.error('يرجى إدخال مبلغ صحيح');
      return;
    }

    const result = await addExpenseAction({
      category: form.category,
      amount: parseFloat(form.amount),
      description: form.description,
      date: form.date,
    });

    if (result.success) {
      toast.success('تم إضافة المصروف بنجاح');
      const defaultCat = categories[0]?.code || 'OTHER';
      setForm({ 
        category: defaultCat, 
        amount: '', 
        description: '', 
        date: new Date().toLocaleDateString('en-CA') 
      });
      setShowForm(false);
      loadExpenses();
    } else {
      toast.error(result.error || 'فشل إضافة المصروف');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذا المصروف؟')) return;
    const result = await deleteExpenseAction(id);
    if (result.success) {
      toast.success('تم الحذف');
      loadExpenses();
    } else {
      toast.error(result.error || 'فشل الحذف');
    }
  };

  return (
    <div className="space-y-8">
      {/* P&L Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-gradient-to-br from-emerald-500 to-green-600 p-6 rounded-3xl text-white shadow-xl hover:scale-[1.02] transition-transform duration-300">
            <p className="text-emerald-100 text-xs font-bold uppercase tracking-wider mb-2">إجمالي الإيرادات</p>
            <h3 className="text-3xl font-black">
              {Number(summary.totalRevenue).toLocaleString()} <span className="text-sm">ج.م</span>
            </h3>
          </div>
          <div className="bg-gradient-to-br from-red-500 to-rose-600 p-6 rounded-3xl text-white shadow-xl hover:scale-[1.02] transition-transform duration-300">
            <p className="text-red-100 text-xs font-bold uppercase tracking-wider mb-2">إجمالي المصروفات</p>
            <h3 className="text-3xl font-black">
              {Number(summary.totalExpenses).toLocaleString()} <span className="text-sm">ج.م</span>
            </h3>
          </div>
          <div className="bg-gradient-to-br from-amber-500 to-orange-600 p-6 rounded-3xl text-white shadow-xl hover:scale-[1.02] transition-transform duration-300">
            <p className="text-amber-100 text-xs font-bold uppercase tracking-wider mb-2">تكلفة المبيعات (COGS)</p>
            <h3 className="text-3xl font-black">
              {Number(summary.totalCOGS || 0).toLocaleString()} <span className="text-sm">ج.م</span>
            </h3>
          </div>
          <div className={`bg-gradient-to-br ${summary.netProfit >= 0 ? 'from-blue-600 to-indigo-700' : 'from-red-700 to-red-900'} p-6 rounded-3xl text-white shadow-xl hover:scale-[1.02] transition-transform duration-300`}>
            <p className="text-blue-100 text-xs font-bold uppercase tracking-wider mb-2">صافي الربح</p>
            <h3 className="text-3xl font-black">
              {Number(summary.netProfit).toLocaleString()} <span className="text-sm">ج.م</span>
            </h3>
            <p className="text-xs mt-2 opacity-80">{summary.netProfit >= 0 ? '📈 ربح' : '📉 خسارة'}</p>
          </div>
        </div>
      )}

      {/* Category Breakdown */}
      {summary && summary.byCategory && summary.byCategory.length > 0 && (
        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
          <h3 className="text-xl font-bold mb-6">📊 توزيع المصروفات حسب الفئة</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {summary.byCategory.map((cat: any, idx: number) => {
              const colors = [
                'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-900',
                'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-900',
                'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-purple-900',
                'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-100 dark:border-amber-900',
                'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-900'
              ];
              return (
                <div key={idx} className={`p-4 rounded-2xl ${colors[idx % colors.length]}`}>
                  <p className="text-xs font-bold uppercase mb-1">{getCategoryLabel(cat.category)}</p>
                  <p className="text-2xl font-black">{Number(cat.total).toLocaleString()}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Actions Bar */}
      <div className="flex items-center justify-between bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-3">
          <Filter className="w-4 h-4 text-slate-400" />
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-2 rounded-xl text-sm font-bold"
          >
            <option value="all">جميع الفئات</option>
            {(categories.length > 0 ? categories : FALLBACK_CATEGORIES).map(c => (
              <option key={c.code} value={c.code}>{c.name_ar}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-blue-600 text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-blue-700 transition-all flex items-center gap-2 shadow-lg shadow-blue-500/20"
        >
          <Plus className="w-4 h-4" /> إضافة مصروف
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl space-y-6 animate-in slide-in-from-top-4 duration-300">
          <h3 className="text-lg font-bold">إضافة مصروف جديد</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-bold text-slate-600 dark:text-slate-400 mb-1 block">الفئة</label>
              <select
                value={form.category}
                onChange={e => setForm({...form, category: e.target.value})}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-xl font-bold"
              >
                {(categories.length > 0 ? categories : FALLBACK_CATEGORIES).map(c => (
                  <option key={c.code} value={c.code}>{c.name_ar}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-bold text-slate-600 dark:text-slate-400 mb-1 block">المبلغ (ج.م)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.amount}
                onChange={e => setForm({...form, amount: e.target.value})}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-xl font-bold"
                placeholder="0.00"
                required
              />
            </div>
            <div>
              <label className="text-sm font-bold text-slate-600 dark:text-slate-400 mb-1 block">التاريخ</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setForm({...form, date: e.target.value})}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-xl font-bold"
                required
              />
            </div>
            <div>
              <label className="text-sm font-bold text-slate-600 dark:text-slate-400 mb-1 block">الوصف</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm({...form, description: e.target.value})}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3 rounded-xl font-bold"
                placeholder="وصف المصروف..."
              />
            </div>
          </div>
          <div className="flex gap-3">
            <button type="submit" className="bg-emerald-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-emerald-700 transition-all">
              حفظ
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="bg-slate-200 dark:bg-slate-800 px-8 py-3 rounded-xl font-bold hover:bg-slate-300 transition-all">
              إلغاء
            </button>
          </div>
        </form>
      )}

      {/* Expenses Table */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden">
        <table className="w-full text-right">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
              <th className="px-6 py-4 text-sm font-bold text-slate-500">التاريخ</th>
              <th className="px-6 py-4 text-sm font-bold text-slate-500">الفئة</th>
              <th className="px-6 py-4 text-sm font-bold text-slate-500">الوصف</th>
              <th className="px-6 py-4 text-sm font-bold text-slate-500">المبلغ</th>
              <th className="px-6 py-4 text-sm font-bold text-slate-500">بواسطة</th>
              <th className="px-6 py-4 text-sm font-bold text-slate-500"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading ? (
              <tr><td colSpan={6} className="text-center py-12 text-slate-400">جاري التحميل...</td></tr>
            ) : expenses.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-slate-400">لا توجد مصروفات مسجلة</td></tr>
            ) : expenses.map((exp: any) => (
              <tr key={exp.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <td className="px-6 py-4 text-sm font-bold text-slate-600 dark:text-slate-400">
                  {new Date(exp.date).toLocaleDateString('ar-EG')}
                </td>
                <td className="px-6 py-4">
                  <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-3 py-1 rounded-full text-xs font-bold">
                    {getCategoryLabel(exp.category)}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm text-slate-700 dark:text-slate-300">{exp.description || '---'}</td>
                <td className="px-6 py-4 font-black text-red-600">{Number(exp.amount).toLocaleString()} ج.م</td>
                <td className="px-6 py-4 text-sm text-slate-500">{exp.user_name}</td>
                <td className="px-6 py-4">
                  <button onClick={() => handleDelete(exp.id)} className="p-2 text-slate-400 hover:text-red-600 transition-colors rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


'use client';

import React, { useState, useEffect, useRef } from 'react';
import { 
  Plus, Search, Save, X, ChevronDown, ChevronLeft, FolderOpen, 
  Landmark, Receipt, CheckCircle, AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { 
  getAccountsAction, 
  getBanksAction, 
  getExpenseDefinitionsAction,
  getTrialBalanceSettingsAction,
  saveTrialBalanceSettingAction
} from '@/app/actions-client/finance';
import { toast } from 'react-hot-toast';

interface Account {
  id: number;
  parent_id: number | null;
  code: string;
  name_ar: string;
  name_en?: string;
  type: string;
  is_group: number;
  children?: Account[];
}

export default function TrialBalanceSettingsClient() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [settings, setSettings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [savingMapping, setSavingMapping] = useState(false);
  const savingMappingRef = useRef(false);
  const loadRequestRef = useRef(0);
  const [activeCategory, setActiveCategory] = useState<'bank' | 'expense'>('bank');
  
  const [showPicker, setShowPicker] = useState<{ show: boolean, targetId?: string, targetName?: string, category: string, targetType?: string } | null>(null);

  useEffect(() => {
    void loadData();
    return () => {
      loadRequestRef.current += 1;
    };
  }, []);

  async function loadData(preserveExisting = false) {
    const requestId = ++loadRequestRef.current;
    if (!preserveExisting) setLoading(true);
    if (preserveExisting) setRefreshError(null);
    else setLoadError(null);
    try {
      const [accRes, bankRes, expRes, setRes] = await Promise.all([
        getAccountsAction(),
        getBanksAction(),
        getExpenseDefinitionsAction(),
        getTrialBalanceSettingsAction()
      ]);
      if (requestId !== loadRequestRef.current) return;

      const failed = [accRes, bankRes, expRes, setRes].find(res => !res.success);
      if (failed) {
        if (preserveExisting) setRefreshError('تعذر تحديث إعدادات ميزان المراجعة');
        else setLoadError(failed.error || 'فشل تحميل إعدادات ميزان المراجعة');
        return;
      }

      setAccounts((accRes.data || []) as any[]);
      setBanks((bankRes.data || []) as any[]);
      setExpenses((expRes.data || []) as any[]);
      setSettings((setRes.data || []) as any[]);
      setLoadError(null);
      setRefreshError(null);
    } catch {
      if (requestId !== loadRequestRef.current) return;
      if (preserveExisting) setRefreshError('تعذر تحديث إعدادات ميزان المراجعة');
      else setLoadError('فشل تحميل إعدادات ميزان المراجعة');
    } finally {
      if (requestId === loadRequestRef.current && !preserveExisting) setLoading(false);
    }
  }

  const getMapping = (category: string, id?: string, name?: string) => {
    const belongsToTarget = (s: any) => s.target_id === id || s.target_name === name;
    return settings.find(s => s.category === `${category}:${id}` && belongsToTarget(s))
      || settings.find(s => s.category === category && belongsToTarget(s));
  };

  const handleSelectAccount = async (accountId: number) => {
    if (!showPicker || savingMappingRef.current) return;

    savingMappingRef.current = true;
    setSavingMapping(true);
    try {
      const res = await saveTrialBalanceSettingAction({
        category: showPicker.category,
        target_type: showPicker.targetType,
        target_id: showPicker.targetId,
        target_name: showPicker.targetName,
        account_id: accountId
      });

      if (res.success) {
        toast.success('تم ربط الحساب بنجاح');
        setShowPicker(null);
        void loadData(true);
      } else {
        toast.error(res.error || 'فشل الربط');
      }
    } catch {
      toast.error('فشل الربط');
    } finally {
      savingMappingRef.current = false;
      setSavingMapping(false);
    }
  };

  if (loading) return <div className="p-20 text-center font-black animate-pulse">جاري تحميل الإعدادات...</div>;
  if (loadError) {
    return (
      <div className="p-20 text-center space-y-4">
        <AlertCircle className="w-10 h-10 text-rose-500 mx-auto" />
        <p className="font-black text-slate-800 dark:text-white">تعذر تحميل إعدادات ميزان المراجعة</p>
        <p className="text-sm font-bold text-slate-500">{loadError}</p>
        <button
          type="button"
          onClick={() => void loadData()}
          className="px-5 py-2 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8" dir="rtl">
      {refreshError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-800">
          <span className="font-black">{refreshError}</span>
          <button
            type="button"
            onClick={() => void loadData(true)}
            className="px-4 py-2 rounded-xl bg-amber-700 text-white text-xs font-black"
          >
            إعادة تحميل الإعدادات
          </button>
        </div>
      )}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
        <h2 className="text-2xl font-black text-slate-800 dark:text-white mb-2">إعدادات ميزان المراجعة</h2>
        <p className="text-slate-500 font-bold">ربط الكيانات (بنوك، نقدية، مصروفات) بشجرة الحسابات العامة</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <div className="space-y-4">
          <CategoryButton 
            active={activeCategory === 'bank'} 
            onClick={() => setActiveCategory('bank')}
            icon={Landmark}
            label="الحسابات البنكية"
            color="blue"
          />
          <CategoryButton 
            active={activeCategory === 'expense'} 
            onClick={() => setActiveCategory('expense')}
            icon={Receipt}
            label="المصروفات الأخرى"
            color="rose"
          />
        </div>

        <div className="lg:col-span-3">
          <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
            <table className="w-full text-right">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                  <th className="px-8 py-6">البيان</th>
                  <th className="px-8 py-6">الحساب المرتبط</th>
                  <th className="px-8 py-6 text-center">الإجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {activeCategory === 'bank' && banks.map(bank => (
                  <MappingRow 
                    key={`bank-${bank.id}`}
                    name={bank.name_ar}
                    mapping={getMapping('bank', bank.id.toString())}
                    onLink={() => setShowPicker({ show: true, category: 'bank', targetId: bank.id.toString(), targetName: bank.name_ar })}
                  />
                ))}
                {activeCategory === 'expense' && expenses.map(exp => (
                  <MappingRow 
                    key={`expense-${exp.id}`}
                    name={exp.name_ar}
                    mapping={getMapping('expense', exp.id.toString())}
                    onLink={() => setShowPicker({ show: true, category: 'expense', targetId: exp.id.toString(), targetName: exp.name_ar })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showPicker && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-8">
          <div className="bg-white dark:bg-slate-900 w-full max-w-4xl max-h-[80vh] rounded-[40px] shadow-2xl flex flex-col overflow-hidden border border-slate-200 dark:border-slate-800">
             <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                <div>
                   <h3 className="text-2xl font-black">اختيار الحساب المحاسبي</h3>
                   <p className="text-slate-500 font-bold">ربط &quot;{showPicker.targetName}&quot; بحساب من الشجرة</p>
                   {savingMapping && <p className="text-xs font-black text-blue-600 mt-2">جاري الربط...</p>}
                </div>
                <button disabled={savingMapping} onClick={() => setShowPicker(null)} className="w-12 h-12 bg-slate-100 dark:bg-slate-800 rounded-2xl flex items-center justify-center text-slate-500 hover:text-rose-500 transition-all disabled:opacity-50">
                   <X className="w-6 h-6" />
                </button>
             </div>
             <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-slate-50/50 dark:bg-slate-800/20">
                <AccountTree 
                  accounts={accounts} 
                  onSelect={(accId) => handleSelectAccount(accId)} 
                  disabled={savingMapping}
                />
             </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryButton({ active, onClick, icon: Icon, label, color }: any) {
  const colors: any = {
    blue: "text-blue-600 bg-blue-50 border-blue-200",
    emerald: "text-emerald-600 bg-emerald-50 border-emerald-200",
    purple: "text-purple-600 bg-purple-50 border-purple-200",
    rose: "text-rose-600 bg-rose-50 border-rose-200"
  };

  const activeColors: any = {
    blue: "bg-blue-600 text-white shadow-blue-500/30",
    emerald: "bg-emerald-600 text-white shadow-emerald-500/30",
    purple: "bg-purple-600 text-white shadow-purple-500/30",
    rose: "bg-rose-600 text-white shadow-rose-500/30"
  };

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-4 px-6 py-5 rounded-[24px] font-black transition-all",
        active 
          ? activeColors[color] + " shadow-xl scale-105" 
          : "bg-white dark:bg-slate-900 text-slate-500 border border-slate-100 dark:border-slate-800 hover:bg-slate-50"
      )}
    >
      <div className={cn(
        "w-10 h-10 rounded-xl flex items-center justify-center",
        active ? "bg-white/20" : colors[color]
      )}>
        <Icon className="w-5 h-5" />
      </div>
      {label}
    </button>
  );
}

function MappingRow({ name, mapping, onLink }: any) {
  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
      <td className="px-8 py-6 font-black text-slate-800 dark:text-white">{name}</td>
      <td className="px-8 py-6">
        {mapping ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono bg-blue-50 text-blue-600 px-2 py-1 rounded">{mapping.account_code}</span>
            <span className="font-bold text-slate-600">{mapping.account_name}</span>
          </div>
        ) : (
          <span className="text-slate-400 italic font-bold">غير مرتبط</span>
        )}
      </td>
      <td className="px-8 py-6 text-center">
        <button 
          onClick={onLink}
          className={cn(
            "px-6 py-2 rounded-xl text-xs font-black transition-all",
            mapping 
              ? "bg-slate-100 text-slate-500 hover:bg-blue-50 hover:text-blue-600" 
              : "bg-blue-600 text-white shadow-lg shadow-blue-500/20 hover:bg-blue-700"
          )}
        >
          {mapping ? 'تعديل الربط' : 'ربط الحساب'}
        </button>
      </td>
    </tr>
  );
}

function AccountTree({ accounts, onSelect, disabled = false }: { accounts: Account[], onSelect: (id: number) => void, disabled?: boolean }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const toggle = (id: number) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const buildTree = (list: Account[]) => {
    const map: any = {};
    const tree: Account[] = [];
    list.forEach(acc => { map[acc.id] = { ...acc, children: [] }; });
    list.forEach(acc => {
      if (acc.parent_id && map[acc.parent_id]) map[acc.parent_id].children.push(map[acc.id]);
      else tree.push(map[acc.id]);
    });
    return tree;
  };

  const tree = buildTree(accounts);

  const renderNode = (node: Account) => (
    <div key={`node-${node.id}-${node.code}`} className="mr-4">
      <div className="flex items-center gap-3 py-2 group">
        {node.is_group ? (
          <button onClick={() => toggle(node.id)} className="text-slate-400 hover:text-slate-600">
            {expanded[node.id] ? <ChevronDown className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        ) : (
          <div className="w-4" />
        )}
        <div className={cn(
          "flex items-center gap-3 px-4 py-2 rounded-xl transition-all cursor-pointer",
          node.is_group ? "font-black text-slate-800 dark:text-white" : "font-bold text-slate-500 hover:bg-blue-50 hover:text-blue-600",
          disabled && !node.is_group && "pointer-events-none opacity-50"
        )}
        onClick={() => !node.is_group && !disabled && onSelect(node.id)}>
          {node.is_group ? <FolderOpen className="w-4 h-4 text-amber-500" /> : <Receipt className="w-4 h-4 text-blue-500" />}
          <span className="text-xs font-mono opacity-50">{node.code}</span>
          <span>{node.name_ar}</span>
        </div>
      </div>
      {node.is_group && expanded[node.id] && (
        <div className="border-r border-slate-100 dark:border-slate-800 mr-2 pr-2">
          {node.children?.map(child => renderNode(child))}
        </div>
      )}
    </div>
  );

  return <div className="space-y-1">{tree.map(node => renderNode(node))}</div>;
}

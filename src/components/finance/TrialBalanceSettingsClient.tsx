'use client';

import React, { useState, useEffect } from 'react';
import { 
  Plus, Search, Save, X, ChevronDown, ChevronLeft, FolderOpen, 
  Landmark, Monitor, Truck, Receipt, CheckCircle, AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { 
  getAccountsAction, 
  getBanksAction, 
  getPointsOfSaleAction, 
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
  const [pos, setPos] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [settings, setSettings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<'bank' | 'cash' | 'delivery' | 'expense'>('bank');
  
  const [showPicker, setShowPicker] = useState<{ show: boolean, targetId?: string, targetName?: string, category: string, targetType?: string } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    const [accRes, bankRes, posRes, expRes, setRes] = await Promise.all([
      getAccountsAction(),
      getBanksAction(),
      getPointsOfSaleAction(),
      getExpenseDefinitionsAction(),
      getTrialBalanceSettingsAction()
    ]);

    if (accRes.success) setAccounts(accRes.data as any[]);
    if (bankRes.success) setBanks(bankRes.data as any[]);
    if (posRes.success) setPos(posRes.data as any[]);
    if (expRes.success) setExpenses(expRes.data as any[]);
    if (setRes.success) setSettings(setRes.data as any[]);
    setLoading(false);
  }

  const getMapping = (category: string, id?: string, name?: string) => {
    return settings.find(s => s.category === category && (s.target_id === id || s.target_name === name));
  };

  const handleSelectAccount = async (accountId: number) => {
    if (!showPicker) return;

    const res = await saveTrialBalanceSettingAction({
      category: showPicker.category,
      target_type: showPicker.targetType,
      target_id: showPicker.targetId,
      target_name: showPicker.targetName,
      account_id: accountId
    });

    if (res.success) {
      toast.success('تم ربط الحساب بنجاح');
      loadData();
      setShowPicker(null);
    } else {
      toast.error(res.error || 'فشل الربط');
    }
  };

  if (loading) return <div className="p-20 text-center font-black animate-pulse">جاري تحميل الإعدادات...</div>;

  return (
    <div className="space-y-8" dir="rtl">
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
            active={activeCategory === 'cash'} 
            onClick={() => setActiveCategory('cash')}
            icon={Monitor}
            label="الحسابات النقدية"
            color="emerald"
          />
          <CategoryButton 
            active={activeCategory === 'delivery'} 
            onClick={() => setActiveCategory('delivery')}
            icon={Truck}
            label="مندوبي التوصيل"
            color="purple"
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
                {activeCategory === 'cash' && pos.map(p => (
                  <MappingRow 
                    key={`cash-${p.id}`}
                    name={p.name_ar}
                    mapping={getMapping('cash', p.id.toString())}
                    onLink={() => setShowPicker({ show: true, category: 'cash', targetId: p.id.toString(), targetName: p.name_ar })}
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
                {activeCategory === 'delivery' && (
                  <tr>
                    <td colSpan={3} className="py-20 text-center text-slate-400 font-bold italic">لا يوجد مناديب مسجلين حالياً</td>
                  </tr>
                )}
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
                   <p className="text-slate-500 font-bold">ربط "{showPicker.targetName}" بحساب من الشجرة</p>
                </div>
                <button onClick={() => setShowPicker(null)} className="w-12 h-12 bg-slate-100 dark:bg-slate-800 rounded-2xl flex items-center justify-center text-slate-500 hover:text-rose-500 transition-all">
                   <X className="w-6 h-6" />
                </button>
             </div>
             <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-slate-50/50 dark:bg-slate-800/20">
                <AccountTree 
                  accounts={accounts} 
                  onSelect={(accId) => handleSelectAccount(accId)} 
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

function AccountTree({ accounts, onSelect }: { accounts: Account[], onSelect: (id: number) => void }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const toggle = (id: number) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const buildTree = (list: Account[]) => {
    const map: any = {};
    const tree: Account[] = [];
    list.forEach(acc => { map[acc.id] = { ...acc, children: [] }; });
    list.forEach(acc => {
      if (acc.parent_id) map[acc.parent_id].children.push(map[acc.id]);
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
          node.is_group ? "font-black text-slate-800 dark:text-white" : "font-bold text-slate-500 hover:bg-blue-50 hover:text-blue-600"
        )}
        onClick={() => !node.is_group && onSelect(node.id)}>
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

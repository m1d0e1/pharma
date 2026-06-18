'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { Activity, Search, Filter } from 'lucide-react';
import { dbSelect } from '@/lib/db/tauri';
import { cn } from '@/lib/utils';

function extractDrugName(action: string, details: string): string {
  if (!details) return '---';
  
  if (action === 'ADD_INVENTORY') {
    const match = details.match(/من\s+(.+)$/);
    if (match) return match[1].trim();
  } else if (action === 'UPDATE_INVENTORY' || action === 'ADJUST_STOCK') {
    const match = details.match(/حدث بيانات\s+(.+?)\s*\(الكمية:/);
    if (match) return match[1].trim();
  } else if (action === 'DELETE_INVENTORY') {
    const match = details.match(/حذف\s+(.+?)\s+من المخزون/);
    if (match) return match[1].trim();
  }

  const generalMatch = details.match(/من\s+(.+)$/);
  if (generalMatch) {
    return generalMatch[1].trim();
  }
  
  return '---';
}

export default function ItemMovementsPage() {
  const [user, setUser] = useState<any>(null);
  const [movements, setMovements] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadMovements() {
      try {
        const localUser = await getClientSession();
        if (localUser) {
          setUser(localUser);
          const data = await dbSelect(`
            SELECT l.*, u.full_name as user_name, u.username
            FROM activity_log l
            LEFT JOIN users u ON l.user_id = u.id
            WHERE l.action IN ('ADD_INVENTORY', 'SALE', 'RETURN', 'ADJUST_STOCK')
            ORDER BY l.created_at DESC
            LIMIT 100
          `);
          setMovements(data || []);
        }
      } catch (err) {
        console.error('Failed to load item movements:', err);
      } finally {
        setLoading(false);
      }
    }

    loadMovements();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user) return <AccessDenied />;

  const filteredMovements = movements.filter((move: any) => {
    const parsedName = extractDrugName(move.action, move.details);
    const text = `${move.action} ${parsedName} ${move.details} ${move.user_name || ''} ${move.username || ''} ${move.user_id}`.toLowerCase();
    return text.includes(searchTerm.toLowerCase());
  });

  return (
    <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-4 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 rounded-[24px] shadow-lg shadow-indigo-500/10">
            <Activity className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">حركات الأصناف</h1>
            <p className="text-slate-500 font-bold">تتبع حركة الصادر والوارد لكل صنف في المخزن.</p>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
          <div className="relative w-full max-w-md">
            <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input 
              type="text" 
              placeholder="ابحث عن صنف أو عملية..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pr-14 pl-6 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none font-bold text-slate-900 dark:text-white" 
            />
          </div>
          <button className="p-4 bg-slate-50 dark:bg-slate-800 text-slate-500 rounded-2xl hover:bg-slate-100 transition-all flex items-center gap-2 font-bold">
            <Filter className="w-5 h-5" /> تصفية
          </button>
        </div>
        <table className="w-full text-right">
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
              <th className="px-8 py-6">التاريخ</th>
              <th className="px-8 py-6">نوع الحركة</th>
              <th className="px-8 py-6">الصنف</th>
              <th className="px-8 py-6">التفاصيل</th>
              <th className="px-8 py-6 text-center">المسؤول</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filteredMovements.map((move: any) => (
              <tr key={move.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                <td className="px-8 py-6 font-bold text-slate-500">{move.created_at}</td>
                <td className="px-8 py-6">
                  <span className={cn(
                    "px-4 py-1.5 rounded-full text-[10px] font-black uppercase",
                    move.action === 'SALE' ? "bg-emerald-50 text-emerald-600" :
                    move.action === 'RETURN' ? "bg-rose-50 text-rose-600" :
                    move.action === 'ADD_INVENTORY' ? "bg-blue-50 text-blue-600" : "bg-amber-50 text-amber-600"
                  )}>
                    {move.action}
                  </span>
                </td>
                <td className="px-8 py-6 font-black text-slate-900 dark:text-white">{extractDrugName(move.action, move.details)}</td>
                <td className="px-8 py-6 font-bold text-slate-600 dark:text-slate-400">{move.details}</td>
                <td className="px-8 py-6 text-center font-bold text-slate-500 dark:text-slate-400">
                  {move.user_name || move.username || `@${move.user_id}`}
                </td>
              </tr>
            ))}
            {filteredMovements.length === 0 && (
              <tr>
                <td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">لا توجد حركات مسجلة حالياً.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

'use client';

import React, { useState } from 'react';
import { Search, Filter, Download, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { clearAuditLogsAction } from '@/app/actions-client/audit';
import { toast } from 'react-hot-toast';
import { useRouter } from 'next/navigation';

interface AuditLog {
  id: number;
  user_id: string;
  action: string;
  details: string;
  created_at: string;
  full_name: string;
  role: string;
}

interface Props {
  initialLogs: AuditLog[];
  onRefresh?: () => Promise<void> | void;
}

const ACTION_COLORS: Record<string, string> = {
  'LOGIN': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  'LOGOUT': 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  'SALE': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  'ADD_INVENTORY': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  'ADD_PATIENT': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  'CREATE_RETURN': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  'ADD_EXPENSE': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  'OPEN_SHIFT': 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  'CLOSE_SHIFT': 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  'ADD_INTERACTION': 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
};

export default function AuditLogClient({ initialLogs, onRefresh }: Props) {
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [isClearing, setIsClearing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const router = useRouter();

  const uniqueActions = [...new Set(initialLogs.map(l => l.action))];

  const filteredLogs = initialLogs.filter(log => {
    const matchesSearch = search === '' || 
      log.details?.toLowerCase().includes(search.toLowerCase()) ||
      log.full_name?.toLowerCase().includes(search.toLowerCase()) ||
      log.action?.toLowerCase().includes(search.toLowerCase());
    const matchesAction = actionFilter === 'all' || log.action === actionFilter;
    return matchesSearch && matchesAction;
  });

  const exportCSV = () => {
    const headers = 'التاريخ,المستخدم,العملية,التفاصيل\n';
    const rows = filteredLogs.map(l => 
      `"${new Date(l.created_at).toLocaleString('ar-EG')}","${l.full_name}","${l.action}","${(l.details || '').replace(/"/g, '""')}"`
    ).join('\n');
    
    const blob = new Blob(['\ufeff' + headers + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_log_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearLogs = async () => {
    setIsClearing(true);
    const result = await clearAuditLogsAction();
    if (result.success) {
      toast.success('تم مسح السجلات بنجاح');
      setShowConfirm(false);
      if (onRefresh) await onRefresh();
      else router.refresh();
    } else {
      toast.error(result.error || 'فشل مسح السجلات');
    }
    setIsClearing(false);
  };

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3 bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث في السجل..."
            className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pr-10 pl-4 py-2.5 rounded-xl text-sm font-bold"
          />
        </div>
        <select
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold"
        >
          <option value="all">جميع العمليات</option>
          {uniqueActions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <button
          onClick={exportCSV}
          className="bg-slate-800 text-white px-5 py-2.5 rounded-xl font-bold text-sm hover:bg-slate-700 transition-all flex items-center gap-2"
        >
          <Download className="w-4 h-4" /> تصدير CSV
        </button>
        
        <button
          onClick={() => setShowConfirm(true)}
          className="bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400 px-5 py-2.5 rounded-xl font-bold text-sm hover:bg-red-100 transition-all flex items-center gap-2"
        >
          <Trash2 className="w-4 h-4" /> مسح السجلات
        </button>
      </div>

      {/* Confirmation Modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[200] p-4">
          <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] shadow-2xl max-w-md w-full overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in duration-300">
            <div className="p-8 text-center space-y-6">
              <div className="w-20 h-20 bg-red-100 dark:bg-red-900/30 rounded-3xl flex items-center justify-center text-red-600 mx-auto shadow-lg shadow-red-500/10">
                <AlertCircle className="w-10 h-10" />
              </div>
              
              <div className="space-y-2">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white">تأكيد مسح السجلات؟</h3>
                <p className="text-slate-500 font-bold leading-relaxed">
                  هذا الإجراء سيقوم بحذف جميع سجلات النشاط نهائياً. لا يمكن التراجع عن هذه الخطوة.
                </p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 px-6 py-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-2xl font-black hover:bg-slate-200 transition-all"
                >
                  إلغاء
                </button>
                <button
                  onClick={handleClearLogs}
                  disabled={isClearing}
                  className="flex-1 px-6 py-4 bg-red-600 text-white rounded-2xl font-black hover:bg-red-700 transition-all shadow-lg shadow-red-500/20 flex items-center justify-center gap-2"
                >
                  {isClearing ? <Loader2 className="w-5 h-5 animate-spin" /> : 'نعم، مسح الكل'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Log entries */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[600px] overflow-auto">
          {filteredLogs.length === 0 ? (
            <div className="text-center py-16 text-slate-400 font-bold">لا توجد سجلات مطابقة</div>
          ) : filteredLogs.map((log) => (
            <div key={log.id} className="flex items-start gap-4 px-6 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
              <div className="flex-shrink-0 mt-1">
                <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5"></div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <span className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wide ${ACTION_COLORS[log.action] || 'bg-slate-100 text-slate-600'}`}>
                    {log.action}
                  </span>
                  <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{log.full_name}</span>
                  <span className="text-xs text-slate-400 font-mono">
                    {log.role === 'owner' ? '👑' : log.role === 'admin' ? '🔑' : '💊'}
                  </span>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400 truncate">{log.details}</p>
              </div>
              <div className="flex-shrink-0 text-left">
                <p className="text-xs text-slate-400 font-mono whitespace-nowrap">
                  {new Date(log.created_at).toLocaleString('ar-EG', { 
                    month: 'short', day: 'numeric', 
                    hour: '2-digit', minute: '2-digit' 
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 text-center">
          <p className="text-xs text-slate-400 font-bold">عرض {filteredLogs.length} من {initialLogs.length} سجل</p>
        </div>
      </div>
    </div>
  );
}

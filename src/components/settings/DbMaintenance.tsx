'use client';

import React, { useEffect, useState } from 'react';
import { Database, ShieldAlert, Sparkles, RefreshCw } from 'lucide-react';
import { runDatabaseMaintenanceClient } from '@/lib/settings/client';
import { toast } from 'react-hot-toast';
import { getClientSession, isOwnerOrAdmin } from '@/lib/auth/local';
import { isTauri } from '@/lib/env';
import { invoke } from '@tauri-apps/api/core';

export default function DbMaintenance() {
  const [running, setRunning] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [backupAllowed, setBackupAllowed] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');

  useEffect(() => {
    let mounted = true;
    if (isTauri) {
      void getClientSession().then(user => {
        if (mounted) setBackupAllowed(isOwnerOrAdmin(user));
      }).catch(() => { /* Keep backup unavailable without a verified user. */ });
    }
    return () => { mounted = false; };
  }, []);

  const handleBackup = async () => {
    setBackupRunning(true);
    setBackupPath('');
    try {
      const user = await getClientSession();
      if (!isOwnerOrAdmin(user)) throw new Error('حفظ نسخة كاملة متاح لمدير النظام أو المالك فقط');
      const path = await invoke<string>('export_database_backup', { userId: user!.id, password: backupPassword });
      setBackupPath(path);
      toast.success('تم حفظ نسخة كاملة تشمل أحدث البيانات');
    } catch (error) {
      toast.error(`فشل حفظ النسخة الاحتياطية: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupRunning(false);
      setBackupPassword('');
    }
  };

  const handleMaintenance = async () => {
    setRunning(true);
    const toastId = toast.loading('جاري إجراء صيانة قاعدة البيانات (VACUUM & ANALYZE)...');
    try {
      const result = await runDatabaseMaintenanceClient();
      if (result.success) {
        toast.success(result.message || 'تم تحسين قاعدة البيانات بنجاح', { id: toastId });
      } else {
        toast.error(result.error || 'فشلت عملية الصيانة', { id: toastId });
      }
    } catch (err) {
      console.error('Maintenance execution error:', err);
      toast.error('حدث خطأ غير متوقع أثناء تنفيذ الصيانة', { id: toastId });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-950 p-8 rounded-[2rem] text-white shadow-2xl relative overflow-hidden group">
      <div className="absolute -top-10 -right-10 w-40 h-40 bg-blue-500/10 blur-3xl rounded-full"></div>
      
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-2xl">
          <Database className="w-6 h-6 text-blue-400" />
        </div>
        <div>
          <h4 className="text-xl font-bold">النسخ الاحتياطي وصيانة قاعدة البيانات</h4>
          <p className="text-slate-400 text-xs">حفظ نسخة كاملة من بيانات النظام وتحسين التخزين المحلي</p>
        </div>
      </div>

      <div className="space-y-4">
        {backupAllowed && (
          <div className="bg-white/5 border border-white/10 p-6 rounded-2xl space-y-4">
            <p className="text-sm text-slate-300">
              يحفظ الزر بيانات النظام وأحدث التغييرات المحفوظة في ملف احتياطي واحد، دون نسخ ملفات DB وWAL وSHM يدوياً. أرسل الملف الناتج وحده للدعم. تحتوي النسخة على بيانات حساسة، شاركها بأمان فقط.
            </p>
            <label className="block text-sm">
              كلمة مرور حسابك لتأكيد النسخ الاحتياطي
              <input type="password" autoComplete="current-password" value={backupPassword}
                onChange={event => setBackupPassword(event.target.value)} disabled={backupRunning}
                className="block w-full mt-2 p-3 rounded-xl bg-slate-800" />
            </label>
            <button type="button" onClick={handleBackup} disabled={running || backupRunning || !backupPassword}
              className="w-full py-4 bg-emerald-700 rounded-2xl font-bold disabled:opacity-50">
              {backupRunning ? 'جاري حفظ النسخة...' : 'حفظ نسخة احتياطية كاملة'}
            </button>
            {backupPath && (
              <div role="status" className="text-sm space-y-2">
                <p>تم حفظ النسخة الكاملة. مكان الملف:</p>
                <p dir="ltr" className="text-xs break-all select-all">{backupPath}</p>
              </div>
            )}
          </div>
        )}
        <div className="bg-white/5 border border-white/10 p-6 rounded-2xl space-y-4">
          <p className="text-sm text-slate-300 leading-relaxed">
            يقوم هذا الإجراء بإعادة بناء ملف قاعدة البيانات بالكامل لاستعادة المساحة المهدرة الناتجة عن حذف الفواتير والأصناف السابقة (`VACUUM`)، ويقوم بتحديث إحصائيات الفهارس لتسريع محرك بحث SQLite (`ANALYZE`).
          </p>

          <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl flex gap-3 text-amber-200">
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed font-semibold">
              تنبيه: قد تتوقف عمليات الكتابة والقراءة لثوانٍ معدودة أثناء إجراء الصيانة. يُنصح بإجرائها خارج أوقات الذروة.
            </p>
          </div>
          
          <button 
            onClick={handleMaintenance}
            disabled={running || backupRunning}
            className="w-full py-4 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white rounded-2xl font-black shadow-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2 border border-blue-400/20"
          >
            {running ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>جاري تحسين قاعدة البيانات...</span>
              </>
            ) : (
              <>
                <span>تحسين وضغط قاعدة البيانات الآن</span>
                <Sparkles className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

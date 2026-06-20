'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { dbSelect, dbGet } from '@/lib/db/tauri';
import AuditLogClient from '@/components/admin/AuditLogClient';
import AccessDenied from '@/components/AccessDenied';
import { getAuditLogsAction } from '@/app/actions/audit';

export default function AuditPage() {
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [todayCount, setTodayCount] = useState(0);
  const [userActivity, setUserActivity] = useState<any[]>([]);
  const [actionTypes, setActionTypes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAuditLogs = async () => {
    try {
      const localUser = await getClientSession();
      if (!localUser) return;
      setUser(localUser);

      const isAllowed = hasUserPermissionSync(localUser, 'can_view_audit');

      if (isAllowed) {
        setAllowed(true);

        const res = await getAuditLogsAction();
        if (res.success && res.data) {
          setLogs(res.data.logs || []);
          setTodayCount(res.data.todayCount || 0);
          setUserActivity(res.data.userActivity || []);
          setActionTypes(res.data.actionTypes || []);
        }
      }
    } catch (err) {
      console.error('Failed to load audit logs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAuditLogs();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">سجل المراقبة والتدقيق</h1>
          <p className="text-slate-500 mt-1">تتبع جميع العمليات والأنشطة في النظام</p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-3xl text-white shadow-xl">
          <p className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2">عمليات اليوم</p>
          <h3 className="text-4xl font-black">{todayCount}</h3>
        </div>
        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
          <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-3">نشاط الموظفين (7 أيام)</p>
          <div className="space-y-2">
            {userActivity.map((u: any, i: number) => (
              <div key={i} className="flex justify-between items-center">
                <span className="text-sm font-bold">{u.full_name}</span>
                <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-3 py-0.5 rounded-full text-xs font-black">{u.actions}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
          <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-3">أنواع العمليات (7 أيام)</p>
          <div className="space-y-2">
            {actionTypes.map((t: any, i: number) => (
              <div key={i} className="flex justify-between items-center">
                <span className="text-sm font-bold">{t.action}</span>
                <span className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 px-3 py-0.5 rounded-full text-xs font-black">{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <AuditLogClient initialLogs={logs} onRefresh={loadAuditLogs} />
    </div>
  );
}

'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getCurrentShiftAction, getShiftsAction } from '@/app/actions-client/shifts';
import AccessDenied from '@/components/AccessDenied';

export default function ShiftsPage() {
  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [shifts, setShifts] = useState<any[]>([]);
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [hasOpenShift, setHasOpenShift] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    async function loadShiftsData() {
      try {
        const userObj = await getClientSession();
        if (!userObj) return;
        setUser(userObj);
        setUserRole(userObj.role);

        const isAllowed = hasUserPermissionSync(userObj, 'can_view_shifts');

        if (isAllowed) {
          setAllowed(true);
          const [currentResult, shiftsResult] = await Promise.all([
            getCurrentShiftAction(),
            getShiftsAction({ status: 'all' }),
          ]);
          const shift = currentResult.success ? currentResult.data : null;
          setCurrentShift(shift || null);
          setHasOpenShift(!!shift);
          if (shiftsResult.success) setShifts(shiftsResult.data || []);
        }
      } catch (err) {
        console.error('Failed to load shifts data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadShiftsData();
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
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">إدارة الشفتات النقدية</h1>
          <p className="text-slate-500 mt-1">إدارة فتح وإغلاق الشفتات النقدية وتتبع الفروقات</p>
        </div>
        <div className="flex gap-3">
          <Link 
            href="/finance/handover" 
            className="px-6 py-3 bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 text-white rounded-2xl font-bold text-sm shadow-lg transition-all flex items-center gap-2"
          >
            <span>🤝</span>
            <span>تسليم الدرج والمناوبة</span>
          </Link>
        </div>
      </div>

      {/* Current Shift Status */}
      {hasOpenShift && currentShift && (
        <div className="p-6 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 rounded-3xl border-2 border-green-200 dark:border-green-800">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-green-800 dark:text-green-300">✅ لديك شفت مفتوح حالياً</h2>
              <p className="text-green-600 dark:text-green-400 mt-1">
                تم فتح الشفت الساعة {new Date(currentShift.shift_start).toLocaleTimeString('ar-EG')}
              </p>
              <p className="text-green-700 dark:text-green-300 font-bold mt-2">
                الرصيد الافتتاحي: {currentShift.starting_cash_amount.toLocaleString('ar-EG')} ج.م
              </p>
            </div>
            <div className="flex items-center gap-4">
              <Link 
                href="/finance/handover" 
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-2xl shadow-md transition-all flex items-center gap-2 whitespace-nowrap"
              >
                <span>🤝</span>
                <span>تسليم الدرج</span>
              </Link>
              <div className="text-right">
                <p className="text-xs text-green-600 dark:text-green-400">معرف الشفت</p>
                <p className="font-mono text-green-800 dark:text-green-300 font-bold">{currentShift.id.substring(0, 8)}...</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Shift Management Client Component */}
      <ShiftManagementClient 
        initialShifts={shifts}
        currentShift={currentShift}
        hasOpenShift={hasOpenShift}
        userRole={userRole}
      />

      {/* Information Box */}
      <div className="p-6 bg-slate-50 dark:bg-slate-800/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
        <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-3">💡 كيفية عمل نظام الشفتات</h3>
        <ul className="space-y-2 text-slate-600 dark:text-slate-300">
          <li className="flex items-start gap-2">
            <span className="text-blue-500">1.</span>
            <span>يجب على كل صيدلي فتح شفت نقدي عند بداية الدوام بإدخال الرصيد الافتتاحي.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-500">2.</span>
            <span>يتم تسجيل جميع المعاملات النقدية والإلكترونية تلقائياً خلال الشفت.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-500">3.</span>
            <span>عند نهاية الدوام، يتم إغلاق الشفت بإدخال الرصيد الختامي الفعلي.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-500">4.</span>
            <span>يقارن النظام الرصيد المتوقع مع الرصيد الفعلي ويحسب الفرق.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-500">5.</span>
            <span>يجب على المدير التحقق من الشفتات التي تحتوي على فروق كبيرة.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

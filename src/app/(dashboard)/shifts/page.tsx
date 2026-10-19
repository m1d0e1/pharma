'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getCurrentShiftAction, getShiftsAction } from '@/app/actions-client/shifts';
import AccessDenied from '@/components/AccessDenied';
import { CircleHelp, HandCoins, CheckCircle2 } from 'lucide-react';

export default function ShiftsPage() {
  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [shifts, setShifts] = useState<any[]>([]);
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [hasOpenShift, setHasOpenShift] = useState(false);
  const [suggestedStartingCash, setSuggestedStartingCash] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadRequestRef = useRef(0);

  const loadShiftsData = useCallback(async (showLoading = false) => {
    const requestId = ++loadRequestRef.current;
    if (showLoading) setLoading(true);
    setLoadError(false);
    try {
      const userObj = await getClientSession();
      if (requestId !== loadRequestRef.current) return;
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
        if (requestId !== loadRequestRef.current) return;
        if (!currentResult.success || !shiftsResult.success) {
          setLoadError(true);
          return;
        }
        const shift = currentResult.data;
        setCurrentShift(shift || null);
        setHasOpenShift(!!shift);
        if (typeof (currentResult as any).suggested_starting_cash === 'number') {
          setSuggestedStartingCash((currentResult as any).suggested_starting_cash);
        }
        setShifts(shiftsResult.data || []);
      }
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      console.error('Failed to load shifts data:', err);
      setLoadError(true);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadShiftsData(true);
    const refresh = () => { void loadShiftsData(); };
    const storage = (event: StorageEvent) => { if (event.key === 'pharma:shift-updated') refresh(); };
    window.addEventListener('shift-updated', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', storage);
    return () => {
      loadRequestRef.current += 1;
      window.removeEventListener('shift-updated', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', storage);
    };
  }, [loadShiftsData]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col justify-center items-center py-24 gap-4" dir="rtl">
        <p className="font-black text-slate-700 dark:text-slate-200">تعذر تحميل بيانات الشفتات</p>
        <button type="button" onClick={() => void loadShiftsData(true)} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  const canHandover = hasUserPermissionSync(user, 'acc_can_view_handover');

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">إدارة الشفتات النقدية</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">الوردية المشتركة والتسليمات والفروقات النقدية</p>
        </div>
        {canHandover && (
          <div className="flex gap-3">
            <Link
              href="/finance/handover"
              className="px-4 py-2.5 bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 text-white rounded-lg font-semibold text-sm shadow-sm transition-colors flex items-center gap-2"
            >
              <HandCoins className="w-4 h-4" aria-hidden="true" />
              <span>تسليم الدرج والمناوبة</span>
            </Link>
          </div>
        )}
      </div>

      {/* Current Shift Status */}
      {hasOpenShift && currentShift && (
        <div className="p-5 bg-emerald-50 dark:bg-emerald-950/20 rounded-xl border border-emerald-200 dark:border-emerald-900/60">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-green-800 dark:text-green-300 flex items-center gap-2"><CheckCircle2 className="w-5 h-5" aria-hidden="true" /> الوردية المشتركة مفتوحة حالياً</h2>
              <p className="text-green-600 dark:text-green-400 mt-1">
                تم فتح الشفت الساعة {new Date(currentShift.shift_start).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit', hour12: true })}
              </p>
              <p className="text-green-700 dark:text-green-300 font-bold mt-2">
                الرصيد الافتتاحي: {currentShift.starting_cash_amount.toLocaleString('ar-EG')} ج.م
              </p>
            </div>
            <div className="flex items-center gap-4">
              {canHandover && (
                <Link
                  href="/finance/handover"
                  className="px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white font-semibold text-sm rounded-lg shadow-sm transition-colors flex items-center gap-2 whitespace-nowrap"
                >
                  <HandCoins className="w-4 h-4" aria-hidden="true" />
                  <span>تسليم الدرج</span>
                </Link>
              )}
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
        suggestedStartingCash={suggestedStartingCash}
        canViewShiftReports={hasUserPermissionSync(user, 'rep_can_view_shifts')}
        canHandover={canHandover}
      />

      {/* Information Box */}
      <div className="p-5 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-800">
        <h3 className="text-base font-semibold text-slate-800 dark:text-white mb-3 flex items-center gap-2"><CircleHelp className="w-5 h-5 text-blue-600" aria-hidden="true" /> كيفية عمل نظام الشفتات</h3>
        <ul className="space-y-2 text-slate-600 dark:text-slate-300">
          <li className="flex items-start gap-2">
            <span className="text-blue-500">1.</span>
            <span>ينشئ النظام وردية واحدة مشتركة تلقائياً، ويستخدمها جميع المستخدمين بعد تسجيل الدخول.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-500">2.</span>
            <span>يتم تسجيل جميع المعاملات النقدية والإلكترونية تلقائياً خلال الشفت.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-blue-500">3.</span>
            <span>عند التسليم بين المستخدمين تظل الوردية نفسها مفتوحة، وتبقى كل فاتورة مرتبطة بمن نفذها.</span>
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

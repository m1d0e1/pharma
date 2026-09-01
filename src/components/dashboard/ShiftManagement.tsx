'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Clock, Loader2, ArrowRightLeft } from 'lucide-react';
import { getCurrentShiftAction, getCurrentShiftStatsAction } from '@/app/actions-client/shifts';

export default function ShiftManagement() {
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [shiftStats, setShiftStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  useEffect(() => {
    fetchShift();
    // The loader reads only stable action functions and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchShift = async () => {
    setLoading(true);
    const result = await getCurrentShiftAction();
    if (result.success) {
      setCurrentShift(result.data);
      if (result.data?.id) {
        fetchStats();
      } else {
        setShiftStats(null);
      }
    }
    setLoading(false);
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    const result = await getCurrentShiftStatsAction();
    if (result.success) {
      setShiftStats(result.data);
    }
    setStatsLoading(false);
  };

  if (loading) {
    return (
      <div className="card-glass p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <>
      <div className="card-glass relative overflow-hidden group">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-indigo-600"></div>
        
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className={`p-3 rounded-2xl ${currentShift ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-600' : 'bg-blue-100 dark:bg-blue-900/20 text-blue-600'}`}>
              <Clock className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-black">إدارة الورديات</h2>
              <p className="text-xs text-slate-500 font-bold mt-0.5">
                {currentShift ? 'الوردية المشتركة الدائمة نشطة' : 'جاري تهيئة الوردية المشتركة'}
              </p>
            </div>
          </div>
        </div>

        {currentShift ? (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-50 dark:bg-emerald-900/10 rounded-2xl border border-emerald-100 dark:border-emerald-800/30">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-black text-emerald-700 dark:text-emerald-400">Start Time</span>
                <span className="text-sm font-bold">{new Date(currentShift.shift_start).toLocaleTimeString('en-US')}</span>
              </div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-black text-emerald-700 dark:text-emerald-400">Opening Balance</span>
                <span className="text-sm font-black">EGP {currentShift.starting_cash_amount}</span>
              </div>
              {shiftStats && (
                <>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-black text-blue-700 dark:text-blue-400">Total Sales</span>
                    <span className="text-sm font-black text-blue-600">EGP {shiftStats.revenue}</span>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-emerald-200 dark:border-emerald-800">
                    <span className="text-xs font-black text-slate-700 dark:text-slate-300">Expected Cash</span>
                    <span className="text-md font-black text-slate-900 dark:text-white">EGP {shiftStats.expected_cash}</span>
                  </div>
                </>
              )}
            </div>
            
            <Link
              href="/finance/handover"
              className="w-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 py-4 rounded-2xl font-black text-lg transition-all shadow-lg hover:bg-slate-800 dark:hover:bg-slate-100 flex items-center justify-center gap-2 group-hover:scale-[1.02] transform"
            >
              <ArrowRightLeft className="w-5 h-5" />
              تسليم الوردية المشتركة
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
              سينشئ النظام وردية مشتركة لكل المستخدمين تلقائياً عند أول حركة.
            </p>
            <Link
              href="/shifts"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-black text-lg transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2 group-hover:scale-[1.02] transform"
            >
              <ArrowRightLeft className="w-5 h-5" />
              إدارة الجلسات النقدية
            </Link>
          </div>
        )}
      </div>
    </>
  );
}

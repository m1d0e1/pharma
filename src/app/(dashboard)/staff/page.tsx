'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import StaffAnalyticsClient from '@/components/admin/StaffAnalyticsClient';
import { getClientSession } from '@/lib/auth/local';
import { dbSelect } from '@/lib/db/tauri';

export default function StaffPage() {
  const [user, setUser] = useState<any>(null);
  const [staffMetrics, setStaffMetrics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStaffData() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;
        setUser(localUser);

        if (localUser.role !== 'admin' && localUser.role !== 'owner') {
          setLoading(false);
          return;
        }

        // Fetch staff metrics (optimized single query with JOINs and subquery)
        const metrics = await dbSelect(`
          SELECT 
            u.id, 
            u.username, 
            u.full_name, 
            u.role,
            COUNT(si.id) as transactions,
            COALESCE(SUM(si.total_amount), 0) as total_revenue,
            (SELECT COUNT(*) FROM returns r WHERE r.user_id = u.id) as returns_count
          FROM users u
          LEFT JOIN sales_invoices si ON u.id = si.user_id
          GROUP BY u.id
        `);

        const mapped = metrics.map((member: any) => {
          const transactions = member.transactions;
          const totalRevenue = member.total_revenue;
          const avgBasket = transactions > 0 ? totalRevenue / transactions : 0;
          const returnRate = transactions > 0 ? (member.returns_count / transactions) * 100 : 0;

          return {
            id: member.id,
            name: member.full_name || member.username,
            role: member.role,
            transactionsPerShift: transactions,
            avgBasket,
            returnRate,
            totalRevenue
          };
        });

        setStaffMetrics(mapped);
      } catch (err) {
        console.error('Failed to load staff performance data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadStaffData();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center space-y-6 animate-in fade-in duration-700" dir="rtl">
        <div className="text-8xl">🔐</div>
        <div>
          <h2 className="text-3xl font-black text-slate-900 dark:text-white">دخول غير مصرح</h2>
          <p className="text-slate-500 mt-2 max-w-sm mx-auto font-medium">هذه الصفحة تحتوي على تحليلات حساسة ومتاحة فقط لمالك الصيدلية (المدير).</p>
        </div>
        <Link href="/" className="px-8 py-3 bg-blue-600 text-white rounded-2xl font-black shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all">العودة للرئيسية</Link>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">أداء طاقم العمل</h1>
          <p className="text-slate-500 mt-1 italic">خاص بمالك الصيدلية فقط.</p>
        </div>
        <div className="flex gap-3">
           <Link href="/staff/manage" className="bg-slate-900 dark:bg-slate-800 text-white px-6 py-3 rounded-2xl font-bold text-sm shadow-lg hover:bg-slate-800 transition-all">
             🛡️ إدارة الصلاحيات
           </Link>
           <Link href="/shifts" className="bg-blue-600 text-white px-6 py-3 rounded-2xl font-bold text-sm shadow-lg hover:bg-blue-700 transition-all">
             📅 إدارة الشفتات
           </Link>
         </div>
      </div>

      <StaffAnalyticsClient metrics={staffMetrics} />
      
      {!staffMetrics.some(m => m.totalRevenue > 0) && (
        <div className="p-6 bg-slate-50 dark:bg-slate-800/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800 text-center">
           <p className="text-slate-400 font-bold">لا توجد بيانات مبيعات كافية لتحليل أداء الموظفين حالياً.</p>
        </div>
      )}
    </div>
  );
}

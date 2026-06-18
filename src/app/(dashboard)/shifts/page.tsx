'use client';

import React, { useEffect, useState } from 'react';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { dbSelect, dbGet } from '@/lib/db/tauri';
import AccessDenied from '@/components/AccessDenied';

export default function ShiftsPage() {
  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [shifts, setShifts] = useState<any[]>([]);
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [hasOpenShift, setHasOpenShift] = useState(false);
  const [staffList, setStaffList] = useState<any[]>([]);
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
          // 1. Fetch current open shift
          const shift = await dbGet(`
          SELECT id, start_time as shift_start, starting_cash as starting_cash_amount, status
          FROM shifts 
          WHERE user_id = ? AND status = 'open'
        `, [userObj.id]);

        setCurrentShift(shift || null);
        setHasOpenShift(!!shift);

        // 2. Fetch shifts history
        const rawShifts = await dbSelect(`
          SELECT s.id, s.start_time as shift_start, s.end_time as shift_end, 
                 s.starting_cash as starting_cash_amount, s.ending_cash as ending_cash_amount,
                 s.status, s.notes as opening_notes, u.full_name, u.role,
                 COALESCE(sales.total_sales, 0) as total_sales,
                 COALESCE(rets.total_refunds, 0) as total_refunds,
                 COALESCE(moves.net_movements, 0) as net_movements
          FROM shifts s
          JOIN users u ON s.user_id = u.id
          LEFT JOIN (
            SELECT shift_id, SUM(total_amount) as total_sales
            FROM sales_invoices
            WHERE payment_method IN ('cash', 'delivery') AND status = 'completed'
            GROUP BY shift_id
          ) sales ON s.id = sales.shift_id
          LEFT JOIN (
            SELECT shift_id, SUM(total_refund) as total_refunds
            FROM returns
            WHERE refund_method = 'cash' AND status = 'approved'
            GROUP BY shift_id
          ) rets ON s.id = rets.shift_id
          LEFT JOIN (
            SELECT shift_id, SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END) as net_movements
            FROM cash_movements
            GROUP BY shift_id
          ) moves ON s.id = moves.shift_id
          ORDER BY s.start_time DESC LIMIT 50
        `);

        const mappedShifts = rawShifts.map((s: any) => {
          const expectedCash = s.starting_cash_amount + s.total_sales - s.total_refunds + s.net_movements;
          const difference = s.status === 'closed' && s.ending_cash_amount !== null 
            ? (s.ending_cash_amount - expectedCash) 
            : 0;

          return {
            ...s,
            expected_cash_amount: expectedCash,
            cash_difference: difference,
            profiles: {
              full_name: s.full_name,
              role: s.role
            }
          };
        });
        setShifts(mappedShifts);

        // 3. Fetch staff list (if admin/owner)
        if (userObj.role === 'admin' || userObj.role === 'owner') {
          const staff = await dbSelect('SELECT id, full_name, role FROM users ORDER BY full_name ASC');
          setStaffList(staff || []);
        }
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
      </div>

      {/* Current Shift Status */}
      {hasOpenShift && currentShift && (
        <div className="p-6 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 rounded-3xl border-2 border-green-200 dark:border-green-800">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-green-800 dark:text-green-300">✅ لديك شفت مفتوح حالياً</h2>
              <p className="text-green-600 dark:text-green-400 mt-1">
                تم فتح الشفت الساعة {new Date(currentShift.shift_start).toLocaleTimeString('ar-EG')}
              </p>
              <p className="text-green-700 dark:text-green-300 font-bold mt-2">
                الرصيد الافتتاحي: {currentShift.starting_cash_amount.toLocaleString('ar-EG')} ج.م
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-green-600 dark:text-green-400">معرف الشفت</p>
              <p className="font-mono text-green-800 dark:text-green-300">{currentShift.id.substring(0, 8)}...</p>
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
        staffList={staffList}
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

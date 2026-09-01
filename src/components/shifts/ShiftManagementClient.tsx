'use client';
import TableScrollContainer from '@/components/ui/TableScrollContainer';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { openShiftAction, getShiftsAction, forceCloseAllShiftsAction } from '@/app/actions-client/shifts';
import { Button } from '@/components/ui/button';
import { Calendar, Clock, DollarSign, User, AlertCircle, CheckCircle, XCircle, TrendingUp, TrendingDown, ShieldAlert, ArrowRightLeft, Receipt } from 'lucide-react';
import ShiftReceiptsModal from '@/components/shifts/ShiftReceiptsModal';

interface Shift {
  id: string;
  shift_start: string;
  shift_end: string | null;
  starting_cash_amount: number;
  ending_cash_amount: number | null;
  actual_cash?: number | null;
  transfer_amount?: number | null;
  transfer_target?: string | null;
  receiver_id?: string | null;
  receiver_name?: string | null;
  expected_cash_amount: number | null;
  cash_difference: number | null;
  status: 'open' | 'closed' | 'pending_review' | 'discrepancy';
  opening_notes?: string | null;
  closing_notes?: string | null;
  profiles: {
    full_name: string;
    role: string;
  };
}

interface ShiftManagementClientProps {
  initialShifts: Shift[];
  currentShift: Shift | null;
  hasOpenShift: boolean;
  userRole: string;
  suggestedStartingCash?: number;
}

export default function ShiftManagementClient({
  initialShifts,
  currentShift,
  hasOpenShift,
  userRole,
  suggestedStartingCash = 0
}: ShiftManagementClientProps) {
  const [shifts, setShifts] = useState<Shift[]>(initialShifts);
  const [isOpeningShift, setIsOpeningShift] = useState(false);
  const [startingCash, setStartingCash] = useState(() => {
    return suggestedStartingCash > 0 ? String(suggestedStartingCash) : '';
  });
  const [openingNotes, setOpeningNotes] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [isForceClosing, setIsForceClosing] = useState(false);
  const [viewingReceiptsShift, setViewingReceiptsShift] = useState<{ id: string; title: string } | null>(null);

  const isOwnerOrAdmin = userRole === 'owner' || userRole === 'admin';

  useEffect(() => {
    if (!startingCash && suggestedStartingCash > 0 && !hasOpenShift) {
      setStartingCash(String(suggestedStartingCash));
    }
  }, [suggestedStartingCash, hasOpenShift, startingCash]);

  const handleFilterChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const status = e.target.value;
    setStatusFilter(status);
    setError('');
    try {
      const result = await getShiftsAction({ status });
      if (result.success) {
        setShifts(result.data);
      } else {
        setError(result.error || 'فشل جلب الشفتات المفلترة');
      }
    } catch (err) {
      setError('حدث خطأ أثناء تصفية الشفتات');
    }
  };

  const handleForceCloseAll = async () => {
    if (!window.confirm('هل أنت متأكد من رغبتك في إغلاق جميع الشفتات المفتوحة اضطرارياً؟')) return;
    setIsForceClosing(true);
    setError('');
    setSuccess('');
    try {
      const result = await forceCloseAllShiftsAction();
      if (result.success) {
        setSuccess('تم إغلاق جميع الشفتات المفتوحة بنجاح!');
        const shiftsResult = await getShiftsAction({ status: statusFilter });
        if (shiftsResult.success) {
          setShifts(shiftsResult.data);
        }
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        setError(result.error || 'فشل إغلاق الشفتات');
      }
    } catch (err) {
      setError('حدث خطأ غير متوقع');
      console.error(err);
    } finally {
      setIsForceClosing(false);
    }
  };

  const handleOpenShift = async () => {
    if (startingCash === '' || !Number.isFinite(parseFloat(startingCash)) || parseFloat(startingCash) < 0) {
      setError('يرجى إدخال مبلغ نقدي افتتاحي صحيح');
      return;
    }

    setIsOpeningShift(true);
    setError('');
    setSuccess('');

    try {
      const result = await openShiftAction({
        starting_cash_amount: parseFloat(startingCash),
        opening_notes: openingNotes || undefined,
      });

      if (result.success) {
        setSuccess('تم فتح الشفت بنجاح! سيتم تحديث الصفحة تلقائياً...');
        setStartingCash('');
        setOpeningNotes('');
        
        // Refresh shifts list
        const shiftsResult = await getShiftsAction({ status: 'all' });
        if (shiftsResult.success) {
          setShifts(shiftsResult.data);
        }
        
        // Reload page after 2 seconds to show updated current shift
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        setError(result.error || 'فشل فتح الشفت');
      }
    } catch (err) {
      setError('حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى');
      console.error(err);
    } finally {
      setIsOpeningShift(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ar-EG-u-nu-latn', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatCurrency = (amount: number | null | undefined) => {
    if (amount === null || amount === undefined) return '0.00';
    return amount.toLocaleString('ar-EG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  };

  return (
    <div className="space-y-8">
      {/* Shift Actions Card */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Open Shift Card */}
        <div className="p-6 bg-white dark:bg-slate-800 rounded-3xl border-2 border-slate-100 dark:border-slate-700 shadow-lg">
          <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-4">الوردية المشتركة الدائمة</h3>
          
          {hasOpenShift ? (
            <div className="p-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl border border-emerald-200 dark:border-emerald-800">
              <p className="text-emerald-700 dark:text-emerald-300 font-bold">
                وردية واحدة مشتركة نشطة لكل المستخدمين. تظل مفتوحة عند تسجيل الخروج والدخول، وترتبط كل حركة بالمستخدم الذي نفذها.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                      الرصيد الافتتاحي (ج.م)
                    </label>
                    {suggestedStartingCash > 0 && (
                      <span className="text-xs text-blue-600 dark:text-blue-400 font-bold bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-lg">
                        المرحل من الوردية السابقة: {formatCurrency(suggestedStartingCash)} ج.م
                      </span>
                    )}
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={startingCash}
                    onChange={(e) => setStartingCash(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent font-bold text-lg"
                    placeholder="أدخل المبلغ النقدي الافتتاحي"
                  />
                  {suggestedStartingCash > 0 && startingCash !== String(suggestedStartingCash) && (
                    <button
                      type="button"
                      onClick={() => setStartingCash(String(suggestedStartingCash))}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1 font-medium"
                    >
                      ↺ استعادة الرصيد المرحل ({formatCurrency(suggestedStartingCash)} ج.م)
                    </button>
                  )}
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    ملاحظات الافتتاح (اختياري)
                  </label>
                  <textarea
                    value={openingNotes}
                    onChange={(e) => setOpeningNotes(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    rows={3}
                    placeholder="أي ملاحظات حول الشفت..."
                  />
                </div>
                
                <Button
                  onClick={handleOpenShift}
                  disabled={isOpeningShift}
                  className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-2xl"
                >
                  {isOpeningShift ? 'جاري فتح الشفت...' : 'فتح شفت جديد'}
                </Button>
              </div>
            </>
          )}
        </div>

        {/* Close Shift Card */}
        <div className="p-6 bg-white dark:bg-slate-800 rounded-3xl border-2 border-slate-100 dark:border-slate-700 shadow-lg">
          <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-4">تسليم الوردية المشتركة</h3>
          
          {!hasOpenShift ? (
            <div className="p-4 bg-slate-50 dark:bg-slate-700/50 rounded-2xl border border-slate-200 dark:border-slate-600">
              <p className="text-slate-600 dark:text-slate-400">
                لا يوجد شفت مفتوح حالياً. يرجى فتح شفت أولاً.
              </p>
            </div>
          ) : currentShift ? (
            <>
              <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-2xl border border-blue-200 dark:border-blue-800">
                <p className="text-blue-700 dark:text-blue-300">
                  <span className="font-bold">الرصيد الافتتاحي:</span> {formatCurrency(currentShift.starting_cash_amount)} ج.م
                </p>
                <p className="text-blue-600 dark:text-blue-400 text-sm mt-1">
                  تم الفتح: {formatDate(currentShift.shift_start)}
                </p>
              </div>

              <div className="p-5 bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl border border-emerald-200 dark:border-emerald-800 space-y-4">
                <div>
                  <p className="font-bold text-emerald-800 dark:text-emerald-300">الجرد والتسليم المالي</p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">
                    أدخل النقدية الفعلية وحدد ما سيسلم. يسجل النظام العجز أو الزيادة ويبقي الجلسة مفتوحة.
                  </p>
                </div>
                <Link
                  href="/finance/handover"
                  className="block w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow-sm transition-all text-center flex items-center justify-center gap-2"
                >
                  <span>🤝</span>
                  <span>فتح شاشة تسليم الدرج والمناوبة</span>
                </Link>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl">
          <p className="text-red-700 dark:text-red-300 font-bold">⚠️ {error}</p>
        </div>
      )}
      
      {success && (
        <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-2xl">
          <p className="text-green-700 dark:text-green-300 font-bold">✅ {success}</p>
        </div>
      )}

      {/* Shifts History */}
      <div className="p-6 bg-white dark:bg-slate-800 rounded-3xl border-2 border-slate-100 dark:border-slate-700 shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="text-xl font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <span>سجل الشفتات النقدية</span>
              {isOwnerOrAdmin && (
                <span className="text-xs font-bold px-2 py-0.5 bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 rounded-lg flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" />
                  عرض تفاصيل الرقابة المالية
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              متابعة الورديات والمبالغ المحولة للخزينة والرصيد المرحل
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isOwnerOrAdmin && (
              <Button
                onClick={handleForceCloseAll}
                disabled={isForceClosing}
                variant="destructive"
                className="rounded-2xl px-4 py-2 text-sm font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-md border-none"
              >
                {isForceClosing ? 'جاري الإغلاق...' : 'إغلاق جميع الشفتات اضطرارياً'}
              </Button>
            )}
            <select
              value={statusFilter}
              onChange={handleFilterChange}
              className="px-4 py-2 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500 font-bold text-sm"
            >
              <option value="all">جميع الشفتات</option>
              <option value="open">المفتوحة</option>
              <option value="closed">المغلقة</option>
              <option value="discrepancy">تحت المراجعة</option>
            </select>
          </div>
        </div>

        {shifts.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-6xl mb-4">📊</div>
            <p className="text-slate-500 dark:text-slate-400">لا توجد شفتات مسجلة بعد</p>
          </div>
        ) : (
          <TableScrollContainer>
            <table className="w-full text-right">
              <thead className="bg-slate-50 dark:bg-slate-700/50">
                <tr className="border-b border-slate-200 dark:border-slate-700 text-xs font-bold">
                  <th className="py-3 px-4 text-slate-600 dark:text-slate-400">الوردية / افتتحها</th>
                  <th className="py-3 px-4 text-slate-600 dark:text-slate-400">وقت البدء</th>
                  <th className="py-3 px-4 text-slate-600 dark:text-slate-400">وقت الانتهاء</th>
                  <th className="py-3 px-4 text-slate-600 dark:text-slate-400">الرصيد الافتتاحي</th>
                  {isOwnerOrAdmin && (
                    <>
                      <th className="py-3 px-4 text-slate-600 dark:text-slate-400">نقدية الدرج الفعلية</th>
                      <th className="py-3 px-4 text-slate-600 dark:text-slate-400">المحول للخزينة</th>
                      <th className="py-3 px-4 text-slate-600 dark:text-slate-400">المستلم</th>
                      <th className="py-3 px-4 text-slate-600 dark:text-slate-400">العجز / الزيادة</th>
                    </>
                  )}
                  <th className="py-3 px-4 text-slate-600 dark:text-slate-400">المتبقي بالدرج (الختامي)</th>
                  <th className="py-3 px-4 text-slate-600 dark:text-slate-400">الحالة</th>
                  <th className="py-3 px-4 text-slate-600 dark:text-slate-400 text-center">الخيارات والتقارير</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {shifts.map((shift) => (
                  <tr key={shift.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 text-sm transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-bold text-slate-800 dark:text-white">
                        {shift.status === 'open' ? 'الوردية المشتركة' : (shift.profiles?.full_name || 'غير معروف')}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {shift.status === 'open'
                          ? `افتتحها: ${shift.profiles?.full_name || 'غير معروف'}`
                          : shift.profiles?.role === 'admin' ? 'مدير' : shift.profiles?.role === 'owner' ? 'مالك' : 'صيدلي'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-700 dark:text-slate-300 whitespace-nowrap text-xs">
                      {formatDate(shift.shift_start)}
                    </td>
                    <td className="py-3.5 px-4 text-slate-700 dark:text-slate-300 whitespace-nowrap text-xs">
                      {shift.shift_end ? formatDate(shift.shift_end) : '--'}
                    </td>
                    <td className="py-3.5 px-4 font-bold text-slate-800 dark:text-white whitespace-nowrap">
                      {formatCurrency(shift.starting_cash_amount)} ج.م
                    </td>
                    
                    {isOwnerOrAdmin && (
                      <>
                        <td className="py-3.5 px-4 text-slate-800 dark:text-white font-medium whitespace-nowrap">
                          {shift.actual_cash !== null && shift.actual_cash !== undefined
                            ? `${formatCurrency(shift.actual_cash)} ج.م`
                            : '--'}
                        </td>
                        <td className="py-3.5 px-4 text-blue-600 dark:text-blue-400 font-bold whitespace-nowrap">
                          {shift.transfer_amount !== null && shift.transfer_amount !== undefined && shift.transfer_amount > 0
                            ? `${formatCurrency(shift.transfer_amount)} ج.م`
                            : '--'}
                        </td>
                        <td className="py-3.5 px-4 text-slate-600 dark:text-slate-300 whitespace-nowrap text-xs">
                          {shift.receiver_name || '--'}
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {shift.cash_difference !== null && shift.cash_difference !== undefined ? (
                            <div className={`font-black text-xs px-2.5 py-1 rounded-lg inline-block ${
                              shift.cash_difference > 0
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                                : shift.cash_difference < 0
                                ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400'
                                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                            }`}>
                              {shift.cash_difference > 0
                                ? `+${formatCurrency(shift.cash_difference)} ج.م (زيادة)`
                                : shift.cash_difference < 0
                                ? `-${formatCurrency(Math.abs(shift.cash_difference))} ج.م (عجز)`
                                : '0.00 ج.م (مطابق)'}
                            </div>
                          ) : (
                            '--'
                          )}
                        </td>
                      </>
                    )}

                    <td className="py-3.5 px-4 font-bold text-slate-800 dark:text-white whitespace-nowrap">
                      {shift.ending_cash_amount !== null ? `${formatCurrency(shift.ending_cash_amount)} ج.م` : '--'}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${
                        shift.status === 'open' 
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                          : shift.status === 'closed'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                      }`}>
                        {shift.status === 'open' && 'مفتوح'}
                        {shift.status === 'closed' && 'مغلق'}
                        {shift.status === 'pending_review' && 'قيد المراجعة'}
                        {shift.status === 'discrepancy' && 'يوجد فرق'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="flex items-center justify-center gap-1.5">
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => setViewingReceiptsShift({ 
                            id: shift.id, 
                            title: `${shift.status === 'open' ? 'الوردية المشتركة' : `وردية ${shift.profiles?.full_name || ''}`} (${formatDate(shift.shift_start)})`
                          })}
                          className="rounded-xl border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/30 text-xs font-bold flex items-center gap-1 shadow-sm"
                          title="عرض فواتير وإيصالات هذه الوردية"
                        >
                          <Receipt className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                          <span>فواتير الوردية</span>
                        </Button>
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => window.location.href = `/shifts/report?id=${shift.id}`}
                          className="rounded-xl border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800 text-xs font-bold"
                        >
                          تقرير الإغلاق
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScrollContainer>
        )}
      </div>

      {/* Shift Receipts Modal */}
      {viewingReceiptsShift && (
        <ShiftReceiptsModal
          isOpen={!!viewingReceiptsShift}
          shiftId={viewingReceiptsShift.id}
          shiftTitle={viewingReceiptsShift.title}
          onClose={() => setViewingReceiptsShift(null)}
        />
      )}
    </div>
  );
}

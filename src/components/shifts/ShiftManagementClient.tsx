'use client';

import React, { useState } from 'react';
import { openShiftAction, closeShiftAction, getShiftsAction, forceCloseAllShiftsAction } from '@/app/actions-client/shifts';
import { Button } from '@/components/ui/button';
import { Calendar, Clock, DollarSign, User, AlertCircle, CheckCircle, XCircle, TrendingUp, TrendingDown } from 'lucide-react';

interface Shift {
  id: string;
  shift_start: string;
  shift_end: string | null;
  starting_cash_amount: number;
  ending_cash_amount: number | null;
  expected_cash_amount: number | null;
  cash_difference: number | null;
  status: 'open' | 'closed' | 'pending_review' | 'discrepancy';
  opening_notes: string | null;
  closing_notes: string | null;
  profiles: {
    full_name: string;
    role: string;
  };
}

interface StaffMember {
  id: string;
  full_name: string;
  role: string;
}

interface ShiftManagementClientProps {
  initialShifts: Shift[];
  currentShift: Shift | null;
  hasOpenShift: boolean;
  userRole: string;
  staffList: StaffMember[];
}

export default function ShiftManagementClient({
  initialShifts,
  currentShift,
  hasOpenShift,
  userRole,
  staffList
}: ShiftManagementClientProps) {
  const [shifts, setShifts] = useState<Shift[]>(initialShifts);
  const [isOpeningShift, setIsOpeningShift] = useState(false);
  const [isClosingShift, setIsClosingShift] = useState(false);
  const [startingCash, setStartingCash] = useState('');
  const [openingNotes, setOpeningNotes] = useState('');
  const [endingCash, setEndingCash] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [isForceClosing, setIsForceClosing] = useState(false);

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
    if (!startingCash || parseFloat(startingCash) <= 0) {
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
        
        // Save to localStorage for POS
        if (result.shiftId) {
          localStorage.setItem('currentShiftId', result.shiftId);
        }
        
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

  const handleCloseShift = async () => {
    if (!endingCash || parseFloat(endingCash) < 0) {
      setError('يرجى إدخال مبلغ نقدي ختامي صحيح');
      return;
    }

    if (!currentShift) {
      setError('لا يوجد شفت مفتوح للإغلاق');
      return;
    }

    setIsClosingShift(true);
    setError('');
    setSuccess('');

    try {
      const result = await closeShiftAction({
        shift_id: currentShift.id,
        ending_cash_amount: parseFloat(endingCash),
        closing_notes: closingNotes || undefined,
      });

      if (result.success) {
        setSuccess('تم إغلاق الشفت بنجاح!');
        setEndingCash('');
        setClosingNotes('');
        
        // Clear from localStorage
        localStorage.removeItem('currentShiftId');
        
        // Refresh shifts list
        const shiftsResult = await getShiftsAction({ status: 'all' });
        if (shiftsResult.success) {
          setShifts(shiftsResult.data);
        }
        
        // Reload page after 2 seconds
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        setError(result.error || 'فشل إغلاق الشفت');
      }
    } catch (err) {
      setError('حدث خطأ غير متوقع');
      console.error(err);
    } finally {
      setIsClosingShift(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ar-EG', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
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
          <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-4">فتح شفت جديد</h3>
          
          {hasOpenShift ? (
            <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-2xl border border-yellow-200 dark:border-yellow-800">
              <p className="text-yellow-700 dark:text-yellow-300 font-bold">
                لديك شفت مفتوح بالفعل. يرجى إغلاق الشفت الحالي قبل فتح شفت جديد.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    الرصيد الافتتاحي (ج.م)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={startingCash}
                    onChange={(e) => setStartingCash(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="أدخل المبلغ النقدي الافتتاحي"
                  />
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
          <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-4">إغلاق الشفت الحالي</h3>
          
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
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    الرصيد الختامي الفعلي (ج.م)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={endingCash}
                    onChange={(e) => setEndingCash(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="أدخل المبلغ النقدي الختامي"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    ملاحظات الإغلاق (اختياري)
                  </label>
                  <textarea
                    value={closingNotes}
                    onChange={(e) => setClosingNotes(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    rows={3}
                    placeholder="أي ملاحظات حول الإغلاق..."
                  />
                </div>
                
                <Button
                  onClick={handleCloseShift}
                  disabled={isClosingShift}
                  className="w-full py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl"
                >
                  {isClosingShift ? 'جاري إغلاق الشفت...' : 'إغلاق الشفت'}
                </Button>
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
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold text-slate-800 dark:text-white">سجل الشفتات</h3>
          <div className="flex items-center gap-3">
            {(userRole === 'owner' || userRole === 'admin') && (
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
              className="px-4 py-2 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500 font-bold"
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
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="text-right py-3 px-4 text-slate-600 dark:text-slate-400 font-medium">الصيدلي</th>
                  <th className="text-right py-3 px-4 text-slate-600 dark:text-slate-400 font-medium">وقت البدء</th>
                  <th className="text-right py-3 px-4 text-slate-600 dark:text-slate-400 font-medium">وقت الانتهاء</th>
                  <th className="text-right py-3 px-4 text-slate-600 dark:text-slate-400 font-medium">الرصيد الافتتاحي</th>
                  <th className="text-right py-3 px-4 text-slate-600 dark:text-slate-400 font-medium">الرصيد الختامي</th>
                   <th className="text-right py-3 px-4 text-slate-600 dark:text-slate-400 font-medium">الفرق</th>
                  <th className="text-right py-3 px-4 text-slate-600 dark:text-slate-400 font-medium">الحالة</th>
                  <th className="text-right py-3 px-4 text-slate-600 dark:text-slate-400 font-medium">تقرير</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((shift) => (
                  <tr key={shift.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-800 dark:text-white">
                        {shift.profiles?.full_name || 'غير معروف'}
                      </div>
                      <div className="text-sm text-slate-500 dark:text-slate-400">
                        {shift.profiles?.role === 'admin' ? 'مدير' : 'صيدلي'}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-300">
                      {formatDate(shift.shift_start)}
                    </td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-300">
                      {shift.shift_end ? formatDate(shift.shift_end) : '--'}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-800 dark:text-white">
                        {formatCurrency(shift.starting_cash_amount)} ج.م
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-800 dark:text-white">
                        {shift.ending_cash_amount ? `${formatCurrency(shift.ending_cash_amount)} ج.م` : '--'}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {shift.cash_difference !== null ? (
                        <div className={`font-bold ${shift.cash_difference >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {shift.cash_difference >= 0 ? '+' : ''}{formatCurrency(shift.cash_difference)} ج.م
                        </div>
                      ) : (
                        '--'
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                        shift.status === 'open' 
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                          : shift.status === 'closed'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                          : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                      }`}>
                        {shift.status === 'open' && 'مفتوح'}
                        {shift.status === 'closed' && 'مغلق'}
                        {shift.status === 'pending_review' && 'قيد المراجعة'}
                        {shift.status === 'discrepancy' && 'فرق'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => window.location.href = `/shifts/report?id=${shift.id}`}
                        className="rounded-xl border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      >
                        عرض التقرير
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { getTrialBalanceAction } from '@/app/actions/finance';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Printer, RefreshCw, FileText, Download } from 'lucide-react';
import { toast } from 'react-hot-toast';

export default function TrialBalanceReport({ userRole }: { userRole?: string }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await getTrialBalanceAction();
      if (res.success) {
        setData(res.data || []);
      } else {
        toast.error(res.error || 'فشل تحميل ميزان المراجعة');
      }
    } catch (error) {
      console.error('Fetch trial balance error:', error);
      toast.error('حدث خطأ غير متوقع أثناء تحميل البيانات');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const leafAccounts = data.filter(item => item.is_group === 0);
  const totalDebit = leafAccounts.reduce((sum, item) => sum + (item.net_debit || 0), 0);
  const totalCredit = leafAccounts.reduce((sum, item) => sum + (item.net_credit || 0), 0);

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-6 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-black text-slate-800 dark:text-white">ميزان المراجعة</h1>
          <p className="text-slate-500 text-sm mt-1">عرض الأرصدة الختامية لجميع الحسابات</p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={fetchData}
            className="p-3 bg-slate-100 dark:bg-slate-800 rounded-xl hover:bg-slate-200 transition-all"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/20">
            <Printer className="w-5 h-5" />
            طباعة
          </button>
        </div>
      </div>

      {/* Reports Unified Navigation Tab Bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-6 text-sm">
        {userRole === 'owner' && (
          <Link 
            href="/reports" 
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <span>📊</span> التحليلات والمخططات
          </Link>
        )}
        <Link 
          href="/reports/sales" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
        >
          <span>🧾</span> تقرير فواتير المبيعات
        </Link>
        <Link 
          href="/reports/trial-balance" 
          className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2"
        >
          <span>⚖️</span> ميزان المراجعة
        </Link>
      </div>

      <Card className="rounded-[2.5rem] border-none shadow-xl overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-slate-50 dark:bg-slate-800/50">
              <TableRow>
                <TableHead className="text-right py-6 px-8 font-black text-slate-400">كود الحساب</TableHead>
                <TableHead className="text-right py-6 px-8 font-black text-slate-400">اسم الحساب</TableHead>
                <TableHead className="text-center py-6 px-8 font-black text-emerald-600 bg-emerald-50/30">أرصدة مدينة</TableHead>
                <TableHead className="text-center py-6 px-8 font-black text-rose-600 bg-rose-50/30">أرصدة دائنة</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-20 text-slate-400 animate-pulse">جاري تحميل البيانات...</TableCell>
                </TableRow>
              ) : leafAccounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-20 text-slate-400 italic">لا توجد حركات مسجلة حالياً</TableCell>
                </TableRow>
              ) : (
                leafAccounts.map((item) => (
                  <TableRow key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                    <TableCell className="py-5 px-8 font-mono text-xs text-slate-400">{item.code}</TableCell>
                    <TableCell className="py-5 px-8 font-bold text-slate-800 dark:text-white">
                      {item.name_ar}
                    </TableCell>
                    <TableCell className="py-5 px-8 text-center font-black text-emerald-600">
                      {item.net_debit > 0 ? item.net_debit.toLocaleString() : '-'}
                    </TableCell>
                    <TableCell className="py-5 px-8 text-center font-black text-rose-600">
                      {item.net_credit > 0 ? item.net_credit.toLocaleString() : '-'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            <tfoot className="bg-slate-900 text-white font-black">
              <TableRow>
                <TableCell colSpan={2} className="py-6 px-8 text-lg">الإجمالي</TableCell>
                <TableCell className="py-6 px-8 text-center text-xl text-emerald-400">
                  {totalDebit.toLocaleString()}
                </TableCell>
                <TableCell className="py-6 px-8 text-center text-xl text-rose-400">
                  {totalCredit.toLocaleString()}
                </TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </CardContent>
      </Card>
      
      {Math.abs(totalDebit - totalCredit) > 0.01 && (
        <div className="bg-rose-50 border border-rose-100 p-4 rounded-2xl flex items-center gap-3 text-rose-600">
          <div className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
          <p className="font-bold">تنبيه: ميزان المراجعة غير متزن. هناك فرق قدره {(totalDebit - totalCredit).toFixed(2)}</p>
        </div>
      )}
    </div>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  Search, Filter, Calendar, User, ShoppingBag, 
  ChevronDown, FileText, Download, Printer, 
  ArrowRight, CreditCard, DollarSign, Wallet
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getSalesReportsAction, getInvoiceDetailsAction } from '@/app/actions-client/sales-reports';
import { getStaffAction } from '@/app/actions-client/users';
import { getPatientsAction } from '@/app/actions-client/patients';
import { format } from 'date-fns';

export default function SalesReportsClient({ userRole }: { userRole?: string }) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<any[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const [staff, setStaff] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);

  const [filters, setFilters] = useState({
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    userId: 'all',
    patientId: 'all',
    paymentMethod: 'all',
    invoiceNumber: '',
  });

  useEffect(() => {
    async function loadData() {
      const staffRes = await getStaffAction();
      if (staffRes.success) setStaff(staffRes.data || []);

      const patientRes = await getPatientsAction();
      if (patientRes.success) setPatients(patientRes.data || []);

      handleSearch();
    }
    loadData();
  }, []);

  const handleSearch = async () => {
    setLoading(true);
    const res = await getSalesReportsAction({
      ...filters,
      userId: filters.userId === 'all' ? undefined : filters.userId,
      patientId: filters.patientId === 'all' ? undefined : filters.patientId,
    });
    if (res.success) setInvoices(res.data || []);
    setLoading(false);
  };

  const handleInvoiceClick = async (invoiceId: string) => {
    setSelectedInvoice(invoiceId);
    setLoadingItems(true);
    const res = await getInvoiceDetailsAction(invoiceId);
    if (res.success) setInvoiceItems(res.data || []);
    setLoadingItems(false);
  };

  return (
    <div className="space-y-8 pb-20" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-black text-slate-800 dark:text-white">تقرير فواتير المبيعات</h1>
            <p className="text-slate-500 font-bold">عرض وتحليل تفصيلي لعمليات البيع والمرتجعات</p>
          </div>
          <div className="flex gap-4">
            <button className="p-5 bg-slate-50 dark:bg-slate-800 text-slate-500 rounded-2xl border border-slate-100 dark:border-slate-700 hover:bg-slate-100 transition-all">
              <Printer className="w-6 h-6" />
            </button>
            <button className="p-5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 rounded-2xl hover:bg-blue-600 hover:text-white transition-all">
              <Download className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Filters (Following Image 4 style) */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 p-8 bg-slate-50 dark:bg-slate-800/50 rounded-[32px] border border-slate-100 dark:border-slate-700">
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase mr-2">من تاريخ</label>
            <div className="relative">
              <Calendar className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input 
                type="date" 
                className="w-full pr-12 pl-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none focus:border-blue-500"
                value={filters.startDate}
                onChange={(e) => setFilters({...filters, startDate: e.target.value})}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase mr-2">إلى تاريخ</label>
            <div className="relative">
              <Calendar className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input 
                type="date" 
                className="w-full pr-12 pl-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none focus:border-blue-500"
                value={filters.endDate}
                onChange={(e) => setFilters({...filters, endDate: e.target.value})}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase mr-2">الموظف / الصيدلي</label>
            <select 
              className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none"
              value={filters.userId}
              onChange={(e) => setFilters({...filters, userId: e.target.value})}
            >
              <option value="all">كل الموظفين</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase mr-2">طريقة الدفع</label>
            <select 
              className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none"
              value={filters.paymentMethod}
              onChange={(e) => setFilters({...filters, paymentMethod: e.target.value})}
            >
              <option value="all">الكل</option>
              <option value="cash">نقدي</option>
              <option value="credit">آجل / عملاء</option>
              <option value="visa">فيزا / شبكة</option>
            </select>
          </div>
          <div className="md:col-span-2 space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase mr-2">العميل</label>
            <select 
              className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none"
              value={filters.patientId}
              onChange={(e) => setFilters({...filters, patientId: e.target.value})}
            >
              <option value="all">كل العملاء</option>
              {patients.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase mr-2">رقم الفاتورة</label>
            <input 
              type="text" 
              placeholder="ابحث برقم الفاتورة..."
              className="w-full px-4 py-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-bold outline-none"
              value={filters.invoiceNumber}
              onChange={(e) => setFilters({...filters, invoiceNumber: e.target.value})}
            />
          </div>
          <div className="flex items-end">
            <button 
              onClick={handleSearch}
              className="w-full py-3 bg-slate-900 text-white rounded-xl font-black flex items-center justify-center gap-2 hover:bg-slate-800 transition-all shadow-lg"
            >
              <Search className="w-5 h-5" /> بحث (F)
            </button>
          </div>
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
          className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2"
        >
          <span>🧾</span> تقرير فواتير المبيعات
        </Link>
        <Link 
          href="/reports/purchases" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
        >
          <span>🛒</span> تقارير المشتريات
        </Link>
        <Link 
          href="/reports/trial-balance" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
        >
          <span>⚖️</span> ميزان المراجعة
        </Link>
      </div>

      {/* Main Table (Invoices) */}
      <div className="grid grid-cols-1 gap-8">
        <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-right">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
                  <th className="px-8 py-6">الرقم</th>
                  <th className="px-8 py-6">النوع</th>
                  <th className="px-8 py-6">التاريخ</th>
                  <th className="px-8 py-6">العميل</th>
                  <th className="px-8 py-6">الموظف</th>
                  <th className="px-8 py-6">ق. الفاتورة</th>
                  <th className="px-8 py-6">ق. الخصم</th>
                  <th className="px-8 py-6">ق. بعد الخصم</th>
                  <th className="px-8 py-6">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {loading ? (
                  <tr><td colSpan={9} className="py-20 text-center font-bold text-slate-400 italic animate-pulse">جاري البحث...</td></tr>
                ) : invoices.length === 0 ? (
                  <tr><td colSpan={9} className="py-20 text-center font-bold text-slate-400 italic">لا توجد فواتير مطابقة للبحث</td></tr>
                ) : invoices.map((inv) => (
                  <tr 
                    key={inv.id} 
                    onClick={() => handleInvoiceClick(inv.id)}
                    className={cn(
                      "hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer group",
                      selectedInvoice === inv.id ? "bg-blue-50/50 dark:bg-blue-900/10" : ""
                    )}
                  >
                    <td className="px-8 py-6 font-mono font-black text-blue-600 group-hover:underline">#{inv.id.slice(0, 8)}</td>
                    <td className="px-8 py-6">
                      <span className={cn(
                        "px-4 py-1.5 rounded-full text-[10px] font-black",
                        inv.payment_method === 'cash' ? "bg-emerald-50 text-emerald-600" :
                        inv.payment_method === 'visa' ? "bg-blue-50 text-blue-600" : "bg-purple-50 text-purple-600"
                      )}>
                        {inv.payment_method === 'cash' ? 'نقدي' : inv.payment_method === 'visa' ? 'فيزا' : 'آجل'}
                      </span>
                    </td>
                    <td className="px-8 py-6 font-bold text-slate-500">{format(new Date(inv.created_at), 'yyyy/MM/dd HH:mm')}</td>
                    <td className="px-8 py-6 font-black">{inv.patient_name || '-'}</td>
                    <td className="px-8 py-6 font-bold text-slate-400 italic">{inv.staff_name || 'غير محدد'}</td>
                    <td className="px-8 py-6 font-black">{inv.total_amount.toLocaleString()}</td>
                    <td className="px-8 py-6 font-black text-rose-500">{inv.discount_amount?.toLocaleString() || 0}</td>
                    <td className="px-8 py-6 font-black text-lg text-slate-900 dark:text-white">{(inv.total_amount - (inv.discount_amount || 0)).toLocaleString()}</td>
                    <td className="px-8 py-6">
                      <span className={cn(
                        "px-3 py-1 rounded-lg text-[10px] font-black uppercase",
                        inv.status === 'completed' ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/20 dark:text-emerald-400" :
                        inv.status === 'delivered' ? "bg-blue-50 text-blue-600 dark:bg-blue-950/20 dark:text-blue-400" :
                        inv.status === 'draft' ? "bg-amber-50 text-amber-600 dark:bg-amber-950/20 dark:text-amber-400" :
                        "bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                      )}>
                        {inv.status === 'completed' ? 'منتهية' :
                         inv.status === 'delivered' ? 'تم التوصيل' :
                         inv.status === 'draft' ? 'مسودة' : inv.status || 'منتهية'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Invoice Items Table (Lower half of Image 4) */}
        {selectedInvoice && (
          <div className="bg-slate-900 text-white rounded-[40px] p-1 shadow-2xl animate-in slide-in-from-bottom-8">
            <div className="p-8 border-b border-white/10 flex justify-between items-center">
              <div>
                <h4 className="text-xl font-black">أصناف الفاتورة #{selectedInvoice.slice(0, 8)}</h4>
                <p className="text-white/40 text-xs font-bold">تفاصيل المواد المباعة والكميات</p>
              </div>
              <button 
                onClick={() => setSelectedInvoice(null)}
                className="p-3 bg-white/10 rounded-2xl hover:bg-white/20 transition-all"
              >
                <ArrowRight className="w-5 h-5 rotate-180" />
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right">
                <thead className="bg-white/5">
                  <tr className="text-white/40 text-[10px] font-black uppercase tracking-widest">
                    <th className="px-8 py-5">كود الصنف</th>
                    <th className="px-8 py-5">إسم الصنف</th>
                    <th className="px-8 py-5">ت. الصلاحية</th>
                    <th className="px-8 py-5">الكمية</th>
                    <th className="px-8 py-5">الوحدة</th>
                    <th className="px-8 py-5">سعر البيع</th>
                    <th className="px-8 py-5">الإجمالي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {loadingItems ? (
                    <tr><td colSpan={7} className="py-10 text-center animate-pulse">جاري جلب الأصناف...</td></tr>
                  ) : invoiceItems.map((item) => (
                    <tr key={item.id} className="hover:bg-white/5 transition-colors">
                      <td className="px-8 py-5 font-mono text-blue-400">{item.barcode}</td>
                      <td className="px-8 py-5 font-black">{item.trade_name}</td>
                      <td className="px-8 py-5 font-bold text-white/40 italic">2026/05/01</td>
                      <td className="px-8 py-5 font-black text-lg">{item.quantity_sold}</td>
                      <td className="px-8 py-5 text-white/60">{item.unit === 'large' ? 'علبة' : 'شريط'}</td>
                      <td className="px-8 py-5 font-bold">{item.unit_price.toLocaleString()}</td>
                      <td className="px-8 py-5 font-black text-emerald-400">{(item.unit_price * item.quantity_sold).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

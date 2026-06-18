'use client'

import React from 'react'

interface StaffMetric {
  id: string
  name: string
  role: string
  transactionsPerShift: number
  avgBasket: number
  returnRate: number
  totalRevenue: number
}

interface Props {
  metrics: StaffMetric[]
}

export default function StaffAnalyticsClient({ metrics }: Props) {
  const topPerformer = [...metrics].sort((a, b) => b.totalRevenue - a.totalRevenue)[0]

  return (
    <div className="space-y-8">
      {/* Top Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-24 h-24 bg-blue-500/5 rounded-full group-hover:scale-150 transition-transform duration-700"></div>
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-2">الأكثر مبيعاً</p>
          <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-1">{topPerformer?.name || '---'}</h3>
          <p className="text-3xl font-black text-blue-600">
            {(topPerformer?.totalRevenue ?? 0).toLocaleString()} <span className="text-sm">ج.م</span>
          </p>
        </div>

        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-24 h-24 bg-emerald-500/5 rounded-full group-hover:scale-150 transition-transform duration-700"></div>
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-2">متوسط حجم السلة</p>
          <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-1">إجمالي الفريق</h3>
          <p className="text-3xl font-black text-emerald-600">
            {(metrics.reduce((s, m) => s + m.avgBasket, 0) / (metrics.length || 1)).toFixed(2)} <span className="text-sm">ج.م</span>
          </p>
        </div>

        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-24 h-24 bg-purple-500/5 rounded-full group-hover:scale-150 transition-transform duration-700"></div>
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-2">معدل إعادة التموين</p>
          <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-1">الهدف الشهري</h3>
          <p className="text-3xl font-black text-purple-600">68%</p>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="p-6 border-b border-slate-50 dark:border-slate-800">
          <h3 className="font-bold text-lg text-slate-800 dark:text-white">تفاصيل أداء الموظفين</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse" dir="rtl">
            <thead>
              <tr className="bg-slate-50/50 dark:bg-slate-800/50 text-xs font-black text-slate-400 uppercase tracking-widest">
                <th className="px-8 py-5">الموظف</th>
                <th className="px-8 py-5 text-center">معاملة / شفت</th>
                <th className="px-8 py-5 text-center">متوسط السلة</th>
                <th className="px-8 py-5 text-center">معدل المرتجع</th>
                <th className="px-8 py-5 text-center">إجمالي الإيرادات</th>
                <th className="px-8 py-5">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              {metrics.map((staff) => (
                <tr key={staff.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="px-8 py-5">
                    <div className="flex items-center gap-3 text-right">
                       <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center font-bold text-slate-500">
                         {staff.name.charAt(0)}
                       </div>
                       <div>
                         <p className="font-bold text-slate-900 dark:text-white">{staff.name}</p>
                         <p className="text-[10px] text-slate-400 font-bold uppercase">{staff.role === 'admin' || staff.role === 'owner' ? 'مدير' : 'صيدلي'}</p>
                       </div>
                    </div>
                  </td>
                  <td className="px-8 py-5 text-center font-bold text-slate-700 dark:text-slate-300">
                    {staff.transactionsPerShift.toFixed(1)}
                  </td>
                  <td className="px-8 py-5 text-center font-bold text-emerald-600">
                    {staff.avgBasket.toFixed(2)} ج.م
                  </td>
                  <td className="px-8 py-5 text-center">
                    <span className={`px-2 py-1 rounded-lg text-[10px] font-black ${staff.returnRate > 5 ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                      {staff.returnRate.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-8 py-5 text-center font-black text-blue-600">
                    {(staff.totalRevenue ?? 0).toLocaleString()} ج.م
                  </td>
                  <td className="px-8 py-5">
                     <span className="inline-flex items-center gap-1.5 text-[10px] font-black text-emerald-500 uppercase">
                       <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                       متصل
                     </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

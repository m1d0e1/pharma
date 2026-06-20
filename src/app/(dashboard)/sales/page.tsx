'use client';

import React from 'react';
import { 
  ShoppingCart, FileText, RotateCcw, 
  ArrowLeftRight, PackageSearch, Bike, 
  Edit3, BarChart3, Clock
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { getSalesDashboardStatsAction } from '@/app/actions/sales';
import { getClientSession } from '@/lib/auth/local';

const salesModules = [
  { 
    title: 'فاتورة بيع جديدة', 
    desc: 'فتح نقطة البيع لإنشاء فاتورة جديدة', 
    icon: ShoppingCart, 
    href: '/pos', 
    color: 'bg-emerald-500',
    roles: ['owner', 'admin', 'pharmacist']
  },
  { 
    title: 'فواتير البيع المعلقة', 
    desc: 'إدارة المسودات والفواتير غير المكتملة', 
    icon: Clock, 
    href: '/pos?tab=drafts', 
    color: 'bg-amber-500',
    roles: ['owner', 'admin', 'pharmacist']
  },
  { 
    title: 'مرتجع مبيعات', 
    desc: 'إرجاع أصناف من فاتورة سابقة', 
    icon: RotateCcw, 
    href: '/returns', 
    color: 'bg-rose-500',
    roles: ['owner', 'admin', 'pharmacist']
  },
  { 
    title: 'تسليم الدرج', 
    desc: 'تصفية نقدية الوردية وتسليم العهدة', 
    icon: ArrowLeftRight, 
    href: '/finance/handover', 
    color: 'bg-blue-600',
    roles: ['owner', 'admin', 'pharmacist']
  },
  { 
    title: 'تسوية مبيعات بدون رصيد', 
    desc: 'ربط المبيعات السالبة بأرصدة المخزون', 
    icon: PackageSearch, 
    href: '/sales/settlement', 
    color: 'bg-purple-600',
    roles: ['owner', 'admin', 'pharmacist']
  },
  { 
    title: 'توصيل منزلي', 
    desc: 'إغلاق ومتابعة فواتير التوصيل', 
    icon: Bike, 
    href: '/sales/delivery', 
    color: 'bg-rose-600',
    roles: ['owner', 'admin', 'pharmacist']
  },
  { 
    title: 'تعديل تكلفة المبيعات', 
    desc: 'تصحيح هامش الربح للفواتير القديمة', 
    icon: Edit3, 
    href: '/sales/cogs', 
    color: 'bg-indigo-600',
    roles: ['owner']
  },
  { 
    title: 'تقارير المبيعات', 
    desc: 'تحليل المبيعات، الأرباح، والعملاء', 
    icon: BarChart3, 
    href: '/reports/sales', 
    color: 'bg-slate-800',
    roles: ['owner']
  },
];

export default function SalesDashboardPage() {
  const [userRole, setUserRole] = React.useState<string>('pharmacist');
  const [stats, setStats] = React.useState({
    todaySales: 0,
    salesChangeText: 'تحميل البيانات...',
    deliveryCount: 0,
    pendingDeliveryCountText: 'تحميل البيانات...',
    averageInvoice: 0,
    averageInvoiceChangeText: 'تحميل البيانات...'
  });
  const [loadingStats, setLoadingStats] = React.useState(true);

  React.useEffect(() => {
    async function loadRole() {
      const user = await getClientSession();
      if (user && user.role) {
        setUserRole(user.role);
      }
    }
    loadRole();
  }, []);

  React.useEffect(() => {
    async function loadStats() {
      try {
        const res = await getSalesDashboardStatsAction();
        if (res.success && res.data) {
          setStats(res.data);
        }
      } catch (err) {
        console.error('Failed to load sales stats:', err);
      } finally {
        setLoadingStats(false);
      }
    }
    loadStats();
  }, []);

  const filteredModules = salesModules.filter(m => m.roles.includes(userRole));

  return (
    <div className="container mx-auto py-12 space-y-12" dir="rtl">
      <div className="space-y-2">
        <h1 className="text-4xl font-black text-slate-900 dark:text-white">إدارة المبيعات</h1>
        <p className="text-slate-500 font-bold text-lg">تحكم كامل في العمليات البيعية، المرتجعات، والتقارير المالية</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
        {filteredModules.map((module, idx) => (
          <Link 
            key={idx} 
            href={module.href}
            className="group relative bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm hover:shadow-2xl hover:-translate-y-2 transition-all duration-500 overflow-hidden"
          >
            <div className={cn(
              "w-16 h-16 rounded-3xl flex items-center justify-center text-white mb-6 shadow-lg transition-transform group-hover:scale-110 duration-500",
              module.color
            )}>
              <module.icon className="w-8 h-8" />
            </div>
            
            <h3 className="text-xl font-black text-slate-800 dark:text-white mb-2 group-hover:text-blue-600 transition-colors">
              {module.title}
            </h3>
            <p className="text-slate-400 font-bold text-sm leading-relaxed">
              {module.desc}
            </p>

            <div className="absolute top-6 left-6 opacity-0 group-hover:opacity-10 transition-opacity">
               <module.icon className="w-24 h-24 rotate-12" />
            </div>
          </Link>
        ))}
      </div>

      {/* Quick Stats Overlay (Dynamic) */}
      <div className="bg-slate-900 rounded-[50px] p-12 text-white overflow-hidden relative shadow-2xl">
         <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-12">
            <div className="space-y-4">
               <p className="text-white/40 font-black text-xs uppercase tracking-widest">مبيعات اليوم</p>
               <h4 className="text-5xl font-black text-emerald-400">
                 {loadingStats ? '...' : stats.todaySales.toLocaleString()} <span className="text-lg">ج.م</span>
               </h4>
               <p className="text-white/60 font-bold text-sm">{stats.salesChangeText}</p>
            </div>
            <div className="space-y-4 border-r border-white/10 pr-12">
               <p className="text-white/40 font-black text-xs uppercase tracking-widest">طلبات التوصيل اليوم</p>
               <h4 className="text-5xl font-black text-rose-400">
                 {loadingStats ? '...' : stats.deliveryCount}
               </h4>
               <p className="text-white/60 font-bold text-sm">{stats.pendingDeliveryCountText}</p>
            </div>
            <div className="space-y-4 border-r border-white/10 pr-12">
               <p className="text-white/40 font-black text-xs uppercase tracking-widest">متوسط الفاتورة اليوم</p>
               <h4 className="text-5xl font-black text-blue-400">
                 {loadingStats ? '...' : stats.averageInvoice.toLocaleString()} <span className="text-lg">ج.م</span>
               </h4>
               <p className="text-white/60 font-bold text-sm">{stats.averageInvoiceChangeText}</p>
            </div>
         </div>

         <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-br from-blue-600/10 to-transparent pointer-events-none" />
      </div>
    </div>
  );
}

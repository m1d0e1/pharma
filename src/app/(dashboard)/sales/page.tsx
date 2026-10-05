'use client';

import React from 'react';
import { 
  ShoppingCart, FileText, RotateCcw, 
  ArrowLeftRight, PackageSearch, Bike, 
  Edit3, BarChart3, Clock
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { getSalesDashboardStatsAction } from '@/app/actions-client/sales';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

const salesModules = [
  { 
    title: 'فاتورة بيع جديدة', 
    desc: 'فتح نقطة البيع لإنشاء فاتورة جديدة', 
    icon: ShoppingCart, 
    href: '/pos', 
    color: 'bg-emerald-500',
    roles: ['owner', 'admin', 'pharmacist'],
    permission: 'can_access_pos'
  },
  { 
    title: 'فواتير البيع المعلقة', 
    desc: 'إدارة المسودات والفواتير غير المكتملة', 
    icon: Clock, 
    href: '/pos?tab=drafts', 
    color: 'bg-amber-500',
    roles: ['owner', 'admin', 'pharmacist'],
    permission: 'can_access_pos'
  },
  { 
    title: 'مرتجع مبيعات', 
    desc: 'إرجاع أصناف من فاتورة سابقة', 
    icon: RotateCcw, 
    href: '/returns', 
    color: 'bg-rose-500',
    roles: ['owner', 'admin', 'pharmacist'],
    permission: 'can_view_returns'
  },
  { 
    title: 'تسوية مبيعات بدون رصيد', 
    desc: 'ربط المبيعات السالبة بأرصدة المخزون', 
    icon: PackageSearch, 
    href: '/inventory/settlement',
    color: 'bg-purple-600',
    roles: ['owner', 'admin', 'pharmacist'],
    permission: 'can_view_settlement'
  },
  { 
    title: 'توصيل منزلي', 
    desc: 'إغلاق ومتابعة فواتير التوصيل', 
    icon: Bike, 
    href: '/sales/delivery', 
    color: 'bg-rose-600',
    roles: ['owner', 'admin', 'pharmacist'],
    permission: 'can_view_delivery'
  },
  { 
    title: 'تعديل تكلفة المبيعات', 
    desc: 'تصحيح هامش الربح للفواتير القديمة', 
    icon: Edit3, 
    href: '/sales/cogs', 
    color: 'bg-indigo-600',
    roles: ['owner'],
    permission: 'can_view_cogs'
  },
  { 
    title: 'تقارير المبيعات', 
    desc: 'تحليل المبيعات، الأرباح، والعملاء', 
    icon: BarChart3, 
    href: '/reports/sales', 
    color: 'bg-slate-800',
    roles: ['owner'],
    permission: 'rep_can_view_sales'
  },
];

export default function SalesDashboardPage() {
  const [userRole, setUserRole] = React.useState<string>('pharmacist');
  const [sessionUser, setSessionUser] = React.useState<any>(null);
  const [loadingRole, setLoadingRole] = React.useState(true);
  const [roleError, setRoleError] = React.useState(false);
  const roleRequestRef = React.useRef(0);
  const [stats, setStats] = React.useState({
    todaySales: 0,
    salesChangeText: 'تحميل البيانات...',
    deliveryCount: 0,
    pendingDeliveryCountText: 'تحميل البيانات...',
    averageInvoice: 0,
    averageInvoiceChangeText: 'تحميل البيانات...'
  });
  const [loadingStats, setLoadingStats] = React.useState(true);
  const [statsError, setStatsError] = React.useState('');
  const statsRequestRef = React.useRef(0);

  const loadRole = React.useCallback(async () => {
    const requestId = ++roleRequestRef.current;
    setLoadingRole(true);
    setRoleError(false);
    try {
      const user = await getClientSession();
      if (requestId !== roleRequestRef.current) return;
      if (user && user.role) {
        setUserRole(user.role);
        setSessionUser(user);
      } else {
        setUserRole('pharmacist');
        setSessionUser(null);
      }
    } catch (error) {
      if (requestId !== roleRequestRef.current) return;
      console.error('Failed to load sales permissions:', error);
      setRoleError(true);
    } finally {
      if (requestId === roleRequestRef.current) setLoadingRole(false);
    }
  }, []);

  React.useEffect(() => {
    void loadRole();
    return () => {
      roleRequestRef.current += 1;
    };
  }, [loadRole]);

  const loadStats = React.useCallback(async () => {
    const requestId = ++statsRequestRef.current;
    setLoadingStats(true);
    setStatsError('');
    try {
      const res = await getSalesDashboardStatsAction();
      if (requestId !== statsRequestRef.current) return;
      if (res.success && res.data) {
        setStats(res.data);
      } else {
        setStatsError('تعذر تحميل إحصائيات المبيعات');
      }
    } catch (err) {
      if (requestId !== statsRequestRef.current) return;
      console.error('Failed to load sales stats:', err);
      setStatsError('تعذر تحميل إحصائيات المبيعات');
    } finally {
      if (requestId === statsRequestRef.current) setLoadingStats(false);
    }
  }, []);

  React.useEffect(() => {
    void loadStats();
    return () => {
      statsRequestRef.current += 1;
    };
  }, [loadStats]);

  const filteredModules = salesModules.filter(m =>
    m.roles.includes(userRole) && hasUserPermissionSync(sessionUser, m.permission)
  );

  if (loadingRole) {
    return (
      <div role="status" aria-live="polite" className="flex justify-center items-center gap-3 py-24 text-slate-500" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
        <span className="text-sm font-medium">جاري تحميل صلاحيات المبيعات...</span>
      </div>
    );
  }

  if (roleError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24" dir="rtl">
        <p className="font-black text-rose-600">تعذر تحميل صلاحيات المبيعات</p>
        <button type="button" onClick={() => void loadRole()} className="px-4 py-2.5 rounded-lg bg-slate-900 text-white font-semibold">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 space-y-8" dir="rtl">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">إدارة المبيعات</h1>
        <p className="text-slate-500 text-sm sm:text-base">تحكم كامل في العمليات البيعية، المرتجعات، والتقارير المالية</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {filteredModules.map((module, idx) => (
          <Link 
            key={idx} 
            href={module.href}
            className="group relative bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm hover:border-primary-300 dark:hover:border-primary-700 transition-colors overflow-hidden"
          >
            <div className={cn(
              "w-11 h-11 rounded-lg flex items-center justify-center text-white mb-4 shadow-sm",
              module.color
            )}>
              <module.icon className="w-5 h-5" />
            </div>
            
            <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-1.5 group-hover:text-primary-700 dark:group-hover:text-primary-400 transition-colors">
              {module.title}
            </h3>
            <p className="text-slate-500 dark:text-slate-400 text-sm leading-relaxed">
              {module.desc}
            </p>
          </Link>
        ))}
      </div>

      {/* Quick Stats Overlay (Dynamic) */}
      <div className="bg-slate-900 rounded-xl p-6 sm:p-7 text-white overflow-hidden relative shadow-md border border-slate-800">
         {statsError ? (
           <div className="relative z-10 flex flex-col items-center justify-center gap-4 py-8 text-center">
             <p className="font-black text-rose-300">{statsError}</p>
             <button
               type="button"
               onClick={loadStats}
             className="px-4 py-2.5 rounded-lg bg-white text-slate-900 font-semibold"
             >
               إعادة المحاولة
             </button>
           </div>
         ) : <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
               <p className="text-white/40 font-black text-xs uppercase tracking-widest">مبيعات اليوم</p>
               <h4 className="text-3xl font-bold text-emerald-400 tabular-nums">
                 {loadingStats ? '...' : stats.todaySales.toLocaleString()} <span className="text-sm">ج.م</span>
               </h4>
               <p className="text-white/60 text-sm">{stats.salesChangeText}</p>
            </div>
            <div className="space-y-2 md:border-r md:border-white/10 md:pr-6">
               <p className="text-white/40 font-black text-xs uppercase tracking-widest">طلبات التوصيل اليوم</p>
               <h4 className="text-3xl font-bold text-rose-400 tabular-nums">
                 {loadingStats ? '...' : stats.deliveryCount}
               </h4>
               <p className="text-white/60 text-sm">{stats.pendingDeliveryCountText}</p>
            </div>
            <div className="space-y-2 md:border-r md:border-white/10 md:pr-6">
               <p className="text-white/40 font-black text-xs uppercase tracking-widest">متوسط الفاتورة اليوم</p>
               <h4 className="text-3xl font-bold text-blue-400 tabular-nums">
                 {loadingStats ? '...' : stats.averageInvoice.toLocaleString()} <span className="text-sm">ج.م</span>
               </h4>
               <p className="text-white/60 text-sm">{stats.averageInvoiceChangeText}</p>
            </div>
         </div>}
      </div>
    </div>
  );
}

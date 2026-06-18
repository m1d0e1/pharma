'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { 
  FilePlus, 
  RotateCcw, 
  ClipboardList, 
  TrendingUp, 
  Users,
  Search,
  ArrowUpRight
} from 'lucide-react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { cn } from '@/lib/utils';

const purchaseOptions = [
  {
    title: 'فاتورة شراء',
    subtitle: 'تسجيل توريدات جديدة للمخزن',
    href: '/purchases/new',
    icon: FilePlus,
    color: 'bg-primary-500',
    shadow: 'shadow-primary-500/20'
  },
  {
    title: 'مرتجع شراء',
    subtitle: 'إعادة أصناف لمورد محدد',
    href: '/purchases/returns',
    icon: RotateCcw,
    color: 'bg-amber-500',
    shadow: 'shadow-amber-500/20'
  },
  {
    title: 'مرتجع شراء عام',
    subtitle: 'تسجيل مرتجعات غير مرتبطة بفاتورة',
    href: '/purchases/general-returns',
    icon: RotateCcw,
    color: 'bg-orange-500',
    shadow: 'shadow-orange-500/20'
  },
  {
    title: 'تعديل مرتجعات شراء',
    subtitle: 'إدارة وتعديل المرتجعات السابقة',
    href: '/purchases/edit-returns',
    icon: ClipboardList,
    color: 'bg-slate-500',
    shadow: 'shadow-slate-500/20'
  },
  {
    title: 'تقارير المشتريات',
    subtitle: 'تحليل المشتريات والمدفوعات',
    href: '/purchases/reports',
    icon: TrendingUp,
    color: 'bg-emerald-500',
    shadow: 'shadow-emerald-500/20'
  },
  {
    title: 'الموردين',
    subtitle: 'إدارة بيانات وأرصدة الموردين',
    href: '/purchases/suppliers',
    icon: Users,
    color: 'bg-blue-500',
    shadow: 'shadow-blue-500/20'
  }
];

export default function PurchasesPage() {
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadPage() {
      try {
        const localUser = await getClientSession();
        if (localUser) {
          setUser(localUser);
          const isAllowed = hasUserPermissionSync(localUser, 'can_view_purchases');
          if (isAllowed) {
            setAllowed(true);
          }
        }
      } catch (err) {
        console.error('Failed to load user session:', err);
      } finally {
        setLoading(false);
      }
    }
    loadPage();
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
    <div className="space-y-8 animate-in fade-in duration-500" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 flex justify-between items-center relative overflow-hidden">
        <div className="relative z-10">
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">إدارة المشتريات</h1>
          <p className="text-slate-500 font-bold mt-1">تسجيل الفواتير، المرتجعات، وإدارة حسابات الموردين</p>
        </div>
        <div className="absolute left-[-20px] top-[-20px] w-64 h-64 bg-primary-500/5 rounded-full blur-3xl" />
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {purchaseOptions.map((opt) => (
          <Link 
            key={opt.href}
            href={opt.href}
            className="group relative bg-white dark:bg-slate-900 p-8 rounded-[35px] border border-slate-100 dark:border-slate-800 shadow-soft hover:shadow-hard hover:scale-[1.02] transition-all duration-500 overflow-hidden"
          >
            <div className="relative z-10">
              <div className={cn(
                "w-16 h-16 rounded-2xl flex items-center justify-center text-white mb-6 group-hover:scale-110 transition-transform duration-500",
                opt.color,
                opt.shadow
              )}>
                <opt.icon className="w-8 h-8" />
              </div>
              
              <h3 className="text-xl font-black text-slate-900 dark:text-white group-hover:text-primary-600 transition-colors">
                {opt.title}
              </h3>
              <p className="text-slate-500 font-bold text-sm mt-2 leading-relaxed">
                {opt.subtitle}
              </p>

              <div className="mt-8 flex items-center gap-2 text-primary-600 dark:text-primary-400 font-black text-xs uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-all transform translate-x-2 group-hover:translate-x-0">
                فتح القسم
                <ArrowUpRight className="w-4 h-4" />
              </div>
            </div>

            {/* Decoration */}
            <div className="absolute right-[-10px] bottom-[-10px] w-32 h-32 bg-slate-50 dark:bg-slate-800/50 rounded-full group-hover:scale-150 transition-transform duration-700 opacity-50" />
          </Link>
        ))}
      </div>
    </div>
  );
}

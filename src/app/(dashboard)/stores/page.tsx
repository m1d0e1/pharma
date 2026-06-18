'use client';

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { 
  Package, 
  Box, 
  Trash2, 
  Layers, 
  Tags, 
  FlaskConical, 
  Scale, 
  Stethoscope, 
  FileText, 
  Activity, 
  ClipboardList,
  ChevronLeft
} from 'lucide-react'
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local'
import AccessDenied from '@/components/AccessDenied'

const inventoryActions = [
  {
    category: 'عامة',
    items: [
      { href: '/inventory', label: 'المخزون الحالي', icon: Package, description: 'عرض الرصيد الحالي وتواريخ الصلاحية' },
      { href: '/stores/opening-balances', label: 'الأرصدة الإفتتاحية', icon: ClipboardList, description: 'إدخال رصيد أول مدة للأصناف' },
      { href: '/stores/shortages', label: 'كشكول النواقص', icon: FileText, description: 'تسجيل ومتابعة الأصناف الناقصة' },
      { href: '/stores/delete-items', label: 'حذف الأصناف', icon: Trash2, description: 'حذف أصناف غير نشطة من النظام' },
    ]
  },
  {
    category: 'العمليات المخزنية',
    items: [
      { href: '/stores/adjustments', label: 'تسوية الكميات', icon: Activity, description: 'تعديل أرصدة الأصناف يدوياً' },
      { href: '/stores/alternatives', label: 'البدائل الدوائية', icon: Activity, description: 'ربط الأصناف ببدائلها الدوائية' },
      { href: '/stores/divisions', label: 'تقسيم المخازن', icon: Layers, description: 'إدارة أماكن التخزين والأرفف' },
    ]
  },
  {
    category: 'الأصناف والتصنيفات',
    items: [
      { href: '/stores/items', label: 'الأصناف', icon: Box, description: 'تعريف وتعديل بيانات الأدوية والمنتجات' },
      { href: '/stores/manufacturers', label: 'الشركات المنتجة', icon: FlaskConical, description: 'إدارة شركات تصنيع الأدوية' },
      { href: '/stores/categories', label: 'المجموعات', icon: Tags, description: 'تصنيف الأصناف لمجموعات تجارية' },
      { href: '/stores/scientific-groups', label: 'المجموعات العلمية', icon: FlaskConical, description: 'التصنيف العلمي للأدوية' },
    ]
  },
  {
    category: 'البيانات الطبية والتشغيلية',
    items: [
      { href: '/stores/units', label: 'الوحدات', icon: Scale, description: 'تعريف وحدات القياس (علبة، شريط، قرص)' },
      { href: '/stores/indications', label: 'دواعي الإستخدام', icon: Stethoscope, description: 'إدارة دواعي استعمال الأدوية' },
      { href: '/stores/nature', label: 'طبيعة الأصناف', icon: FileText, description: 'أدوية، مستلزمات، تجميل...' },
      { href: '/stores/usage', label: 'طرق الإستخدام', icon: Activity, description: 'طرق تناول الدواء (فم، حقن...)' },
      { href: '/stores/adjustment-reasons', label: 'أسباب التسوية', icon: ClipboardList, description: 'أسباب تعديل الرصيد يدوياً' },
    ]
  }
]

export default function InventoryDashboard() {
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function checkPermission() {
      try {
        const localUser = await getClientSession();
        if (localUser) {
          setUser(localUser);

          const isAllowed = hasUserPermissionSync(localUser, 'can_view_stores');

          if (isAllowed) {
            setAllowed(true);
          }
        }
      } catch (err) {
        console.error('Failed to load stores dashboard permission:', err);
      } finally {
        setLoading(false);
      }
    }

    checkPermission();
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
    <div className="space-y-12 animate-in slide-in-up" dir="rtl">
      <div className="bg-white dark:bg-slate-900 p-10 rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 relative overflow-hidden">
        <div className="relative z-10">
          <h1 className="text-4xl font-black text-slate-900 dark:text-white">إدارة المخازن والإعدادات</h1>
          <p className="text-slate-500 font-bold mt-2 text-lg">تحكم كامل في الأصناف، التصنيفات، والإعدادات الطبية للمخازن.</p>
        </div>
        <div className="absolute left-[-20px] top-[-20px] w-64 h-64 bg-primary-500/5 rounded-full blur-3xl" />
      </div>

      <div className="space-y-12">
        {inventoryActions.map((group, groupIdx) => (
          <div key={groupIdx} className="space-y-6">
            <h2 className="text-2xl font-black text-slate-800 dark:text-slate-200 mr-4 flex items-center gap-3">
              <div className="w-2 h-8 bg-primary-600 rounded-full" />
              {group.category}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {group.items.map((item, itemIdx) => {
                const Icon = item.icon;
                return (
                  <Link 
                    key={itemIdx} 
                    href={item.href}
                    className="group bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-soft hover:shadow-hard hover:border-primary-500/30 transition-all duration-300 flex flex-col gap-4 relative overflow-hidden"
                  >
                    <div className="w-14 h-14 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center group-hover:bg-primary-600 group-hover:text-white transition-all duration-300 shadow-inner">
                      <Icon className="w-7 h-7" />
                    </div>
                    <div>
                      <h3 className="font-black text-slate-900 dark:text-white text-lg group-hover:text-primary-600 transition-colors">{item.label}</h3>
                      <p className="text-slate-400 font-bold text-xs mt-1 leading-relaxed">{item.description}</p>
                    </div>
                    <ChevronLeft className="absolute left-6 bottom-6 w-5 h-5 text-slate-300 group-hover:text-primary-600 transition-all transform group-hover:-translate-x-1" />
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

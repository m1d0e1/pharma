'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { 
  Home, 
  Package, 
  Users, 
  Receipt, 
  BarChart3, 
  Settings,
  ShoppingCart,
  UserCog,
  Calendar,
  PlusCircle,
  RotateCcw,
  Wallet,
  AlertTriangle,
  Shield,
  Box,
  ArrowLeftRight,
  Bike,
  Edit3,
  Briefcase,
  Database,
  Activity,
  Landmark,
  CreditCard,
  Monitor,
  TrendingUp,
  ScrollText,
  FileText,
  UserCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  // Sales
  { category: 'المبيعات', href: '/pos', label: 'فاتورة مبيعات جديدة', icon: PlusCircle, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_access_pos' },
  { category: 'المبيعات', href: '/', label: 'لوحة التحكم', icon: Home, roles: ['owner', 'admin', 'pharmacist'] },
  { category: 'المبيعات', href: '/receipts', label: 'الفواتير', icon: FileText, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_receipts' },
  { category: 'المبيعات', href: '/sales', label: 'المبيعات والتحصيل', icon: ShoppingCart, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_sales' },
  { category: 'المبيعات', href: '/sales/delivery', label: 'توصيل منزلي', icon: Bike, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_delivery' },
  { category: 'المبيعات', href: '/sales/cogs', label: 'تعديل التكلفة', icon: Edit3, roles: ['owner'] },
  { category: 'المبيعات', href: '/returns', label: 'مرتجعات العملاء', icon: RotateCcw, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_returns' },

  // Inventory Ops
  { category: 'العمليات المخزنية', href: '/inventory', label: 'المخزون', icon: Package, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_stores' },
  { category: 'العمليات المخزنية', href: '/stores/shortages', label: 'كشكول النواقص', icon: AlertTriangle, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_restock' },
  { category: 'العمليات المخزنية', href: '/inventory/item-movements', label: 'حركات الأصناف', icon: Activity, roles: ['owner', 'admin', 'pharmacist'], permission: 'preview_item_movements' },
  { category: 'العمليات المخزنية', href: '/restock', label: 'إعادة التموين', icon: Package, roles: ['owner', 'admin'], permission: 'can_view_restock' },
  { category: 'العمليات المخزنية', href: '/inventory/opening-balances', label: 'الأرصدة الإفتتاحية', icon: Database, roles: ['owner', 'admin'], permission: 'can_view_opening_balances' },
  { category: 'العمليات المخزنية', href: '/inventory/settlement', label: 'تسوية المخزون', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_settlement' },

  // Purchases
  { category: 'المشتريات', href: '/purchases', label: 'المشتريات', icon: ShoppingCart, roles: ['owner', 'admin'], permission: 'can_view_purchases' },

  // Master Data
  { category: 'البيانات الأساسية', href: '/stores/items', label: 'إدارة المخازن', icon: Box, roles: ['owner', 'admin'], permission: 'can_view_stores' },

  // Finance
  { category: 'المالية', href: '/accounts', label: 'الحسابات والمالية', icon: Wallet, roles: ['owner', 'admin'], permission: 'acc_can_view_general' },
  { category: 'المالية', href: '/accounts/cash-transactions', label: 'حركة النقدية', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'acc_can_process_cash_flow' },
  { category: 'المالية', href: '/shifts', label: 'الورديات النقدية', icon: Calendar, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_shifts' },
  { category: 'المالية', href: '/finance/handover', label: 'تسليم الدرج', icon: UserCheck, roles: ['owner', 'admin', 'pharmacist'], permission: 'acc_can_view_handover' },
  { category: 'المالية', href: '/finance/banks', label: 'البنوك', icon: Landmark, roles: ['owner', 'admin'], permission: 'acc_can_view_bank_accounts' },
  { category: 'المالية', href: '/finance/cards', label: 'البطاقات', icon: CreditCard, roles: ['owner', 'admin'], permission: 'acc_can_collect_credit_cards' },
  { category: 'المالية', href: '/finance/pos-management', label: 'نقاط البيع', icon: Monitor, roles: ['owner', 'admin'], permission: 'acc_can_view_pos' },
  { category: 'المالية', href: '/finance/accounts', label: 'شجرة الحسابات', icon: Database, roles: ['owner', 'admin'], permission: 'acc_can_view_general' },
  { category: 'المالية', href: '/accounts/settings/trial-balance', label: 'ميزان المراجعة', icon: Settings, roles: ['owner', 'admin'], permission: 'acc_can_view_general' },

  // Reports
  { category: 'التقارير', href: '/reports', label: 'لوحة التقارير', icon: BarChart3, roles: ['owner', 'admin'], permission: 'rep_can_view_sales' },
  { category: 'التقارير', href: '/reports/sales', label: 'تقارير المبيعات', icon: TrendingUp, roles: ['owner', 'admin'], permission: 'rep_can_view_sales' },
  { category: 'التقارير', href: '/reports/purchases', label: 'تقارير المشتريات', icon: ScrollText, roles: ['owner', 'admin'], permission: 'rep_can_view_purchases' },
  { category: 'التقارير', href: '/reports/trial-balance', label: 'ميزان المراجعة', icon: Database, roles: ['owner', 'admin'], permission: 'acc_can_view_reports' },
  { category: 'التقارير', href: '/expenses', label: 'المصروفات', icon: Receipt, roles: ['owner', 'admin'], permission: 'can_view_expenses' },

  // Patients
  { category: 'المرضى والطبية', href: '/patients', label: 'المرضى', icon: Users, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_patients' },

  // Administration
  { category: 'الإدارة', href: '/staff', label: 'أداء الموظفين', icon: UserCheck, roles: ['owner', 'admin'], permission: 'rep_can_view_activity' },
  { category: 'الإدارة', href: '/staff/manage', label: 'إدارة الموظفين', icon: UserCog, roles: ['owner', 'admin'], permission: 'can_view_staff_manage' },
  { category: 'الإدارة', href: '/staff/roles', label: 'الوظائف والرواتب', icon: Briefcase, roles: ['owner', 'admin'], permission: 'can_view_staff_roles' },
  { category: 'الإدارة', href: '/audit', label: 'سجل المراقبة', icon: Shield, roles: ['owner'], permission: 'can_view_audit' },
  { category: 'الإدارة', href: '/settings', label: 'الإعدادات', icon: Settings, roles: ['owner', 'admin'], permission: 'can_view_settings' },
]

const highPriorityRoutes = new Set(['/', '/inventory', '/sales', '/accounts', '/pos']);

interface Props {
  userRole: string
  userPermissions?: any
}

import { useState, useEffect, useRef } from 'react'
import { hasUserPermissionSync } from '@/lib/auth/local'

export default function SidebarNav({ userRole, userPermissions }: Props) {
  const pathname = usePathname()
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [permissions, setPermissions] = useState<any>(null)
  const [showMobileMore, setShowMobileMore] = useState(false)
  const permissionsRequestRef = useRef(0)

  useEffect(() => {
    setMounted(true)
    const requestId = ++permissionsRequestRef.current
    async function refreshPermissions() {
      try {
        const { getClientSession } = await import('@/lib/auth/local')
        const userObj = await getClientSession()
        if (requestId === permissionsRequestRef.current && userObj && userObj.permissions) {
          const parsed = typeof userObj.permissions === 'string' ? JSON.parse(userObj.permissions) : userObj.permissions
          setPermissions(parsed)
        }
      } catch (e) {
        console.error('Failed to dynamic check session in sidebar:', e)
      }
    }
    if (!userPermissions) refreshPermissions()
    return () => {
      if (permissionsRequestRef.current === requestId) permissionsRequestRef.current += 1
    }
  }, [pathname, userPermissions])

  const effectivePermissions = userPermissions ?? permissions ?? {}
  const userObj = { role: userRole, permissions: effectivePermissions }

  const filteredItems = navItems.filter(item => {
    if (item.permission) {
      if (userRole === 'owner') return true;
      return hasUserPermissionSync(userObj, item.permission);
    }
    return item.roles.includes(userRole);
  });

  const mobileRouteOrder = ['/', '/sales', '/inventory', '/inventory/low-stock', '/patients'];
  const mobileNavItems = [
    ...mobileRouteOrder
      .map(href => filteredItems.find(item => item.href === href))
      .filter((item): item is typeof navItems[number] => !!item),
    ...filteredItems
  ].filter((item, index, self) => self.findIndex(t => t.href === item.href) === index)
   .slice(0, 5);
  const mobileNavHrefs = new Set(mobileNavItems.map(item => item.href));
  const mobileMoreItems = filteredItems.filter(item => !mobileNavHrefs.has(item.href));

  return (
    <>
      {/* Desktop Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto hidden lg:block">
        {(() => {
          const grouped = filteredItems.reduce((acc, item) => {
            const cat = item.category || 'أخرى';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(item);
            return acc;
          }, {} as Record<string, typeof filteredItems>);
          
          return Object.entries(grouped).map(([category, items]) => (
            <div key={category} className="space-y-1">
              <h3 className="px-3 mb-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">{category}</h3>
              {items.map((item) => {
                const Icon = item.icon
                const isActive = pathname === item.href || 
                                 (item.href !== '/' && pathname?.startsWith(item.href))
                const isHighPriority = highPriorityRoutes.has(item.href)
                
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={isHighPriority ? true : undefined}
                    onMouseEnter={!isHighPriority ? () => router.prefetch(item.href) : undefined}
                    aria-label={item.label}
                    className={cn(
                      "flex min-h-11 items-center gap-3 px-3 py-2.5 rounded-lg transition-colors duration-150 group border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-950",
                      isActive 
                        ? "bg-primary-50 text-primary-700 border-primary-100 dark:bg-primary-950/40 dark:text-primary-300 dark:border-primary-900/60"
                        : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-950 dark:hover:text-white"
                    )}
                  >
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
                      isActive
                        ? "bg-primary-100 dark:bg-primary-900/50"
                        : "bg-slate-100 dark:bg-slate-800 group-hover:bg-slate-200 dark:group-hover:bg-slate-700"
                    )}>
                      <Icon className={cn(
                        "w-4 h-4 transition-colors",
                        isActive ? "text-primary-700 dark:text-primary-300" : "text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200"
                      )} />
                    </div>
                    <span className="font-medium text-sm leading-5">{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ));
        })()}
      </nav>

      {/* Mobile Bottom Navigation */}
      {mounted && createPortal(<nav aria-label="التنقل الرئيسي للجوال" className="lg:hidden fixed bottom-0 left-0 right-0 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 z-40 shadow-[0_-8px_24px_-20px_rgba(15,23,42,0.45)] pb-[env(safe-area-inset-bottom)]">
        <div className="flex justify-around px-2 py-2">
          {mobileNavItems.map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.href || 
                               (item.href !== '/' && pathname?.startsWith(item.href))
              const isHighPriority = highPriorityRoutes.has(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={isHighPriority ? true : undefined}
                  onMouseEnter={!isHighPriority ? () => router.prefetch(item.href) : undefined}
                  aria-label={item.label}
                  className={cn(
                    "flex min-h-12 min-w-12 flex-col items-center justify-center px-2 py-1.5 rounded-lg transition-colors duration-150 group",
                    isActive ? "text-primary-700 dark:text-primary-300" : "text-slate-600 dark:text-slate-400"
                  )}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
                    isActive 
                      ? "bg-primary-100 dark:bg-primary-900/30" 
                      : "bg-transparent"
                  )}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className="text-[11px] mt-0.5 font-medium max-w-20 truncate">{item.label}</span>
                </Link>
              )
            })}
          {mobileMoreItems.length > 0 && (
            <button
              type="button"
              onClick={() => setShowMobileMore(v => !v)}
              className="flex min-h-12 min-w-12 flex-col items-center justify-center px-2 py-1.5 rounded-lg text-slate-600 dark:text-slate-400 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="المزيد من الخيارات"
              aria-expanded={showMobileMore}
            >
              <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <span className="text-xs font-black">+{mobileMoreItems.length}</span>
              </div>
              <span className="text-[11px] mt-0.5 font-medium">المزيد</span>
            </button>
          )}
        </div>
        {showMobileMore && mobileMoreItems.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-2 max-h-[60vh] overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-2">
            {mobileMoreItems.map(item => {
              const Icon = item.icon
              return (
                <Link key={`more-${item.href}`} href={item.href} onClick={() => setShowMobileMore(false)} className="flex min-h-11 items-center gap-3 p-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Icon className="w-4 h-4" />
                  <span className="text-sm font-medium">{item.label}</span>
                </Link>
              )
            })}
          </div>
        )}
      </nav>, document.body)}
    </>
  )
}

'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
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
  { category: 'المبيعات', href: '/', label: 'لوحة التحكم', icon: Home, roles: ['owner', 'admin', 'pharmacist'] },
  { category: 'المبيعات', href: '/receipts', label: 'الفواتير', icon: FileText, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_receipts' },
  { category: 'المبيعات', href: '/sales', label: 'المبيعات والتحصيل', icon: ShoppingCart, roles: ['owner', 'admin', 'pharmacist'] },
  { category: 'المبيعات', href: '/sales/delivery', label: 'توصيل منزلي', icon: Bike, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_delivery' },
  { category: 'المبيعات', href: '/sales/cogs', label: 'تعديل التكلفة', icon: Edit3, roles: ['owner', 'admin'], permission: 'can_view_cogs' },
  { category: 'المبيعات', href: '/sales/settlement', label: 'تسوية المبيعات', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_settlement' },
  { category: 'المبيعات', href: '/returns', label: 'مرتجعات العملاء', icon: RotateCcw, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_returns' },

  // Inventory Ops
  { category: 'العمليات المخزنية', href: '/inventory', label: 'المخزون', icon: Package, roles: ['owner', 'admin', 'pharmacist'] },
  { category: 'العمليات المخزنية', href: '/stores/shortages', label: 'كشكول النواقص', icon: AlertTriangle, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_shortages' },
  { category: 'العمليات المخزنية', href: '/inventory/item-movements', label: 'حركات الأصناف', icon: Activity, roles: ['owner', 'admin', 'pharmacist'], permission: 'manage_inventory' },
  { category: 'العمليات المخزنية', href: '/restock', label: 'إعادة التموين', icon: Package, roles: ['owner', 'admin'], permission: 'can_view_restock' },
  { category: 'العمليات المخزنية', href: '/inventory/opening-balances', label: 'الأرصدة الإفتتاحية', icon: Database, roles: ['owner', 'admin'], permission: 'can_view_opening_balances' },
  { category: 'العمليات المخزنية', href: '/inventory/settlement', label: 'تسوية المخزون', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_settlement' },

  // Purchases
  { category: 'المشتريات', href: '/purchases', label: 'المشتريات', icon: ShoppingCart, roles: ['owner', 'admin'], permission: 'can_view_purchases' },

  // Master Data
  { category: 'البيانات الأساسية', href: '/stores/items', label: 'إدارة المخازن', icon: Box, roles: ['owner', 'admin'], permission: 'can_manage_inventory' },

  // Finance
  { category: 'المالية', href: '/accounts', label: 'الحسابات والمالية', icon: Wallet, roles: ['owner', 'admin'], permission: 'rep_can_view_financial' },
  { category: 'المالية', href: '/accounts/cash-transactions', label: 'حركة النقدية', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_cash_transactions' },
  { category: 'المالية', href: '/finance/handover', label: 'تسليم الدرج', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'acc_can_view_handover' },
  { category: 'المالية', href: '/finance/banks', label: 'البنوك', icon: Landmark, roles: ['owner', 'admin'], permission: 'can_view_banks' },
  { category: 'المالية', href: '/finance/cards', label: 'البطاقات', icon: CreditCard, roles: ['owner', 'admin'], permission: 'can_view_cards' },
  { category: 'المالية', href: '/finance/pos-management', label: 'نقاط البيع', icon: Monitor, roles: ['owner', 'admin'], permission: 'can_view_pos_management' },
  { category: 'المالية', href: '/finance/accounts', label: 'شجرة الحسابات', icon: Database, roles: ['owner', 'admin'], permission: 'can_view_accounts_tree' },
  { category: 'المالية', href: '/accounts/settings/trial-balance', label: 'ميزان المراجعة', icon: Settings, roles: ['owner', 'admin'], permission: 'can_view_trial_balance' },

  // Reports
  { category: 'التقارير', href: '/reports', label: 'لوحة التقارير', icon: BarChart3, roles: ['owner', 'admin'], permission: 'can_view_reports_dashboard' },
  { category: 'التقارير', href: '/reports/sales', label: 'تقارير المبيعات', icon: TrendingUp, roles: ['owner', 'admin'], permission: 'rep_can_view_sales' },
  { category: 'التقارير', href: '/reports/purchases', label: 'تقارير المشتريات', icon: ScrollText, roles: ['owner', 'admin'], permission: 'can_view_purchase_reports' },
  { category: 'التقارير', href: '/reports/trial-balance', label: 'ميزان المراجعة', icon: Database, roles: ['owner', 'admin'], permission: 'can_view_trial_balance_report' },
  { category: 'التقارير', href: '/expenses', label: 'المصروفات', icon: Receipt, roles: ['owner', 'admin'], permission: 'can_view_expenses' },
  { category: 'التقارير', href: '/shifts', label: 'الشفتات النقدية', icon: Calendar, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_shifts' },

  // Patients
  { category: 'المرضى والطبية', href: '/patients', label: 'المرضى', icon: Users, roles: ['owner', 'admin', 'pharmacist'], permission: 'can_view_patients' },

  // Administration
  { category: 'الإدارة', href: '/staff', label: 'أداء الموظفين', icon: UserCheck, roles: ['owner', 'admin'], permission: 'can_view_staff_performance' },
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

import { useState, useEffect } from 'react'
import { hasUserPermissionSync } from '@/lib/auth/local'

export default function SidebarNav({ userRole, userPermissions }: Props) {
  const pathname = usePathname()
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [permissions, setPermissions] = useState<any>(null)

  useEffect(() => {
    setMounted(true)
    async function refreshPermissions() {
      try {
        const { getClientSession } = await import('@/lib/auth/local')
        const userObj = await getClientSession()
        if (userObj && userObj.permissions) {
          const parsed = typeof userObj.permissions === 'string' ? JSON.parse(userObj.permissions) : userObj.permissions
          setPermissions(parsed)
        }
      } catch (e) {
        console.error('Failed to dynamic check session in sidebar:', e)
      }
    }
    if (!userPermissions) refreshPermissions()
  }, [pathname, userPermissions])

  const userObj = { role: userRole, permissions: userPermissions ? JSON.stringify(userPermissions) : '{}' }

  const filteredItems = navItems.filter(item => {
    if (!item.roles.includes(userRole)) return false;
    if (item.permission) {
      if (userRole === 'owner' || userRole === 'admin') return true;
      return hasUserPermissionSync(userObj, item.permission);
    }
    return true;
  });

  return (
    <>
      {/* Desktop Navigation */}
      <nav className="flex-1 p-5 space-y-6 overflow-y-auto hidden lg:block">
        {(() => {
          const grouped = filteredItems.reduce((acc, item) => {
            const cat = item.category || 'أخرى';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(item);
            return acc;
          }, {} as Record<string, typeof filteredItems>);
          
          return Object.entries(grouped).map(([category, items]) => (
            <div key={category} className="space-y-2">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest px-4 mb-2">{category}</h3>
              {items.map((item) => {
                const Icon = item.icon
                const isActive = pathname === item.href || 
                                 (item.href !== '/' && pathname?.startsWith(item.href)) ||
                                 (item.href === '/sales' && pathname?.startsWith('/pos'))
                const isHighPriority = highPriorityRoutes.has(item.href)
                
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={isHighPriority ? true : undefined}
                    onMouseEnter={!isHighPriority ? () => router.prefetch(item.href) : undefined}
                    aria-label={item.label}
                    className={cn(
                      "flex items-center gap-4 px-5 py-4 rounded-2xl transition-all duration-300 group border border-transparent",
                      isActive 
                        ? "bg-gradient-primary text-white shadow-lg shadow-primary-500/30 border-transparent" 
                        : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-primary-700 dark:hover:text-primary-400"
                    )}
                  >
                    <div className={cn(
                      "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
                      isActive
                        ? "bg-white/20"
                        : "bg-slate-100 dark:bg-slate-800 group-hover:bg-primary-100 dark:group-hover:bg-primary-900/30"
                    )}>
                      <Icon className={cn(
                        "w-5 h-5 transition-all",
                        isActive ? "text-white" : "opacity-80 group-hover:opacity-100 group-hover:text-primary-600 dark:group-hover:text-primary-400"
                      )} />
                    </div>
                    <span className="font-bold text-base">{item.label}</span>
                    <div className="flex-1" />
                    {!isActive && (
                      <div className="w-1.5 h-1.5 bg-primary-500 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </Link>
                )
              })}
            </div>
          ));
        })()}
      </nav>

      {/* Mobile Bottom Navigation */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-gradient-glass dark:bg-gradient-glass-dark backdrop-blur-xl border-t border-slate-200/60 dark:border-slate-800/60 z-40 shadow-hard">
        <div className="flex justify-around p-3">
          {(() => {
            const mobileRouteOrder = ['/', '/sales', '/inventory', '/inventory/low-stock', '/patients'];
            const mobileNavItems = [
              ...mobileRouteOrder
                .map(href => filteredItems.find(item => item.href === href))
                .filter((item): item is typeof navItems[number] => !!item),
              ...filteredItems
            ].filter((item, index, self) => self.findIndex(t => t.href === item.href) === index)
             .slice(0, 5);
            
            return mobileNavItems.map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.href || 
                               (item.href !== '/' && pathname?.startsWith(item.href)) ||
                               (item.href === '/sales' && pathname?.startsWith('/pos'))
              const isHighPriority = highPriorityRoutes.has(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={isHighPriority ? true : undefined}
                  onMouseEnter={!isHighPriority ? () => router.prefetch(item.href) : undefined}
                  aria-label={item.label}
                  className={cn(
                    "flex flex-col items-center p-3 rounded-2xl transition-all duration-300 active:scale-95 group",
                    isActive ? "text-primary-600 dark:text-primary-400" : "text-slate-600 dark:text-slate-400"
                  )}
                >
                  <div className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
                    isActive 
                      ? "bg-primary-100 dark:bg-primary-900/30" 
                      : "bg-slate-100 dark:bg-slate-800"
                  )}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className="text-[10px] mt-1.5 font-bold">{item.label}</span>
                </Link>
              )
            })
          })()}
          {filteredItems.length > 5 && (
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="flex flex-col items-center p-3 rounded-2xl text-slate-600 dark:text-slate-400"
              aria-label="المزيد من الخيارات"
            >
              <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <span className="text-xs font-black">+{filteredItems.length - 5}</span>
              </div>
              <span className="text-[10px] mt-1.5 font-bold">المزيد</span>
            </button>
          )}
        </div>
      </div>
    </>
  )
}

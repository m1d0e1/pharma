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
} from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  // المبيعات (Sales)
  { category: 'المبيعات', href: '/', label: 'لوحة التحكم', icon: Home, roles: ['owner', 'admin', 'pharmacist'] },
  { category: 'المبيعات', href: '/receipts', label: 'الفواتير', icon: Receipt, roles: ['owner', 'admin', 'pharmacist'], permission: 'view_all_sales' },
  { category: 'المبيعات', href: '/sales', label: 'المبيعات والتحصيل', icon: ShoppingCart, roles: ['owner', 'admin', 'pharmacist'] },
  { category: 'المبيعات', href: '/sales/delivery', label: 'توصيل منزلي', icon: Bike, roles: ['owner', 'admin', 'pharmacist'], permission: 'process_sales' },
  { category: 'المبيعات', href: '/sales/cogs', label: 'تعديل التكلفة', icon: Edit3, roles: ['owner', 'admin'], permission: 'manage_settings' },
  { category: 'المبيعات', href: '/sales/settlement', label: 'تسوية المبيعات', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'manage_inventory' },
  { category: 'المبيعات', href: '/returns', label: 'مرتجعات العملاء', icon: RotateCcw, roles: ['owner', 'admin', 'pharmacist'], permission: 'process_sales' },

  // العمليات المخزنية (Inventory Ops)
  { category: 'العمليات المخزنية', href: '/inventory', label: 'المخزون', icon: Package, roles: ['owner', 'admin', 'pharmacist'] },
  { category: 'العمليات المخزنية', href: '/stores/shortages', label: 'كشكول النواقص', icon: AlertTriangle, roles: ['owner', 'admin', 'pharmacist'], permission: 'manage_inventory' },
  { category: 'العمليات المخزنية', href: '/inventory/item-movements', label: 'حركات الأصناف', icon: Activity, roles: ['owner', 'admin', 'pharmacist'], permission: 'manage_inventory' },
  { category: 'العمليات المخزنية', href: '/restock', label: 'إعادة التموين', icon: Package, roles: ['owner', 'admin'], permission: 'manage_inventory' },
  { category: 'العمليات المخزنية', href: '/inventory/opening-balances', label: 'الأرصدة الإفتتاحية', icon: Database, roles: ['owner', 'admin'], permission: 'manage_inventory' },
  { category: 'العمليات المخزنية', href: '/inventory/settlement', label: 'تسوية المخزون', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'manage_inventory' },

  // المشتريات (Purchases)
  { category: 'المشتريات', href: '/purchases', label: 'المشتريات', icon: ShoppingCart, roles: ['owner', 'admin'], permission: 'manage_inventory' },
  
  // البيانات الأساسية (Master Data)
  { category: 'البيانات الأساسية', href: '/stores', label: 'إدارة المخازن', icon: Box, roles: ['owner', 'admin'], permission: 'manage_inventory' },

  // المالية (Finance)
  { category: 'المالية', href: '/accounts', label: 'الحسابات والمالية', icon: Wallet, roles: ['owner', 'admin'], permission: 'view_dashboard' },
  { category: 'المالية', href: '/accounts/cash-transactions', label: 'حركة النقدية', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'process_sales' },
  { category: 'المالية', href: '/finance/handover', label: 'تسليم الدرج', icon: ArrowLeftRight, roles: ['owner', 'admin', 'pharmacist'], permission: 'manage_shifts' },
  { category: 'المالية', href: '/finance/banks', label: 'البنوك', icon: Landmark, roles: ['owner', 'admin'], permission: 'manage_settings' },
  { category: 'المالية', href: '/finance/cards', label: 'البطاقات', icon: CreditCard, roles: ['owner', 'admin'], permission: 'process_sales' },
  { category: 'المالية', href: '/finance/pos-management', label: 'نقاط البيع', icon: Monitor, roles: ['owner', 'admin'], permission: 'process_sales' },
  { category: 'المالية', href: '/finance/accounts', label: 'شجرة الحسابات', icon: Database, roles: ['owner', 'admin'], permission: 'manage_settings' },
  { category: 'المالية', href: '/accounts/settings/trial-balance', label: 'ميزان المراجعة', icon: Settings, roles: ['owner', 'admin'], permission: 'manage_settings' },

  // التقارير (Reports)
  { category: 'التقارير', href: '/reports', label: 'لوحة التقارير', icon: BarChart3, roles: ['owner', 'admin'], permission: 'view_reports' },
  { category: 'التقارير', href: '/reports/sales', label: 'تقارير المبيعات', icon: BarChart3, roles: ['owner', 'admin'], permission: 'view_reports' },
  { category: 'التقارير', href: '/reports/purchases', label: 'تقارير المشتريات', icon: BarChart3, roles: ['owner', 'admin'], permission: 'view_reports' },
  { category: 'التقارير', href: '/reports/trial-balance', label: 'ميزان المراجعة', icon: BarChart3, roles: ['owner', 'admin'], permission: 'view_reports' },
  { category: 'التقارير', href: '/expenses', label: 'المصروفات', icon: Receipt, roles: ['owner', 'admin'], permission: 'process_sales' },
  { category: 'التقارير', href: '/shifts', label: 'الشفتات النقدية', icon: Calendar, roles: ['owner', 'admin', 'pharmacist'], permission: 'manage_shifts' },

  // المرضى والطبية (Patients)
  { category: 'المرضى والطبية', href: '/patients', label: 'المرضى', icon: Users, roles: ['owner', 'admin', 'pharmacist'], permission: 'manage_patients' },

  // الإدارة (Administration)
  { category: 'الإدارة', href: '/staff', label: 'أداء الموظفين', icon: BarChart3, roles: ['owner', 'admin'], permission: 'manage_staff' },
  { category: 'الإدارة', href: '/staff/manage', label: 'إدارة الموظفين', icon: UserCog, roles: ['owner', 'admin'] },
  { category: 'الإدارة', href: '/staff/roles', label: 'الوظائف والرواتب', icon: Briefcase, roles: ['owner', 'admin'] },
  { category: 'الإدارة', href: '/audit', label: 'سجل المراقبة', icon: Shield, roles: ['owner'], permission: 'view_audit_logs' },
  { category: 'الإدارة', href: '/settings', label: 'الإعدادات', icon: Settings, roles: ['owner', 'admin'], permission: 'manage_settings' },
]

const highPriorityRoutes = new Set(['/', '/inventory', '/sales', '/accounts', '/pos']);

interface Props {
  userRole: string
}

import { useState, useEffect } from 'react'

export default function SidebarNav({ userRole }: Props) {
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
    refreshPermissions()
  }, [pathname])

  const filteredItems = navItems.filter(item => {
    // Role check first
    if (!item.roles.includes(userRole)) return false;

    // If it requires a specific permission, and we are mounted with permissions loaded, check it
    if (item.permission) {
      if (userRole === 'owner' || userRole === 'admin') return true
      if (Array.isArray(permissions)) {
        return permissions.includes(item.permission)
      }
      return permissions ? !!permissions[item.permission] : false
    }

    return true;
  })

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
                    prefetch={isHighPriority ? true : false}
                    onMouseEnter={!isHighPriority ? () => router.prefetch(item.href) : undefined}
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
                  prefetch={isHighPriority ? true : false}
                  onMouseEnter={!isHighPriority ? () => router.prefetch(item.href) : undefined}
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
        </div>
      </div>
    </>
  )
}

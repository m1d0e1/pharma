'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Monitor, Package, ShoppingCart, RotateCcw, Box, Wallet,
  BarChart3, Users, UserCog, Settings,
  FileText, Home, Receipt, Bike, Edit3, ArrowLeftRight,
  AlertTriangle, Activity, Calendar, Landmark, CreditCard,
  Briefcase, Shield, Database, FlaskConical, X,
  Printer, LogOut, Keyboard, Info, TrendingUp,
  PlusCircle, Truck, RefreshCw, ClipboardList, Building2,
  Layers, Tag, Beaker, Wrench, Trash2, GitBranch,
  DollarSign, Handshake, TreePine,
  PieChart, Stethoscope, Pill
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { logoutLocal } from '@/lib/auth/local'

// ─── Types ───────────────────────────────────────────────────────────────────

type MenuItem =
  | { type: 'link';      label: string; href: string;   icon: any; permission?: string; roles?: string[] }
  | { type: 'action';    label: string; action: string; icon: any }
  | { type: 'separator' }

interface Menu {
  id: string
  label: string
  ownerRoutes: string[]
  items: MenuItem[]
}

// ─── Menu Definitions ─────────────────────────────────────────────────────────

const MENUS: Menu[] = [
  {
    id: 'file', label: 'ملف', ownerRoutes: [],
    items: [
      { type: 'link',   label: 'فاتورة مبيعات جديدة',  href: '/pos',           icon: PlusCircle },
      { type: 'link',   label: 'فاتورة مشتريات جديدة', href: '/purchases/new', icon: PlusCircle },
      { type: 'separator' },
      { type: 'action', label: 'طباعة',                 action: 'print',        icon: Printer },
      { type: 'separator' },
      { type: 'action', label: 'تسجيل الخروج',          action: 'logout',       icon: LogOut },
    ],
  },
  {
    id: 'dashboard', label: 'لوحة التحكم',
    ownerRoutes: ['/', '/receipts', '/sales', '/reports/sales', '/sales/delivery', '/sales/cogs', '/sales/settlement'],
    items: [
      { type: 'link', label: 'لوحة التحكم',       href: '/',                 icon: Home,           roles: ['owner','admin','pharmacist'] },
      { type: 'link', label: 'الفواتير',          href: '/receipts',         icon: Receipt,        roles: ['owner','admin','pharmacist'], permission: 'view_all_sales' },
      { type: 'link', label: 'المبيعات والتحصيل', href: '/sales',            icon: ShoppingCart,   roles: ['owner','admin','pharmacist'] },
      { type: 'separator' },
      { type: 'link', label: 'تقارير المبيعات',   href: '/reports/sales',    icon: BarChart3,      roles: ['owner','admin'], permission: 'view_reports' },
      { type: 'link', label: 'توصيل منزلي',       href: '/sales/delivery',   icon: Bike,           roles: ['owner','admin','pharmacist'], permission: 'process_sales' },
      { type: 'link', label: 'تعديل التكلفة',     href: '/sales/cogs',       icon: Edit3,          roles: ['owner','admin'], permission: 'manage_settings' },
      { type: 'link', label: 'تسوية المبيعات',    href: '/sales/settlement',  icon: ArrowLeftRight, roles: ['owner','admin','pharmacist'] },
    ],
  },
  {
    id: 'inventory', label: 'المخزون',
    ownerRoutes: ['/inventory','/inventory/low-stock','/inventory/item-movements','/restock','/inventory/settlement','/inventory/opening-balances'],
    items: [
      { type: 'link', label: 'المخزون',             href: '/inventory',                  icon: Package,        roles: ['owner','admin','pharmacist'] },
      { type: 'link', label: 'النواقص',             href: '/inventory/low-stock',        icon: AlertTriangle,  roles: ['owner','admin','pharmacist'], permission: 'manage_inventory' },
      { type: 'link', label: 'حركات الأصناف',       href: '/inventory/item-movements',   icon: Activity,       roles: ['owner','admin','pharmacist'], permission: 'manage_inventory' },
      { type: 'separator' },
      { type: 'link', label: 'إعادة التموين',       href: '/restock',                    icon: RefreshCw,      roles: ['owner','admin'], permission: 'manage_inventory' },
      { type: 'link', label: 'تسوية المخزون',       href: '/inventory/settlement',       icon: ArrowLeftRight, roles: ['owner','admin','pharmacist'], permission: 'manage_inventory' },
      { type: 'link', label: 'الأرصدة الإفتتاحية', href: '/inventory/opening-balances', icon: Database,       roles: ['owner','admin'], permission: 'manage_inventory' },
    ],
  },
  {
    id: 'purchases', label: 'المشتريات',
    ownerRoutes: ['/purchases','/purchases/new','/purchase-orders','/purchases/suppliers','/purchases/returns','/purchases/general-returns','/returns'],
    items: [
      { type: 'link', label: 'المشتريات',              href: '/purchases',                 icon: ShoppingCart,  roles: ['owner','admin'], permission: 'manage_inventory' },
      { type: 'link', label: 'فاتورة مشتريات جديدة',  href: '/purchases/new',             icon: PlusCircle,    roles: ['owner','admin'], permission: 'manage_inventory' },
      { type: 'link', label: 'أوامر الشراء',           href: '/purchase-orders',           icon: ClipboardList, roles: ['owner','admin'] },
      { type: 'link', label: 'الموردون',               href: '/purchases/suppliers',       icon: Truck,         roles: ['owner','admin'], permission: 'manage_inventory' },
      { type: 'separator' },
      { type: 'link', label: 'مرتجعات للموردين',      href: '/purchases/returns',         icon: RotateCcw,     roles: ['owner','admin'], permission: 'process_sales' },
      { type: 'link', label: 'مرتجعات عامة',          href: '/purchases/general-returns', icon: RotateCcw,     roles: ['owner','admin'], permission: 'process_sales' },
      { type: 'link', label: 'مرتجعات العملاء',       href: '/returns',                   icon: RotateCcw,     roles: ['owner','admin','pharmacist'], permission: 'process_sales' },
    ],
  },
  {
    id: 'stores', label: 'المخازن',
    ownerRoutes: ['/stores','/stores/items','/stores/alternatives','/stores/categories','/stores/nature','/stores/usage','/stores/units','/stores/indications','/stores/drug-indications','/stores/manufacturers','/stores/scientific-groups','/stores/adjustments','/stores/adjustment-reasons','/stores/shortages','/stores/delete-items'],
    items: [
      { type: 'link', label: 'المخازن',             href: '/stores',                     icon: Box,           roles: ['owner','admin'], permission: 'manage_inventory' },
      { type: 'link', label: 'الأصناف',             href: '/stores/items',               icon: Layers,        roles: ['owner','admin'] },
      { type: 'link', label: 'البدائل',             href: '/stores/alternatives',        icon: GitBranch,     roles: ['owner','admin'] },
      { type: 'separator' },
      { type: 'link', label: 'التصنيفات',           href: '/stores/categories',          icon: Tag,           roles: ['owner','admin'] },
      { type: 'link', label: 'النوع',               href: '/stores/nature',              icon: Beaker,        roles: ['owner','admin'] },
      { type: 'link', label: 'الاستخدام',           href: '/stores/usage',               icon: Stethoscope,   roles: ['owner','admin'] },
      { type: 'link', label: 'الوحدات',             href: '/stores/units',               icon: Package,       roles: ['owner','admin'] },
      { type: 'link', label: 'الإشارات',            href: '/stores/indications',         icon: Pill,          roles: ['owner','admin'] },
      { type: 'link', label: 'الأدوية والإشارات',  href: '/stores/drug-indications',    icon: FlaskConical,  roles: ['owner','admin'] },
      { type: 'link', label: 'الشركات المنتجة',    href: '/stores/manufacturers',       icon: Building2,     roles: ['owner','admin'] },
      { type: 'link', label: 'المجموعات العلمية',  href: '/stores/scientific-groups',   icon: FlaskConical,  roles: ['owner','admin'] },
      { type: 'separator' },
      { type: 'link', label: 'التعديلات',           href: '/stores/adjustments',         icon: Wrench,        roles: ['owner','admin'] },
      { type: 'link', label: 'أسباب التعديل',       href: '/stores/adjustment-reasons',  icon: FileText,      roles: ['owner','admin'] },
      { type: 'link', label: 'نقص المخزون',         href: '/stores/shortages',           icon: AlertTriangle, roles: ['owner','admin'] },
      { type: 'link', label: 'حذف الأصناف',         href: '/stores/delete-items',        icon: Trash2,        roles: ['owner','admin'] },
      { type: 'link', label: 'الأرصدة الإفتتاحية', href: '/inventory/opening-balances',    icon: Database,      roles: ['owner','admin'] },
    ],
  },
  {
    id: 'finance', label: 'المالية',
    ownerRoutes: ['/accounts','/accounts/cash-transactions','/finance/handover','/finance/banks','/finance/cards','/finance/pos-management','/finance/accounts','/accounts/settings/trial-balance'],
    items: [
      { type: 'link', label: 'الحسابات والمالية',       href: '/accounts',                        icon: Wallet,     roles: ['owner','admin'], permission: 'acc_can_view_general' },
      { type: 'link', label: 'حركة النقدية',            href: '/accounts/cash-transactions',      icon: DollarSign, roles: ['owner','admin','pharmacist'], permission: 'acc_can_process_cash_flow' },
      { type: 'link', label: 'تسليم الدرج',             href: '/finance/handover',                icon: Handshake,  roles: ['owner','admin','pharmacist'], permission: 'acc_can_view_handover' },
      { type: 'separator' },
      { type: 'link', label: 'البنوك',                  href: '/finance/banks',                   icon: Landmark,   roles: ['owner','admin'], permission: 'acc_can_view_bank_accounts' },
      { type: 'link', label: 'البطاقات والماكينات',     href: '/finance/cards',                   icon: CreditCard, roles: ['owner','admin'], permission: 'acc_can_collect_credit_cards' },
      { type: 'link', label: 'إدارة نقاط البيع',       href: '/finance/pos-management',          icon: Monitor,    roles: ['owner','admin'], permission: 'acc_can_view_pos' },
      { type: 'link', label: 'شجرة الحسابات',           href: '/finance/accounts',                icon: TreePine,   roles: ['owner','admin'], permission: 'acc_can_view_bank_accounts' },
      { type: 'link', label: 'إعدادات ميزان المراجعة',  href: '/accounts/settings/trial-balance', icon: Settings,   roles: ['owner','admin'], permission: 'acc_can_make_daily_entries' },
    ],
  },
  {
    id: 'patients', label: 'المرضى',
    ownerRoutes: ['/patients','/interactions'],
    items: [
      { type: 'link', label: 'المرضى',              href: '/patients',    icon: Users,       roles: ['owner','admin','pharmacist'], permission: 'can_view_patients' },
      { type: 'link', label: 'التفاعلات الدوائية', href: '/interactions', icon: FlaskConical, roles: ['owner','admin','pharmacist'] },
    ],
  },
  {
    id: 'staff', label: 'الموظفون',
    ownerRoutes: ['/staff','/staff/manage','/staff/roles','/audit'],
    items: [
      { type: 'link', label: 'أداء الموظفين',    href: '/staff',        icon: BarChart3, roles: ['owner','admin'], permission: 'rep_can_view_activity' },
      { type: 'link', label: 'إدارة الموظفين',   href: '/staff/manage', icon: UserCog,   roles: ['owner','admin'] },
      { type: 'link', label: 'الوظائف والرواتب', href: '/staff/roles',  icon: Briefcase, roles: ['owner','admin'] },
      { type: 'separator' },
      { type: 'link', label: 'سجل المراقبة',     href: '/audit',        icon: Shield,    roles: ['owner'], permission: 'view_audit_logs' },
    ],
  },
  {
    id: 'settings', label: 'الإعدادات',
    ownerRoutes: ['/settings'],
    items: [
      { type: 'link', label: 'الإعدادات', href: '/settings', icon: Settings, roles: ['owner','admin'], permission: 'manage_settings' },
    ],
  },
  {
    id: 'reports', label: 'التقارير',
    ownerRoutes: ['/reports','/reports/sales','/reports/trial-balance','/expenses','/shifts','/shifts/report'],
    items: [
      { type: 'link', label: 'التقارير',          href: '/reports',               icon: BarChart3,  roles: ['owner','admin'] },
      { type: 'link', label: 'تقارير المبيعات',  href: '/reports/sales',         icon: TrendingUp, roles: ['owner','admin'], permission: 'view_reports' },
      { type: 'link', label: 'ميزان المراجعة',   href: '/reports/trial-balance', icon: PieChart,   roles: ['owner','admin'] },
      { type: 'separator' },
      { type: 'link', label: 'المصروفات',         href: '/expenses',              icon: Receipt,    roles: ['owner','admin'], permission: 'process_sales' },
      { type: 'link', label: 'الشفتات النقدية',  href: '/shifts',                icon: Calendar,   roles: ['owner','admin','pharmacist'], permission: 'manage_shifts' },
      { type: 'link', label: 'تقرير الشفتة',     href: '/shifts/report',         icon: FileText,   roles: ['owner','admin','pharmacist'], permission: 'manage_shifts' },
    ],
  },
  {
    id: 'help', label: 'مساعدة', ownerRoutes: [],
    items: [
      { type: 'action', label: 'اختصارات لوحة المفاتيح', action: 'shortcuts', icon: Keyboard },
      { type: 'action', label: 'عن النظام',               action: 'about',     icon: Info },
    ],
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanItems(items: MenuItem[], canSee: (i: MenuItem) => boolean): MenuItem[] {
  const visible = items.filter(canSee)
  return visible.filter((item, i, arr) => {
    if (item.type !== 'separator') return true
    const prev = arr[i - 1], next = arr[i + 1]
    if (!prev || !next || prev.type === 'separator') return false
    return true
  })
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 p-8 w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">اختصارات لوحة المفاتيح</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-1">
          {([['Esc','إغلاق القوائم'],['Enter','تأكيد / حفظ'],['Alt+P','فتح الكاشير']] as const).map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between py-2.5 border-b border-slate-100 dark:border-slate-800">
              <span className="text-sm text-slate-600 dark:text-slate-400">{desc}</span>
              <kbd className="px-2.5 py-1 bg-slate-100 dark:bg-slate-800 rounded font-mono text-xs font-bold text-slate-800 dark:text-white border border-slate-300 dark:border-slate-600">{key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function AboutModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 p-8 w-full max-w-sm mx-4 text-center" onClick={e => e.stopPropagation()}>
        <div className="text-5xl mb-3">💊</div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">نظام إدارة الصيدليات</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-4">الإصدار 1.0.0</p>
        <button onClick={onClose} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold text-sm hover:bg-blue-700 transition-colors">إغلاق</button>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface Props { userRole: string; permissions: any }

export default function TopMenuBar({ userRole, permissions }: Props) {
  const pathname = usePathname()
  const router   = useRouter()

  const [activeMenu, setActiveMenu] = useState<string | null>(null)
  const [modal, setModal]           = useState<'shortcuts' | 'about' | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const canSee = useCallback((item: MenuItem): boolean => {
    if (item.type === 'separator' || item.type === 'action') return true
    if (!item.roles) return true
    if (!item.roles.includes(userRole)) return false
    if (item.permission) {
      if (userRole === 'owner' || userRole === 'admin') return true
      if (Array.isArray(permissions)) {
        return permissions.includes(item.permission)
      }
      return permissions ? !!permissions[item.permission] : false
    }
    return true
  }, [userRole, permissions])

  const isMenuActive = (menu: Menu) =>
    menu.ownerRoutes.some(r => r === pathname || (r !== '/' && pathname?.startsWith(r)))

  const toggle = (id: string) => setActiveMenu(prev => prev === id ? null : id)
  const close  = useCallback(() => setActiveMenu(null), [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      if (e.altKey && e.key.toLowerCase() === 'p') router.push('/pos')
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [close, router])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [close])

  useEffect(() => { close() }, [pathname, close])

  const handleAction = async (action: string) => {
    close()
    if (action === 'print')     { window.print(); return }
    if (action === 'logout')    { await logoutLocal(); router.push('/login'); return }
    if (action === 'shortcuts') { setModal('shortcuts'); return }
    if (action === 'about')     { setModal('about'); return }
  }

  return (
    <>
      {modal === 'shortcuts' && <ShortcutsModal onClose={() => setModal(null)} />}
      {modal === 'about'     && <AboutModal     onClose={() => setModal(null)} />}

      {/* ── App-style menu bar ───────────────────────────────────────────────
          Looks like a native desktop menu bar: flat text labels, no pill shapes,
          compact height, dropdowns styled like OS context menus.            */}
      <nav
        ref={barRef}
        className="flex items-stretch h-full gap-0 relative select-none"
        dir="rtl"
      >
        {MENUS.map(menu => {
          const isOpen   = activeMenu === menu.id
          const isActive = isMenuActive(menu)
          const items    = cleanItems(menu.items, canSee)
          if (items.length === 0) return null

          return (
            <div key={menu.id} className="relative flex items-stretch">

              {/* ── Label trigger — styled like a real app menu bar item ── */}
              <button
                onClick={() => toggle(menu.id)}
                className={cn(
                  // base: full-height, compact horizontal padding, small text
                  'h-full px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-75',
                  'flex items-center gap-0',
                  // open state: inverted (dark bg in light mode, blue tint in dark)
                  isOpen
                    ? 'bg-blue-600 text-white'
                    // active (current section) but not open
                    : isActive
                    ? 'text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40'
                    // idle
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                )}
              >
                {menu.label}
              </button>

              {/* ── Dropdown — styled like an OS context menu ── */}
              {isOpen && (
                <div
                  className={cn(
                    'absolute top-full right-0 z-[200]',
                    'min-w-[200px] w-max',
                    // OS-style: white background, thin 1px border, tiny radius, crisp shadow
                    'bg-white dark:bg-[#1e1e2e]',
                    'border border-slate-200 dark:border-slate-700',
                    'rounded-md',
                    'shadow-[0_4px_16px_rgba(0,0,0,0.18)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)]',
                    'py-1',
                    'animate-in fade-in slide-in-from-top-1 duration-75'
                  )}
                >
                  {items.map((item, idx) => {
                    // Separator
                    if (item.type === 'separator') {
                      return <div key={idx} className="my-1 mx-0 h-px bg-slate-200 dark:bg-slate-700" />
                    }

                    const Icon = item.icon
                    const isLinkActive = item.type === 'link' && (
                      pathname === item.href ||
                      (item.href !== '/' && pathname?.startsWith(item.href))
                    )
                    const isLogout = item.type === 'action' && item.action === 'logout'

                    const rowClass = cn(
                      // OS menu item: full width, compact padding, small text, left-aligned icon
                      'flex items-center gap-2.5 w-full text-right px-3 py-[5px] text-[13px] transition-colors duration-75',
                      isLinkActive
                        ? 'bg-blue-600 text-white'
                        : isLogout
                        ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
                        : 'text-slate-800 dark:text-slate-200 hover:bg-blue-600 hover:text-white dark:hover:bg-blue-700'
                    )

                    const iconClass = cn(
                      'w-4 h-4 flex-shrink-0',
                      isLinkActive ? 'opacity-100' : isLogout ? 'text-red-500' : 'text-slate-400 group-hover:text-white'
                    )

                    if (item.type === 'link') {
                      return (
                        <Link key={item.href} href={item.href} onClick={close} className={rowClass}>
                          <Icon className={iconClass} />
                          <span>{item.label}</span>
                        </Link>
                      )
                    }

                    return (
                      <button key={idx} onClick={() => handleAction(item.action)} className={rowClass}>
                        <Icon className={iconClass} />
                        <span>{item.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>
    </>
  )
}

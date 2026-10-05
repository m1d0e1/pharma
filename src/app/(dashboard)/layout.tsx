'use client';

import Link from 'next/link';
import { toast } from 'react-hot-toast';
import { useRouter, usePathname } from 'next/navigation';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import SidebarNav from '@/components/SidebarNav';
import ThemeToggle from '@/components/ThemeToggle';
import { getClientSession, hasUserPermissionSync, logoutLocal } from '@/lib/auth/local';
import { dbGet } from '@/lib/db/tauri';
import { pharmacyIdentityConfigKey } from '@/lib/settings/pharmacy-identity';
import { Monitor, LogOut, ArrowRight, Pill } from 'lucide-react';
import HeaderAlerts from '@/components/HeaderAlerts';
import AuthGuard from '@/components/AuthGuard';
import PermissionGuard from '@/components/PermissionGuard';
import { getRoutePermission } from '@/lib/auth/roles';
import { isTauri as isTauriRuntime } from '@/lib/env';
import packageInfo from '../../../package.json';

const NATIVE_MENU_ROUTES = [
  ['pos', '/pos'],
  ['purchases_new', '/purchases/new'],
  ['dashboard', '/'],
  ['stores_items', '/stores/items'],
  ['stores_alternatives', '/stores/alternatives'],
  ['stores_nature', '/stores/nature'],
  ['stores_usage', '/stores/usage'],
  ['stores_units', '/stores/units'],
  ['stores_indications', '/stores/indications'],
  ['stores_drug_indications', '/stores/drug-indications'],
  ['stores_manufacturers', '/stores/manufacturers'],
  ['stores_scientific_groups', '/stores/scientific-groups'],
  ['stores_categories', '/stores/categories'],
  ['inventory', '/inventory'],
  ['stores_shortages', '/stores/shortages'],
  ['inventory_item_movements', '/inventory/item-movements'],
  ['restock', '/restock'],
  ['inventory_opening_balances', '/inventory/opening-balances'],
  ['stores_adjustments', '/stores/adjustments'],
  ['stores_adjustment_reasons', '/stores/adjustment-reasons'],
  ['inventory_settlement', '/inventory/settlement'],
  ['stores_delete_items', '/stores/delete-items'],
  ['receipts', '/receipts'],
  ['sales', '/sales'],
  ['sales_delivery', '/sales/delivery'],
  ['sales_cogs', '/sales/cogs'],
  ['returns', '/returns'],
  ['purchases', '/purchases'],
  ['purchase_orders', '/purchase-orders'],
  ['purchases_suppliers', '/purchases/suppliers'],
  ['purchases_returns', '/purchases/returns'],
  ['accounts', '/accounts'],
  ['accounts_cash_transactions', '/accounts/cash-transactions'],
  ['finance_banks', '/finance/banks'],
  ['finance_cards', '/finance/cards'],
  ['finance_pos_management', '/finance/pos-management'],
  ['finance_accounts', '/finance/accounts'],
  ['accounts_settings_trial_balance', '/accounts/settings/trial-balance'],
  ['reports', '/reports'],
  ['reports_sales2', '/reports/sales'],
  ['reports_purchases', '/reports/purchases'],
  ['reports_trial_balance', '/reports/trial-balance'],
  ['expenses', '/expenses'],
  ['patients', '/patients'],
  ['interactions', '/interactions'],
] as const;

function getAllowedNativeMenuRouteIds(user: any): string[] {
  return NATIVE_MENU_ROUTES
    .filter(([, route]) => {
      const requirement = getRoutePermission(route);
      if (!requirement) return true;
      return Array.isArray(requirement)
        ? requirement.some(key => hasUserPermissionSync(user, key))
        : hasUserPermissionSync(user, requirement);
    })
    .map(([id]) => id);
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isPos = pathname?.startsWith('/pos');
  const routePermission = getRoutePermission(pathname || '/');

  const [user, setUser] = useState<any>(null);
  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [permissions, setPermissions] = useState<any>(null);
  const [pharmacyName, setPharmacyName] = useState<string>('فارما تيك');
  const [loading, setLoading] = useState(true);
  const [isTauri, setIsTauri] = useState(false);
  const nativeMenuSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const roleLabel = userRole === 'owner' ? 'مالك' : userRole === 'admin' ? 'مدير النظام' : userRole === 'manager' ? 'مدير' : userRole === 'cashier' ? 'كاشير' : 'صيدلي';
  const permissionUser = useMemo(() => ({ role: userRole, permissions }), [userRole, permissions]);
  const canAccessPos = hasUserPermissionSync(permissionUser, 'can_access_pos');
  const canViewInventory = hasUserPermissionSync(permissionUser, 'can_view_stores');
  const canViewPurchases = hasUserPermissionSync(permissionUser, 'can_view_purchases');
  const nativeAdminMenuAccess = useMemo(() => ({
    staff: hasUserPermissionSync(permissionUser, 'rep_can_view_activity'),
    staffManage: hasUserPermissionSync(permissionUser, 'can_view_staff_manage'),
    staffRoles: hasUserPermissionSync(permissionUser, 'can_view_staff_roles'),
    audit: hasUserPermissionSync(permissionUser, 'can_view_audit'),
    settings: hasUserPermissionSync(permissionUser, 'can_view_settings'),
    allowedRouteIds: getAllowedNativeMenuRouteIds(permissionUser),
  }), [permissionUser]);
  const enqueueNativeMenuSync = useCallback((access: typeof nativeAdminMenuAccess, reportError: boolean) => {
    const sync = nativeMenuSyncQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('sync_native_admin_menu', { access });
      });
    nativeMenuSyncQueueRef.current = sync.catch(() => undefined);
    if (reportError) {
      void sync.catch((error) => console.error('Failed to sync native Administration menu:', error));
    }
  }, []);

  const log = (m: string) => typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__?.invoke('log_frontend_error', { message: m });

  useEffect(() => {
    // Detect Tauri once on mount
    log('LAYOUT: mount isTauri=' + isTauriRuntime);
    setIsTauri(isTauriRuntime);
  }, []);

  useEffect(() => {
    async function loadSessionAndConfig() {
      try {
        log('LAYOUT: loadSessionAndConfig start');
        const localUser = await getClientSession();
        log('LAYOUT: loadSessionAndConfig user=' + (localUser ? localUser.username : 'NULL'));
        
        if (localUser) {
          setUser({ email: localUser.username, id: localUser.id });
          setUserRole(localUser.role || 'pharmacist');
          if (localUser.permissions) {
            const parsed = typeof localUser.permissions === 'string'
              ? JSON.parse(localUser.permissions)
              : localUser.permissions;
            setPermissions(parsed);
          }

          try {
            const pharmacyNameRow = await dbGet(
              'SELECT value FROM config WHERE key = ?',
              [pharmacyIdentityConfigKey('pharmacy_name', localUser.pharmacy_id)]
            );
            if (pharmacyNameRow?.value) {
              setPharmacyName(pharmacyNameRow.value);
            }
          } catch (dbErr) {
            console.error('Failed to fetch pharmacy name:', dbErr);
          }
        }
      } catch (err: any) {
        log('LAYOUT: loadSessionAndConfig error=' + err.message);
        console.error('Failed to load session:', err);
      } finally {
        log('LAYOUT: loadSessionAndConfig finally');
        setLoading(false);
      }
    }

    loadSessionAndConfig();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime || loading) return;
    enqueueNativeMenuSync(nativeAdminMenuAccess, true);
  }, [loading, nativeAdminMenuAccess, enqueueNativeMenuSync]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    return () => {
      enqueueNativeMenuSync({
        staff: false,
        staffManage: false,
        staffRoles: false,
        audit: false,
        settings: false,
        allowedRouteIds: [],
      }, false);
    };
  }, [enqueueNativeMenuSync]);

  // Handle native Tauri menu events
  useEffect(() => {
    if (!isTauriRuntime) return;
    
    let active = true;
    let unlistenNavigate: (() => void) | undefined;
    let unlistenAction: (() => void) | undefined;
    let shortcutsEscHandler: ((event: KeyboardEvent) => void) | undefined;
    let shortcutsCleanupTimer: ReturnType<typeof setTimeout> | undefined;

    const clearShortcutsListener = () => {
      if (shortcutsEscHandler) {
        window.removeEventListener('keydown', shortcutsEscHandler);
        shortcutsEscHandler = undefined;
      }
      if (shortcutsCleanupTimer) {
        clearTimeout(shortcutsCleanupTimer);
        shortcutsCleanupTimer = undefined;
      }
    };

    const setupListeners = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (!active) return;
        
        const currentWindow = getCurrentWindow();
        
        unlistenNavigate = await currentWindow.listen<string>('menu-navigate', (event) => {
          if (typeof document !== 'undefined' && document.hasFocus()) {
            router.push(event.payload);
          }
        });

        unlistenAction = await currentWindow.listen<string>('menu-action', async (event) => {
          const action = event.payload;

          // F10 is reserved by the Windows native menu. The Rust menu accelerator
          // forwards it here so the mounted purchase form can handle the same
          // save-draft intent without entering the native menu loop.
          if (action === 'purchase-save-draft') {
            window.dispatchEvent(new Event('pharma:purchase-save-draft'));
            return;
          }

          if (typeof document !== 'undefined' && !document.hasFocus()) return;
          
          if (action === 'print') window.print();
          if (action === 'about') {
            try {
              const { getVersion } = await import('@tauri-apps/api/app');
              const version = await getVersion();
              const { message } = await import('@tauri-apps/plugin-dialog');
              await message(
                `الإصدار: ${version}\nنظام إدارة صيدليات ذكي، مبني بأحدث التقنيات لضمان السرعة والأمان والموثوقية.\n\nتم انشاؤه بواسطة محمد عصام لمجتمع الصيادلة.\nللتواصل: m0hamed.essamit2000@gmail.com`,
                { title: 'نظام فارما تيك المتكامل', kind: 'info' }
              ).catch(() => toast.success(`نظام فارما تيك المتكامل - الإصدار ${version}`));
            } catch (e) {
              console.error('Failed to show about dialog', e);
              toast.success(`نظام فارما تيك المتكامل - الإصدار ${packageInfo.version}`);
            }
          }
          if (action === 'shortcuts') {
            clearShortcutsListener();
            toast.success(
              'اختصارات لوحة المفاتيح:\n' +
              'Insert: تمييز البحث (الكاشير) / إضافة صنف (المخزون)\n' +
              'Ctrl+P: الكاشير\n' +
              'Ctrl+I: المخزون\n' +
              'Ctrl+D: الرئيسية\n' +
              'Ctrl+O: المشتريات\n' +
              'Ctrl+N: نافذة جديدة\n' +
              'F1: البحث السريع\n\n' +
              '(اضغط ESC للإغلاق)',
              { duration: 10000, id: 'shortcuts-toast' }
            );
            shortcutsEscHandler = (e: KeyboardEvent) => {
              if (e.key === 'Escape') {
                toast.dismiss('shortcuts-toast');
                clearShortcutsListener();
              }
            };
            window.addEventListener('keydown', shortcutsEscHandler);
            shortcutsCleanupTimer = setTimeout(clearShortcutsListener, 10000);
          }
        if (action === 'update') {
          const toastId = toast.loading('جاري البحث عن تحديثات...', { duration: 15000 });
          try {
            const { check } = await import('@tauri-apps/plugin-updater');
            const { getVersion } = await import('@tauri-apps/api/app');
            const { message, ask } = await import('@tauri-apps/plugin-dialog');
            const { relaunch } = await import('@tauri-apps/plugin-process');
            
            const currentVersion = await getVersion();
            let update: Awaited<ReturnType<typeof check>> = null;
            let latestVersion: string | null = null;

            try {
              update = await check({ timeout: 30_000 });
              if (update) latestVersion = update.version;
            } catch { /* Tauri updater threw — will fetch fallback below */ }

            // Always fetch latest version for display (GitHub API has proper CORS headers)
            if (!latestVersion) {
              try {
                const res = await fetch('https://api.github.com/repos/m1d0e1/pharma/releases/latest');
                if (res.ok) {
                  const data = await res.json();
                  // tag_name is like "v0.2.11", strip the "v"
                  latestVersion = (data.tag_name ?? '').replace(/^v/, '') || null;
                }
              } catch { /* network down */ }
            }


            toast.dismiss(toastId);

            if (update) {
              const yes = await ask(
                `الإصدار الحالي: ${currentVersion}\nأحدث إصدار: ${update.version}\n\nهل تريد التحديث الآن؟`,
                { title: 'تحديث البرنامج', kind: 'info', okLabel: 'نعم، حدث الآن', cancelLabel: 'لاحقاً' }
              );
              if (yes) {
                toast.loading('جاري التحميل والتثبيت...', { id: toastId });
                try {
                  await update.downloadAndInstall(undefined, { timeout: 5 * 60_000 });
                  toast.dismiss(toastId);
                  await message('تم التحديث بنجاح! سيتم إعادة تشغيل البرنامج الآن.', { title: 'نجاح التحديث', kind: 'info' }).catch(() => toast.success('تم التحديث بنجاح!'));
                  await relaunch();
                } catch (installErr) {
                  toast.error('فشل التثبيت. تأكد من إغلاق الملفات وحاول مرة أخرى.', { id: toastId });
                }
              }
            } else if (latestVersion) {
              // We know latest but Tauri says no update (same version, or signed check failed)
              await message(
                `الإصدار الحالي: ${currentVersion}\nأحدث إصدار متاح: ${latestVersion}\n\n${latestVersion === currentVersion ? 'أنت تستخدم أحدث إصدار.' : 'يرجى تثبيت الإصدار الجديد يدوياً من الموقع.'}`,
                { title: 'معلومات الإصدار', kind: 'info' }
              ).catch(() => toast.success(`الإصدار الحالي: ${currentVersion} | أحدث إصدار: ${latestVersion}`));
            } else {
              await message(
                `الإصدار الحالي: ${currentVersion}\n\nتعذر الاتصال بالخادم للتحقق من التحديثات.\nتأكد من اتصالك بالإنترنت.`,
                { title: 'تحقق من التحديثات', kind: 'warning' }
              ).catch(() => toast.error(`الإصدار الحالي: ${currentVersion} — تعذر الاتصال`));
            }
          } catch (err) {
            console.error('Update failed:', err);
            toast.dismiss(toastId);
            toast.error('تعذر التحقق من التحديثات. تأكد من اتصالك بالإنترنت.');
          }
        }
        if (action === 'logout') {
          try {
            const { logoutLocal } = await import('@/lib/auth/local');
            await logoutLocal();
            router.push('/login');
          } catch (err) {
            console.error('Failed to logout from native menu', err);
            toast.error('تعذر تسجيل الخروج. حاول مرة أخرى.');
          }
        }
        });
      } catch (err) {
        console.error("Failed to load tauri event API", err);
      }
    };

    setupListeners();

    return () => {
      active = false;
      clearShortcutsListener();
      if (unlistenNavigate) unlistenNavigate();
      if (unlistenAction) unlistenAction();
    };
  }, [router]);

  // Global Keyboard Shortcuts
  useHotkeys('ctrl+p, meta+p', (e) => {
    e.preventDefault();
    if (canAccessPos) router.push('/pos');
  }, { enableOnFormTags: true, preventDefault: true });

  useHotkeys('ctrl+i, meta+i', (e) => {
    e.preventDefault();
    if (canViewInventory) router.push('/inventory');
  }, { enableOnFormTags: true, preventDefault: true });

  useHotkeys('ctrl+o, meta+o', (e) => {
    e.preventDefault();
    if (canViewPurchases) router.push('/purchases');
  }, { enableOnFormTags: true, preventDefault: true });

  useHotkeys('ctrl+d, meta+d', (e) => {
    e.preventDefault();
    router.push('/');
  }, { enableOnFormTags: true, preventDefault: true });

  useHotkeys('ctrl+n, meta+n', (e) => {
    e.preventDefault();
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('open_new_window'))
      .catch(() => window.open('/', '_blank'));
  }, { enableOnFormTags: true, preventDefault: true });

  useHotkeys('f1', (e) => {
    e.preventDefault();
    const searchInput = document.querySelector<HTMLInputElement>('[data-nav="search-input"], input[placeholder*="بحث"], input[type="search"]');
    if (searchInput) searchInput.focus();
  }, { enableOnFormTags: true, preventDefault: true });

  const handleLogout = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await logoutLocal();
      router.push('/login');
    } catch (err) {
      console.error('Failed to logout', err);
      toast.error('تعذر تسجيل الخروج. حاول مرة أخرى.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 dark:bg-slate-900" dir="rtl">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 dark:border-blue-400 mx-auto"></div>
          <p className="mt-4 text-slate-600 dark:text-slate-400 font-medium">جاري التحميل...</p>
        </div>
      </div>
    );
  }

  const backButton = pathname !== '/' && (
    <button
      type="button"
      onClick={() => router.back()}
      aria-label="رجوع للصفحة السابقة"
      title="رجوع"
      className="fixed bottom-20 lg:bottom-5 left-5 z-[190] flex h-11 w-11 items-center justify-center rounded-lg bg-primary-700 text-white shadow-md transition-colors hover:bg-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-slate-950"
    >
      <ArrowRight className="h-5 w-5" />
    </button>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TAURI (Desktop) Layout — top menu bar, no sidebar
  // ══════════════════════════════════════════════════════════════════════════
  if (isTauri) {
    return (
      <AuthGuard>
        <div
          className="flex flex-col h-screen overflow-hidden bg-slate-50 dark:bg-slate-950 font-sans"
          dir="rtl"
        >
          {backButton}
          <div className="hidden" aria-hidden="true">
            <SidebarNav userRole={userRole} userPermissions={permissions} />
          </div>
          {/* 1. Main Toolbar/Header */}
          {!isPos && (
            <header className="sticky top-0 z-40 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between px-4 h-14">

                {/* Left: Logo + Pharmacy Name + POS Button */}
                <div className="flex items-center gap-0">
                  <Link href="/" className="flex items-center gap-2.5 flex-shrink-0 mr-4 group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950">
                    <div className="w-9 h-9 bg-primary-600 rounded-lg flex items-center justify-center text-white shadow-sm">
                      <Pill className="h-[18px] w-[18px]" aria-hidden="true" />
                    </div>
                    <div className="hidden sm:block">
                      <p className="text-sm font-semibold text-slate-900 dark:text-white leading-tight">{pharmacyName}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 leading-tight">
                        {roleLabel}
                      </p>
                    </div>
                  </Link>

                  <div className="h-8 w-px bg-slate-200 dark:bg-slate-700 mx-3 flex-shrink-0" />

                  {canAccessPos && (
                    <Link
                      href="/pos"
                      className="flex-shrink-0 flex items-center gap-2 px-3.5 py-2 bg-primary-700 hover:bg-primary-800 text-white rounded-lg font-semibold text-sm shadow-sm transition-colors ml-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
                    >
                      <Monitor className="w-4 h-4" />
                      <span className="hidden sm:inline">الكاشير</span>
                    </Link>
                  )}
                </div>

                {/* Right: User + Theme */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <HeaderAlerts />
                  <div className="hidden md:flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="w-7 h-7 bg-primary-700 rounded-md flex items-center justify-center text-white text-xs font-semibold">
                      {user?.email?.[0]?.toUpperCase() || 'U'}
                    </div>
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate max-w-[100px] hidden lg:block">
                      {user?.email}
                    </p>
                  </div>
                  <ThemeToggle />
                </div>
              </div>
            </header>
          )}

          {/* Page Content */}
          <main className={`flex-1 ${isPos ? 'flex flex-col min-h-0 overflow-hidden' : 'overflow-y-auto'}`}>
            <div className={isPos ? "w-full flex-1 flex flex-col min-h-0 pb-24 lg:pb-0" : "w-full p-4 pb-24 sm:p-6 lg:pb-6"}>
              <PermissionGuard permissionKey={routePermission}>{children}</PermissionGuard>
            </div>
          </main>
        </div>
      </AuthGuard>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEB Layout — classic sidebar
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950 font-sans" dir="rtl">
        {backButton}
        
        {/* Sidebar */}
        <aside className="hidden lg:flex w-72 flex-col border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 z-30">
          {/* Pharmacy Header */}
          <div className="p-5 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary-600 rounded-lg flex items-center justify-center text-white shadow-sm">
                <Pill className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-slate-900 dark:text-white leading-tight">{pharmacyName}</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-2">
                  {roleLabel}
                </p>
              </div>
            </div>
          </div>

          {/* Navigation */}
          <SidebarNav userRole={userRole} userPermissions={permissions} />

          {/* User Profile & Actions */}
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex items-center gap-3 px-3 py-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="w-9 h-9 bg-primary-700 rounded-lg flex items-center justify-center text-white">
                <span className="font-semibold text-sm">{user?.email?.[0]?.toUpperCase() || 'U'}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {user?.email}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2">
                  {roleLabel}
                </p>
              </div>
              <ThemeToggle />
            </div>

              <div className="flex flex-col gap-2">

              
                <form onSubmit={handleLogout}>
                  <button
                    type="submit"
                    className="flex min-h-10 items-center gap-3 w-full px-3 py-2 rounded-lg text-sm font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-950"
                  >
                    <div className="w-8 h-8 rounded-lg bg-rose-100 dark:bg-rose-950/50 flex items-center justify-center">
                      <LogOut className="w-4 h-4" />
                    </div>
                    تسجيل الخروج
                  </button>
                </form>
              </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Top Bar */}
          <header className="sticky top-0 z-20 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 py-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 sm:gap-5">
                <div>
                  <h1 className="text-lg sm:text-xl font-semibold text-slate-900 dark:text-white truncate max-w-[240px] sm:max-w-none leading-tight">
                    نظام إدارة الصيدليات الذكي
                  </h1>
                  <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 hidden sm:block mt-1">
                    إدارة شاملة للصيدلية في مكان واحد
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 sm:gap-4">
                <HeaderAlerts />
                <div className="hidden sm:flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                  <div className="w-8 h-8 bg-primary-700 rounded-lg flex items-center justify-center text-white text-sm font-semibold">
                    {user?.email?.[0]?.toUpperCase() || 'U'}
                  </div>
                  <div className="hidden lg:block">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate max-w-[140px]">
                      {user?.email}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2">
                      {roleLabel}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </header>

          {/* Page Content */}
          <div className={`flex-1 ${isPos ? 'flex flex-col min-h-0 overflow-hidden p-3 pb-24 lg:pb-3' : 'overflow-y-auto p-4 pb-24 sm:p-6 lg:pb-6'}`}>
            <div className={isPos ? "w-full flex-1 flex flex-col min-h-0" : "max-w-7xl mx-auto"}>
              <PermissionGuard permissionKey={routePermission}>{children}</PermissionGuard>
            </div>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}

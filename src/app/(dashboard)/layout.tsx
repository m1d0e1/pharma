'use client';

import Link from 'next/link';
import { toast } from 'react-hot-toast';
import { useRouter, usePathname } from 'next/navigation';
import React, { useEffect, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import TopMenuBar from '@/components/TopMenuBar';
import SidebarNav from '@/components/SidebarNav';
import ThemeToggle from '@/components/ThemeToggle';
import { getClientSession, logoutLocal } from '@/lib/auth/local';
import { dbGet } from '@/lib/db/tauri';
import { Monitor, Bell, LogOut, Menu } from 'lucide-react';
import HeaderAlerts from '@/components/HeaderAlerts';
import AuthGuard from '@/components/AuthGuard';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isPos = pathname?.startsWith('/pos');

  const [user, setUser] = useState<any>(null);
  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [permissions, setPermissions] = useState<any>(null);
  const [pharmacyName, setPharmacyName] = useState<string>('فارما تيك');
  const [loading, setLoading] = useState(true);
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    // Detect Tauri once on mount
    setIsTauri(typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined));
  }, []);

  useEffect(() => {
    async function loadSessionAndConfig() {
      try {
        const localUser = await getClientSession();
        
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
            const pharmacyNameRow = await dbGet("SELECT value FROM config WHERE key = 'pharmacy_name'");
            if (pharmacyNameRow?.value) {
              setPharmacyName(pharmacyNameRow.value);
            }
          } catch (dbErr) {
            console.error('Failed to fetch pharmacy name:', dbErr);
          }
        } else {
          const _isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined);
          if (!_isTauri) {
            try {
              const { getSupabaseBrowserClient } = await import('@/lib/supabase');
              const supabase = getSupabaseBrowserClient();
              const { data } = await supabase.auth.getUser();
              if (data?.user) {
                setUser({ email: data.user.email, id: data.user.id });
                const { data: profile } = await supabase
                  .from('profiles')
                  .select('role, pharmacies(name)')
                  .eq('id', data.user.id)
                  .single();
                if (profile) {
                  setUserRole(profile.role || 'pharmacist');
                  if ((profile as any).pharmacies?.name) {
                    setPharmacyName((profile as any).pharmacies.name);
                  }
                }
              }
            } catch (sbErr) {
              console.error('Supabase auth fallback error:', sbErr);
            }
          }
        }
      } catch (err) {
        console.error('Failed to load session:', err);
      } finally {
        setLoading(false);
      }
    }

    loadSessionAndConfig();
  }, []);

  // Handle native Tauri menu events
  useEffect(() => {
    if (typeof window === 'undefined' || (!(window as any).__TAURI__ && !(window as any).__TAURI_INTERNALS__)) return;
    
    let unlistenNavigate: (() => void) | undefined;
    let unlistenAction: (() => void) | undefined;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('menu-navigate', (event) => {
        router.push(event.payload);
      }).then(unlisten => { unlistenNavigate = unlisten });

      listen<string>('menu-action', async (event) => {
        const action = event.payload;
        if (action === 'print') window.print();
        if (action === 'about') {
          try {
            const { getVersion } = await import('@tauri-apps/api/app');
            const version = await getVersion();
            const { message } = await import('@tauri-apps/plugin-dialog');
            await message(
              `الإصدار: ${version}\nنظام إدارة صيدليات ذكي، مبني بأحدث التقنيات لضمان السرعة والأمان والموثوقية.`,
              { title: 'نظام فارما تيك المتكامل', kind: 'info' }
            ).catch(() => toast.success(`نظام فارما تيك المتكامل - الإصدار ${version}`));
          } catch (e) {
            console.error('Failed to show about dialog', e);
            toast.success('نظام فارما تيك المتكامل - الإصدار 0.1.9');
          }
        }
        if (action === 'shortcuts') {
          toast(
            <div dir="rtl" className="text-sm">
              <h3 className="font-bold mb-2">اختصارات لوحة المفاتيح:</h3>
              <ul className="space-y-1 text-slate-600 dark:text-slate-300">
                <li><kbd className="bg-slate-100 dark:bg-slate-800 px-1 rounded">Ctrl+P</kbd> شاشة الكاشير (POS)</li>
                <li><kbd className="bg-slate-100 dark:bg-slate-800 px-1 rounded">Ctrl+I</kbd> المخزون</li>
                <li><kbd className="bg-slate-100 dark:bg-slate-800 px-1 rounded">Ctrl+D</kbd> لوحة التحكم (الرئيسية)</li>
                <li><kbd className="bg-slate-100 dark:bg-slate-800 px-1 rounded">Ctrl+N</kbd> فتح نافذة جديدة</li>
                <li><kbd className="bg-slate-100 dark:bg-slate-800 px-1 rounded">F1</kbd> البحث السريع</li>
              </ul>
            </div>, 
            { icon: '⌨️', duration: 10000 }
          );
        }
        if (action === 'update') {
          const toastId = toast.loading('جاري البحث عن تحديثات...', { duration: 15000 });
          try {
            const { check } = await import('@tauri-apps/plugin-updater');
            const { message, ask } = await import('@tauri-apps/plugin-dialog');
            const { relaunch } = await import('@tauri-apps/plugin-process');
            
            const update = await check();
            if (update) {
              toast.dismiss(toastId);
              const yes = await ask(`تم العثور على الإصدار الجديد ${update.version}.\nهل تريد التحديث الآن؟`, {
                title: 'تحديث البرنامج',
                kind: 'info',
                okLabel: 'نعم، حدث الآن',
                cancelLabel: 'لاحقاً'
              }).catch(() => true); // If dialog fails, assume yes
              if (yes) {
                toast.loading('جاري التحميل والتثبيت...', { id: toastId });
                await update.downloadAndInstall();
                toast.dismiss(toastId);
                await message('تم التحديث بنجاح! سيتم إعادة تشغيل البرنامج الآن.', { title: 'نجاح التحديث', kind: 'info' }).catch(() => toast.success('تم التحديث بنجاح!'));
                await relaunch();
              }
            } else {
              toast.dismiss(toastId);
              toast.success('لا توجد تحديثات جديدة. أنت تستخدم أحدث إصدار.');
              await message('أنت تستخدم أحدث إصدار من البرنامج. لا توجد تحديثات جديدة.', { title: 'لا يوجد تحديث', kind: 'info' }).catch(() => {});
            }
          } catch (err) {
            console.error('Update failed:', err);
            toast.dismiss(toastId);
            toast.error('لم يتم العثور على تحديثات أو تعذر الاتصال بالخادم.');
          }
        }
        if (action === 'logout') {
          const { logoutLocal } = await import('@/lib/auth/local');
          await logoutLocal();
          router.push('/login');
        }
      }).then(unlisten => { unlistenAction = unlisten });
    }).catch(err => console.error("Failed to load tauri event API", err));

    return () => {
      if (unlistenNavigate) unlistenNavigate();
      if (unlistenAction) unlistenAction();
    };
  }, [router]);

  // Global Keyboard Shortcuts
  useHotkeys('ctrl+p, meta+p', (e) => {
    e.preventDefault();
    router.push('/pos');
  }, { enableOnFormTags: true });

  useHotkeys('ctrl+i, meta+i', (e) => {
    e.preventDefault();
    router.push('/inventory');
  }, { enableOnFormTags: true });

  useHotkeys('ctrl+d, meta+d', (e) => {
    e.preventDefault();
    router.push('/');
  }, { enableOnFormTags: true });

  useHotkeys('ctrl+n, meta+n', (e) => {
    e.preventDefault();
    try {
      if (typeof window !== 'undefined' && ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)) {
        import('@tauri-apps/api/webviewWindow').then(({ WebviewWindow }) => {
          new WebviewWindow('window_' + Date.now(), { url: '/', title: 'Pharma Dashboard', width: 1280, height: 800, minWidth: 800, minHeight: 600 });
        }).catch(() => window.open('/', '_blank'));
      } else {
        window.open('/', '_blank');
      }
    } catch {
      window.open('/', '_blank');
    }
  }, { enableOnFormTags: true });

  useHotkeys('f1', (e) => {
    e.preventDefault();
    const searchInput = document.querySelector<HTMLInputElement>('[data-nav="search-input"], input[placeholder*="بحث"], input[type="search"]');
    if (searchInput) searchInput.focus();
  }, { enableOnFormTags: true });

  const handleLogout = async (e: React.FormEvent) => {
    e.preventDefault();
    await logoutLocal();
    router.push('/login');
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

  // ══════════════════════════════════════════════════════════════════════════
  // TAURI (Desktop) Layout — top menu bar, no sidebar
  // ══════════════════════════════════════════════════════════════════════════
  if (isTauri) {
    return (
      <AuthGuard>
        <div
          className={`flex flex-col ${isPos ? 'h-screen overflow-hidden' : 'min-h-screen'} bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 font-sans`}
          dir="rtl"
        >
          {/* 1. Main Toolbar/Header */}
          {!isPos && (
            <header className="sticky top-0 z-40 bg-white/80 dark:bg-slate-950/80 backdrop-blur-xl border-b border-slate-200/60 dark:border-slate-800/60 shadow-sm">
              <div className="flex items-center justify-between px-4 h-14">

                {/* Left: Logo + Pharmacy Name + POS Button */}
                <div className="flex items-center gap-0">
                  <Link href="/" className="flex items-center gap-2.5 flex-shrink-0 mr-4 group">
                    <div className="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-700 rounded-xl flex items-center justify-center text-white shadow-md shadow-blue-500/30 group-hover:shadow-lg group-hover:shadow-blue-500/40 transition-all text-lg">
                      💊
                    </div>
                    <div className="hidden sm:block">
                      <p className="text-sm font-black text-slate-900 dark:text-white leading-tight">{pharmacyName}</p>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">
                        {userRole === 'admin' || userRole === 'owner' ? '👑 مدير النظام' : '🧪 صيدلي'}
                      </p>
                    </div>
                  </Link>

                  <div className="h-8 w-px bg-slate-200 dark:bg-slate-700 mx-3 flex-shrink-0" />

                  <Link
                    href="/pos"
                    className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white rounded-xl font-black text-sm shadow-md shadow-blue-500/30 hover:shadow-lg hover:shadow-blue-500/40 transition-all ml-3"
                  >
                    <Monitor className="w-4 h-4" />
                    <span className="hidden sm:inline">الكاشير</span>
                  </Link>
                </div>

                {/* Right: User + Theme */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <HeaderAlerts />
                  <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/50 dark:border-slate-700/50">
                    <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-blue-700 rounded-lg flex items-center justify-center text-white text-xs font-black shadow-sm">
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
            <div className={isPos ? "w-full flex-1 flex flex-col min-h-0" : "w-full p-4 sm:p-6"}>
              {children}
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
      <div className={`flex ${isPos ? 'h-screen overflow-hidden' : 'min-h-screen'} bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 font-sans`} dir="rtl">
        
        {/* Sidebar */}
        <aside className="hidden lg:flex w-80 flex-col border-l border-slate-200/60 dark:border-slate-800/60 bg-gradient-glass dark:bg-gradient-glass-dark backdrop-blur-xl shadow-hard z-30">
          {/* Pharmacy Header */}
          <div className="p-7 border-b border-slate-200/50 dark:border-slate-800/50">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-gradient-primary rounded-2xl flex items-center justify-center text-white shadow-lg shadow-primary-500/30">
                <span className="text-3xl">💊</span>
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-slate-900 dark:text-white leading-tight">{pharmacyName}</h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1.5 flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 text-xs">
                    {userRole === 'admin' || userRole === 'owner' ? '👑' : '🧪'}
                  </span>
                  {userRole === 'admin' || userRole === 'owner' ? 'مدير النظام' : 'صيدلي'}
                </p>
              </div>
            </div>
          </div>

          {/* Navigation */}
          <SidebarNav userRole={userRole} />

          {/* User Profile & Actions */}
          <div className="p-5 border-t border-slate-200/50 dark:border-slate-800/50 space-y-5">
            <div className="flex items-center gap-4 px-5 py-4 rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100/50 dark:from-slate-800/50 dark:to-slate-900/50 backdrop-blur-sm">
              <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center text-white shadow-md">
                <span className="font-bold text-lg">{user?.email?.[0]?.toUpperCase() || 'U'}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {user?.email}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 text-xs">
                    {userRole === 'admin' || userRole === 'owner' ? '👑' : '🧪'}
                  </span>
                  {userRole === 'admin' || userRole === 'owner' ? 'مدير' : 'صيدلي'}
                </p>
              </div>
              <ThemeToggle />
            </div>

              <div className="flex flex-col gap-2">

              
                <form onSubmit={handleLogout}>
                  <button
                    type="submit"
                    className="flex items-center gap-4 w-full px-5 py-4 rounded-2xl text-sm font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                  >
                    <div className="w-8 h-8 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
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
          <header className="sticky top-0 z-20 bg-gradient-glass dark:bg-gradient-glass-dark backdrop-blur-xl border-b border-slate-200/60 dark:border-slate-800/60 px-5 sm:px-7 py-4 sm:py-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 sm:gap-5">
                <button className="lg:hidden p-3 rounded-2xl hover:bg-slate-100/80 dark:hover:bg-slate-800/80 transition-all duration-300 hover:shadow-md">
                  <Menu className="w-6 h-6 text-slate-700 dark:text-slate-300" />
                </button>
                <div>
                  <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white truncate max-w-[240px] sm:max-w-none leading-tight">
                    نظام إدارة الصيدليات الذكي
                  </h1>
                  <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 hidden sm:block mt-1.5">
                    إدارة شاملة للصيدلية في مكان واحد
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 sm:gap-4">
                <HeaderAlerts />
                <div className="hidden sm:flex items-center gap-4 px-4 sm:px-5 py-3 rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100/50 dark:from-slate-800/50 dark:to-slate-900/50 backdrop-blur-sm border border-slate-200/50 dark:border-slate-700/50">
                  <div className="w-9 h-9 sm:w-10 sm:h-10 bg-gradient-primary rounded-xl flex items-center justify-center text-white text-sm sm:text-base font-bold shadow-md">
                    {user?.email?.[0]?.toUpperCase() || 'U'}
                  </div>
                  <div className="hidden lg:block">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate max-w-[140px]">
                      {user?.email}
                    </p>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 text-xs">
                        {userRole === 'admin' || userRole === 'owner' ? '👑' : '🧪'}
                      </span>
                      {userRole === 'admin' || userRole === 'owner' ? 'مدير' : 'صيدلي'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </header>

          {/* Page Content */}
          <div className={`flex-1 ${isPos ? 'flex flex-col min-h-0 overflow-hidden p-3' : 'overflow-y-auto p-4 sm:p-6'}`}>
            <div className={isPos ? "w-full flex-1 flex flex-col min-h-0" : "max-w-7xl mx-auto"}>
              {children}
            </div>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}

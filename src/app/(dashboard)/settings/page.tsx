'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import PharmacySettingsForm from '@/components/settings/PharmacySettingsForm';
import SyncSettings from '@/components/settings/SyncSettings';
import DbMaintenance from '@/components/settings/DbMaintenance';
import LocalUserManagement from '@/components/settings/LocalUserManagement';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import AccessDenied from '@/components/AccessDenied';
import { useRouter } from 'next/navigation';

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [cloudProfile, setCloudProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSettingsData() {
      try {
        const sessionUser = await getClientSession();
        if (!sessionUser) {
          router.push('/login');
          return;
        }
        setUser(sessionUser);

        const isAllowed = hasUserPermissionSync(sessionUser, 'can_view_settings');

        if (isAllowed) {
          setAllowed(true);
          const supabase = getSupabaseBrowserClient();
          if (supabase) {
            const { data: authData } = await supabase.auth.getUser();

            if (authData?.user) {
              const { data } = await supabase
                .from('profiles')
                .select('*, pharmacies(*)')
                .eq('id', authData.user.id)
                .single();
              setCloudProfile(data);
            }
          }
        }
      } catch (err) {
        console.error('Failed to load settings data:', err);
      } finally {
        setLoading(false);
      }
    }
    loadSettingsData();
  }, [router]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-12 p-4 animate-in fade-in slide-in-from-bottom-6 duration-700" dir="rtl">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-3 mb-2 text-blue-600 dark:text-blue-400 font-black text-xs uppercase tracking-widest">
            <span className="w-8 h-[2px] bg-blue-500"></span>
            Cloud Admin & Local Enforcer
          </div>
          <h1 className="text-4xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tight">إعدادات النظام الهجين</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-3 text-lg">تحكم في هوية صيدليتك، مزامنة السحابة، وإدارة المستخدمين المحليين.</p>
        </div>
      </div>

      {/* Main Content */}
      <PharmacySettingsForm pharmacy={(cloudProfile as any)?.pharmacies} />
      
      {/* Enforcer Control Center */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <SyncSettings />
        <DbMaintenance />
        <div className="lg:col-span-2">
          <LocalUserManagement />
        </div>
      </div>

      {/* Footer Info Card */}
      <div className="bg-slate-900 p-10 rounded-[3rem] shadow-2xl relative overflow-hidden">
         <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/10 blur-[100px] rounded-full"></div>
         <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8">
            <div className="max-w-xl">
               <h4 className="text-2xl font-bold text-white mb-4">باقة الاشتراك (The Brain)</h4>
               <p className="text-slate-400 leading-relaxed">
                 اشتراكك الحالي يتيح لك مزامنة عدد غير محدود من الأدوية والحصول على التحديثات الأمنية. في حالة انتهاء الاشتراك، سيظل "The Local Enforcer" يعمل محلياً ولكن لن تتمكن من المزامنة.
               </p>
            </div>
            <div className="bg-white/5 border border-white/10 p-8 rounded-3xl text-center min-w-[240px]">
               <p className="text-xs text-slate-500 font-bold mb-2 uppercase tracking-widest">تاريخ التجديد القادم</p>
               <p className="text-2xl font-black text-white">28 مايو 2026</p>
               <button className="mt-6 text-sm font-black text-blue-400 hover:underline">إدارة الفواتير</button>
            </div>
         </div>
      </div>
    </div>
  );
}

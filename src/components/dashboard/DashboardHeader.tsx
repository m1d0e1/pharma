'use client';

import { useState, useEffect } from 'react';
import { LogOut, User, Clock, DollarSign, Menu, X, ShieldCheck } from 'lucide-react';
import LogoutModal from '../auth/LogoutModal';
import NetworkStatus from '../status/NetworkStatus';
import SyncStatus from '../status/SyncStatus';
import { getClientSession } from '@/lib/auth/local';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';

export default function DashboardHeader() {
  const [user, setUser] = useState<any>(null);
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  useEffect(() => {
    const init = async () => {
      // 1. Get Local Session via Server Action
      const session = await getClientSession();
      if (session) {
        setUser(session);
      } else {
        // Fallback
        const userData = localStorage.getItem('user');
        if (userData) setUser(JSON.parse(userData));
      }

      // 2. Get Current Shift from Local DB
      const shiftResult = await getCurrentShiftAction();
      if (shiftResult.success && shiftResult.data) {
        setCurrentShift(shiftResult.data);
      }
    };
    init();
  }, []);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('ar-EG', {
      style: 'currency',
      currency: 'EGP',
    }).format(amount).replace('EGP', 'ج.م');
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString('ar-EG', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const isOwner = user?.role === 'owner' || user?.role === 'admin';
  const isPharmacist = user?.role === 'pharmacist' || user?.role === 'cashier' || isOwner;

  return (
    <>
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-40">
        <div className="flex items-center justify-between px-4 py-3">
          {/* Left side - Logo and menu */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowMobileMenu(!showMobileMenu)}
              className="lg:hidden p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
            >
              {showMobileMenu ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>

            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <ShieldCheck className="h-5 w-5 text-white" />
              </div>
              <span className="font-black text-lg text-slate-900 dark:text-white hidden sm:block">
                فارما تيك (محلي)
              </span>
            </div>
          </div>

          {/* Center - Shift status for pharmacists */}
          {isPharmacist && currentShift && (
            <div className="hidden md:flex items-center gap-6 px-6 py-2 bg-emerald-50 dark:bg-emerald-900/10 rounded-2xl border border-emerald-100 dark:border-emerald-800/30 animate-in fade-in duration-500">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                  الشفت الحالي: {formatTime(currentShift.shift_start)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-black text-slate-700 dark:text-slate-300">
                  الرصيد الافتتاحي: {formatCurrency(currentShift.starting_cash_amount)}
                </span>
              </div>
            </div>
          )}

          {/* Right side - User info and actions */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2">
               <NetworkStatus />
               <SyncStatus />
            </div>

            <div className="flex items-center gap-3 pl-3 border-l border-slate-200 dark:border-slate-700">
              <div className="hidden sm:block text-right">
                <p className="text-sm font-black text-slate-900 dark:text-white">
                  {user?.full_name || user?.username}
                </p>
                <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
                  {user?.role === 'owner' ? 'المالك' :
                   user?.role === 'admin' ? 'مدير' :
                   user?.role === 'pharmacist' ? 'صيدلي' : 'كاشير'}
                </p>
              </div>

              <div className="w-10 h-10 bg-slate-100 dark:bg-slate-800 rounded-xl flex items-center justify-center">
                <User className="w-5 h-5 text-slate-400" />
              </div>

              <button
                onClick={() => setShowLogoutModal(true)}
                className="p-2.5 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-xl transition-all group"
                title="تسجيل الخروج"
              >
                <LogOut className="w-5 h-5 text-red-600 group-hover:scale-110 transition-transform" />
              </button>
            </div>
          </div>
        </div>

        {/* Mobile shift status */}
        {isPharmacist && currentShift && (
          <div className="md:hidden px-4 pb-3">
            <div className="flex items-center justify-between p-3 bg-emerald-50 dark:bg-emerald-900/10 rounded-xl">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                  {formatTime(currentShift.shift_start)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-black text-slate-700 dark:text-slate-300">
                  {formatCurrency(currentShift.starting_cash_amount)}
                </span>
              </div>
            </div>
          </div>
        )}
      </header>

      <LogoutModal isOpen={showLogoutModal} onClose={() => setShowLogoutModal(false)} />
    </>
  );
}

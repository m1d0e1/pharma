'use client'

import React, { useState, useEffect, useRef } from 'react'
import { Bell, AlertTriangle, Clock, Ban, ChevronLeft, Package, Check } from 'lucide-react'
import { getInventoryAlertsAction } from '@/app/actions/inventory'
import { cn } from '@/lib/utils'
import Link from 'next/link'

export default function HeaderAlerts() {
  const [isOpen, setIsOpen] = useState(false)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const [dismissedAlerts, setDismissedAlerts] = useState<string[]>([])

  const fetchAlerts = async () => {
    const res = await getInventoryAlertsAction()
    if (res.success) {
      setData(res.data)
    }
    setLoading(false)
  }

  useEffect(() => {
    const saved = localStorage.getItem('pharma_dismissed_alerts')
    if (saved) {
      try {
        setDismissedAlerts(JSON.parse(saved))
      } catch (e) {}
    }
    fetchAlerts()
    const interval = setInterval(fetchAlerts, 60000 * 5) // Every 5 mins
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const dismissAlert = (alertKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const newDismissed = [...dismissedAlerts, alertKey]
    setDismissedAlerts(newDismissed)
    localStorage.setItem('pharma_dismissed_alerts', JSON.stringify(newDismissed))
  }

  const activeAlerts = data?.alerts?.filter((alert: any) => !dismissedAlerts.includes(`${alert.id}-${alert.alert_type}`)) || []
  const totalCount = activeAlerts.length

  return (
    <div className="relative" ref={dropdownRef}>
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "relative p-3 rounded-2xl transition-all duration-300 hover:shadow-md group",
          isOpen ? "bg-primary-50 dark:bg-primary-900/20 text-primary-600" : "hover:bg-slate-100/80 dark:hover:bg-slate-800/80 text-slate-700 dark:text-slate-300"
        )}
      >
        <Bell className={cn("w-6 h-6", isOpen && "text-primary-600 dark:text-primary-400")} />
        {totalCount > 0 && (
          <>
            <span className="absolute top-2.5 left-2.5 w-2.5 h-2.5 bg-rose-500 rounded-full animate-pulse ring-2 ring-white dark:ring-slate-900" />
            <span className="absolute -top-1 -right-1 bg-rose-500 text-white text-[10px] font-black w-5 h-5 rounded-full flex items-center justify-center border-2 border-white dark:border-slate-900 shadow-sm">
              {totalCount}
            </span>
          </>
        )}
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-4 w-[380px] bg-white dark:bg-slate-900 rounded-[32px] shadow-2xl border border-slate-100 dark:border-slate-800 overflow-hidden z-50 animate-in fade-in slide-in-from-top-4 duration-300">
          {/* Header */}
          <div className="p-6 border-b border-slate-50 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20">
            <div className="flex items-center justify-between">
              <h3 className="font-black text-slate-900 dark:text-white flex items-center gap-2">
                التنبيهات الذكية
                <span className="px-2 py-0.5 bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 text-[10px] rounded-full font-black">
                  {totalCount} تنبيه
                </span>
              </h3>
              <button 
                onClick={fetchAlerts}
                className="text-[10px] font-black text-primary-600 hover:underline uppercase tracking-widest"
              >
                تحديث الآن
              </button>
            </div>
          </div>

          {/* List */}
          <div className="max-h-[400px] overflow-y-auto">
            {loading ? (
              <div className="p-12 text-center">
                <div className="w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                <p className="text-slate-400 text-xs font-bold">جاري تحميل التنبيهات...</p>
              </div>
            ) : totalCount === 0 ? (
              <div className="p-12 text-center">
                <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800/50 rounded-3xl flex items-center justify-center text-3xl mx-auto mb-4 opacity-30">
                  🎉
                </div>
                <p className="text-slate-900 dark:text-white font-black">لا توجد تنبيهات حالياً</p>
                <p className="text-slate-400 text-xs mt-1 font-bold">كل شيء في المخزون يبدو مثالياً!</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-50 dark:divide-slate-800">
                {activeAlerts.map((alert: any) => {
                  const alertKey = `${alert.id}-${alert.alert_type}`;
                  const searchTerm = alert.barcode || alert.trade_name_en || alert.trade_name || '';
                  
                  return (
                    <div key={alertKey} className="relative group hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <Link 
                        href={`/inventory?search=${encodeURIComponent(searchTerm)}`}
                        onClick={(e) => {
                          setIsOpen(false);
                          if (!dismissedAlerts.includes(alertKey)) {
                            const newDismissed = [...dismissedAlerts, alertKey];
                            setDismissedAlerts(newDismissed);
                            localStorage.setItem('pharma_dismissed_alerts', JSON.stringify(newDismissed));
                          }
                        }}
                        className="p-5 flex gap-4 w-full text-right"
                      >
                        <div className={cn(
                          "w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-inner",
                          alert.alert_type === 'expired' ? "bg-rose-100 dark:bg-rose-900/30 text-rose-600" :
                          alert.alert_type === 'expiring' ? "bg-amber-100 dark:bg-amber-900/30 text-amber-600" :
                          "bg-primary-100 dark:bg-primary-900/30 text-primary-600"
                        )}>
                          {alert.alert_type === 'expired' ? <Ban className="w-6 h-6" /> :
                           alert.alert_type === 'expiring' ? <Clock className="w-6 h-6" /> :
                           <Package className="w-6 h-6" />}
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                          <p className="text-sm font-black text-slate-900 dark:text-white truncate">
                            {alert.trade_name_en || alert.trade_name}
                          </p>
                          <p className="text-xs text-slate-500 font-bold mt-1">
                            {alert.alert_type === 'expired' ? `منتهي الصلاحية (${alert.expiry_date})` :
                             alert.alert_type === 'expiring' ? `سينتهي قريباً (${alert.expiry_date})` :
                             `كمية منخفضة: ${alert.quantity} فقط`}
                          </p>
                        </div>
                      </Link>
                      
                      {/* Mark as read button (for quick dismiss without navigating) */}
                      <div className="absolute left-5 top-1/2 -translate-y-1/2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button 
                          onClick={(e) => dismissAlert(alertKey, e)}
                          title="تحديد كمقروء وإخفاء"
                          className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:bg-emerald-500 hover:text-white transition-colors flex items-center justify-center shadow-sm"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <Link 
            href="/inventory"
            onClick={() => setIsOpen(false)}
            className="block p-5 bg-slate-50 dark:bg-slate-800/40 text-center text-xs font-black text-slate-600 dark:text-slate-400 hover:text-primary-600 transition-colors border-t border-slate-100 dark:border-slate-800"
          >
            مشاهدة جميع تنبيهات المخزون
          </Link>
        </div>
      )}
    </div>
  )
}

'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { subDays, format } from 'date-fns';
import {
  Package,
  Users,
  ShoppingCart,
  DollarSign,
  Calendar,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { getClientSession } from '@/lib/auth/local';
import { dbSelect, dbGet } from '@/lib/db/tauri';

const ExpiryWidget = dynamic(() => import('@/components/dashboard/ExpiryWidget'));
const DeadStockWidget = dynamic(() => import('@/components/dashboard/DeadStockWidget'));
const ReorderAlerts = dynamic(() => import('@/components/dashboard/ReorderAlerts'));
const ShiftManagement = dynamic(() => import('@/components/dashboard/ShiftManagement'));
const SubscriptionStatus = dynamic(() => import('@/components/dashboard/SubscriptionStatus'));
const DrugSyncButton = dynamic(() => import('@/components/dashboard/DrugSyncButton'));
const CloudStatus = dynamic(() => import('@/components/dashboard/CloudStatus'));
const DashboardCharts = dynamic(() => import('@/components/dashboard/DashboardCharts').then(mod => mod.DashboardCharts));

export default function DashboardPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [masterDrugCount, setMasterDrugCount] = useState(0);
  const [stats, setStats] = useState<any[]>([]);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [topItemsData, setTopItemsData] = useState<any[]>([]);
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [isPharmacist, setIsPharmacist] = useState(false);
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    setIsTauri(typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined));
    async function loadDashboardData() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;

        setUser(localUser);
        const owner = localUser.role === 'owner' || localUser.role === 'admin';
        const pharmacist = localUser.role === 'pharmacist';
        setIsOwner(owner);
        setIsPharmacist(pharmacist);

        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const startOfDay = todayStr + ' 00:00:00';
        const endOfDay = todayStr + ' 23:59:59';

        // 1. Fetch total master drugs
        const drugCountRow = await dbGet('SELECT COUNT(*) as count FROM master_drugs');
        setMasterDrugCount(drugCountRow?.count || 0);

        // 2. Fetch KPIs
        // Sales today + COGS today
        const salesTodayRow = await dbGet(`
          SELECT COALESCE(SUM(total_amount), 0) as total,
                 (SELECT COALESCE(SUM(quantity_sold * cost_price), 0) 
                  FROM sales_items 
                  WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE created_at >= ? AND created_at <= ? AND status = 'completed')) as total_cogs
          FROM sales_invoices
          WHERE created_at >= ? AND created_at <= ? AND status = 'completed'
        `, [startOfDay, endOfDay, startOfDay, endOfDay]);

        // Current liquidity
        const cashAccRow = await dbGet("SELECT account_id FROM trial_balance_settings WHERE category = 'cash_drawer'");
        const cashAccId = cashAccRow?.account_id || 6;
        const liquidityRow = await dbGet(`
          SELECT COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE -amount END), 0) as balance
          FROM journal_entries
          WHERE account_id = ?
        `, [cashAccId]);

        // Pending delivery cash
        const pendingDeliveryRow = await dbGet(`
          SELECT COALESCE(SUM(total_amount), 0) as total
          FROM sales_invoices
          WHERE payment_method = 'delivery' AND status = 'completed'
        `);

        // Shrinkage today
        const shrinkageRow = await dbGet(`
          SELECT COALESCE(SUM((old_quantity - new_quantity) * i.cost_price), 0) as total_loss
          FROM stock_adjustments sa
          JOIN inventory i ON sa.inventory_id = i.id
          WHERE sa.created_at >= ? AND sa.created_at <= ? AND new_quantity < old_quantity
        `, [startOfDay, endOfDay]);

        // Stock alerts
        const alertsRow = await dbGet(`
          SELECT COUNT(*) as count
          FROM inventory i
          JOIN master_drugs m ON i.drug_id = m.id
          WHERE i.quantity <= COALESCE(
            NULLIF(m.reorder_point, 0),
            (
              SELECT COALESCE(SUM(si.quantity_sold), 0)
              FROM sales_items si
              JOIN sales_invoices inv ON si.invoice_id = inv.id
              WHERE si.drug_id = i.drug_id
                AND si.is_negative = 0
                AND inv.created_at >= datetime('now', '-30 days', 'localtime')
            ),
            10
          )
        `);

        const kpis = {
          sales_today: salesTodayRow?.total || 0,
          pending_delivery_cash: pendingDeliveryRow?.total || 0,
          shrinkage_today: shrinkageRow?.total_loss || 0,
          stock_alerts_count: alertsRow?.count || 0
        };

        const revenueChange = 12.5;

        setStats([
          {
            title: 'إيرادات اليوم',
            value: `ج.م ${kpis.sales_today.toLocaleString('ar-EG')}`,
            change: revenueChange,
            icon: DollarSign,
            color: 'primary',
            trend: revenueChange >= 0 ? 'up' : 'down'
          },
          {
            title: 'سيولة المناديب',
            value: `ج.م ${kpis.pending_delivery_cash.toLocaleString('ar-EG')}`,
            change: 0,
            icon: ShoppingCart,
            color: 'success',
            trend: 'up'
          },
          {
            title: 'عجز المخزون (اليوم)',
            value: `ج.م ${kpis.shrinkage_today.toLocaleString('ar-EG')}`,
            change: 0,
            icon: Package,
            color: 'warning',
            trend: 'down'
          },
          {
            title: 'تنبيهات المخزون',
            value: kpis.stock_alerts_count.toString(),
            change: 0,
            icon: Users,
            color: 'info',
            trend: 'down'
          }
        ]);

        // 3. Fetch Trend Data (Past 30 days recursive dates)
        const trend = await dbSelect(`
          WITH RECURSIVE dates(date) AS (
            SELECT date('now', '-29 days', 'localtime')
            UNION ALL
            SELECT date(date, '+1 day')
            FROM dates
            WHERE date < date('now', 'localtime')
          )
          SELECT 
            d.date,
            (SELECT COALESCE(SUM(total_amount), 0) FROM sales_invoices WHERE date(created_at) = d.date AND status = 'completed') as sales,
            (SELECT COALESCE(SUM(total_refund), 0) FROM returns WHERE date(created_at) = d.date AND status = 'approved') as returns,
            (SELECT COALESCE(SUM(quantity_sold * cost_price), 0) FROM sales_items WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE date(created_at) = d.date AND status = 'completed')) as cogs
          FROM dates d
          ORDER BY d.date ASC
        `);
        setTrendData(trend || []);

        // 3.5 Fetch Top Selling Items (Past 30 days)
        const topItems = await dbSelect(`
          SELECT 
            m.trade_name_en as name,
            SUM(si.quantity_sold) as quantity,
            SUM(si.quantity_sold * si.unit_price) as revenue
          FROM sales_items si
          JOIN sales_invoices s ON si.invoice_id = s.id
          JOIN inventory i ON si.inventory_id = i.id
          JOIN master_drugs m ON i.drug_id = m.id
          WHERE s.created_at >= date('now', '-30 days', 'localtime')
            AND s.status = 'completed'
          GROUP BY i.drug_id, m.trade_name_en
          ORDER BY quantity DESC
          LIMIT 5
        `);
        setTopItemsData(topItems || []);

        // 4. Fetch Recent Transactions
        const recent = await dbSelect(`
          SELECT s.*, p.full_name as patient_name
          FROM sales_invoices s
          LEFT JOIN patients p ON s.patient_id = p.id
          ORDER BY s.created_at DESC
          LIMIT 5
        `);
        setRecentTransactions(recent || []);

        // 5. Fetch Activity Logs (If Owner)
        if (owner) {
          const logs = await dbSelect(`
            SELECT a.*, u.full_name 
            FROM activity_log a 
            JOIN users u ON a.user_id = u.id 
            ORDER BY a.created_at DESC 
            LIMIT 5
          `);
          setActivityLogs(logs || []);
        }
      } catch (err) {
        console.error('Failed to load dashboard data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadDashboardData();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-slate-500 font-medium">جاري تحميل لوحة التحكم...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-12 md:space-y-14 animate-in slide-in-up" dir="rtl">
      {/* Page Header */}
      <div className="page-header flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">لوحة التحكم الرئيسية (محلي)</h1>
          <p className="text-slate-500 mt-1">نظرة شاملة على أداء صيدليتك من قاعدة البيانات المحلية</p>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 w-full md:w-auto">
          {isTauri && (
            <button 
              onClick={async () => {
                try {
                  const { emit } = await import('@tauri-apps/api/event');
                  await emit('menu-action', 'update');
                } catch (e) {
                  console.error(e);
                }
              }} 
              className="flex items-center gap-2 bg-indigo-600 text-white hover:bg-indigo-700 px-4 py-2.5 rounded-xl font-bold shadow-md transition-all active:scale-95"
            >
              <ArrowUpRight className="w-4 h-4" />
              تحديث البرنامج
            </button>
          )}
          <CloudStatus initialSession={null} />
          <div className="px-5 py-3 bg-white/50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-800 backdrop-blur-sm">
            <p className="text-sm font-bold text-slate-600 dark:text-slate-400">
              <Package className="inline w-4 h-4 ml-2 text-blue-500" />
              الأدوية في الدليل: <span className="text-blue-600 dark:text-blue-400 text-lg">{masterDrugCount.toLocaleString()}</span>
            </p>
          </div>
          <DrugSyncButton />
          <div className="px-5 py-3 bg-gradient-to-r from-primary-500/10 to-primary-600/10 dark:from-primary-900/30 dark:to-primary-800/30 rounded-xl border border-primary-200/50 dark:border-primary-800/50 backdrop-blur-sm w-full sm:w-auto">
            <p className="text-sm md:text-base font-medium text-primary-700 dark:text-primary-300 flex items-center justify-center sm:justify-start">
              <Calendar className="inline w-4 h-4 ml-2" />
              {new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-7">
        {stats.map((stat, index) => {
          const Icon = stat.icon;
          const isLowStock = stat.title === 'تنبيهات المخزون';
          
          const colorMap: Record<string, string> = {
            success: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 border-emerald-100',
            info: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 border-blue-100',
            warning: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-500/10 border-orange-100',
            danger: 'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-500/10 border-rose-100'
          };
          
          const gradientMap: Record<string, string> = {
            success: 'from-emerald-50/50 to-white dark:from-emerald-950/20 dark:to-slate-900',
            info: 'from-blue-50/50 to-white dark:from-blue-950/20 dark:to-slate-900',
            warning: 'from-orange-50/50 to-white dark:from-orange-950/20 dark:to-slate-900',
            danger: 'from-rose-50/50 to-white dark:from-rose-950/20 dark:to-slate-900'
          };

          const themeClasses = colorMap[stat.color] || colorMap.info;
          const bgGradient = gradientMap[stat.color] || gradientMap.info;
          const textIconColor = themeClasses.split(' ').find(c => c.startsWith('text-'));
          const bgIconColor = themeClasses.split(' ').find(c => c.startsWith('bg-'));
          
          const CardContent = (
            <div className={`stat-card-interactive relative overflow-hidden group h-full bg-gradient-to-br ${bgGradient} p-6 rounded-3xl border border-slate-100/50 dark:border-slate-800/50 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300`}>
               <div className={`absolute -right-4 -top-4 w-24 h-24 rounded-full blur-2xl opacity-50 ${bgIconColor}`} />
               <div className="relative flex items-start justify-between z-10">
                <div className="flex-1 col-span-3">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-bold text-slate-600 dark:text-slate-300">{stat.title}</p>
                    <div className={`p-3 rounded-2xl ${bgIconColor} group-hover:scale-110 group-hover:rotate-3 transition-transform duration-300 shadow-sm`}>
                      <Icon className={`w-5 h-5 ${textIconColor}`} />
                    </div>
                  </div>
                  <p className="text-3xl font-black tracking-tight text-slate-900 dark:text-white drop-shadow-sm">{stat.value}</p>
                  <div className="flex items-center gap-3 mt-6">
                    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg \${stat.trend === 'up' ? 'text-emerald-700 bg-emerald-100 dark:bg-emerald-500/20 dark:text-emerald-400' : 'text-rose-700 bg-rose-100 dark:bg-rose-500/20 dark:text-rose-400'}`}>
                      {stat.trend === 'up' ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
                      <span className="text-xs font-bold">{stat.change >= 0 ? '+' : ''}{stat.change.toFixed(1)}%</span>
                    </div>
                    <span className="text-xs font-medium text-slate-400">من الأمس</span>
                  </div>
                </div>
              </div>
            </div>
          );

          if (isLowStock) {
            return (
              <Link key={index} href="/inventory/low-stock" className="block">
                {CardContent}
              </Link>
            );
          }

          return <div key={index}>{CardContent}</div>;
        })}
      </div>

      {/* Advanced PMS Features: Inventory Alerts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-7">
        <ExpiryWidget />
        <DeadStockWidget />
      </div>

      {/* Auto-Reorder Alerts */}
      <ReorderAlerts />

      {/* Management Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-7">
        {(isPharmacist || isOwner) && <ShiftManagement />}
        {isOwner && <SubscriptionStatus />}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Link href="/pos" className="flex items-center gap-4 p-5 bg-white dark:bg-slate-800 rounded-[2rem] shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all border border-slate-100 dark:border-slate-800 group">
          <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center text-blue-600 group-hover:scale-110 transition-transform">
            <ShoppingCart className="w-6 h-6" />
          </div>
          <div>
            <p className="font-black text-slate-900 dark:text-white">نقطة البيع</p>
            <p className="text-[10px] text-slate-500">بيع سريع</p>
          </div>
        </Link>

        <Link href="/inventory" className="flex items-center gap-4 p-5 bg-white dark:bg-slate-800 rounded-[2rem] shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all border border-slate-100 dark:border-slate-800 group">
          <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center text-emerald-600 group-hover:scale-110 transition-transform">
            <Package className="w-6 h-6" />
          </div>
          <div>
            <p className="font-black text-slate-900 dark:text-white">المخزون</p>
            <p className="text-[10px] text-slate-500">إدارة الأصناف</p>
          </div>
        </Link>

        <Link href="/patients" className="flex items-center gap-4 p-5 bg-white dark:bg-slate-800 rounded-[2rem] shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all border border-slate-100 dark:border-slate-800 group">
          <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-2xl flex items-center justify-center text-purple-600 group-hover:scale-110 transition-transform">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <p className="font-black text-slate-900 dark:text-white">المرضى</p>
            <p className="text-[10px] text-slate-500">سجل العملاء</p>
          </div>
        </Link>

        <Link href="/reports" className="flex items-center gap-4 p-5 bg-white dark:bg-slate-800 rounded-[2rem] shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all border border-slate-100 dark:border-slate-800 group">
          <div className="w-12 h-12 bg-orange-100 dark:bg-orange-900/30 rounded-2xl flex items-center justify-center text-orange-600 group-hover:scale-110 transition-transform">
            <ArrowUpRight className="w-6 h-6" />
          </div>
          <div>
            <p className="font-black text-slate-900 dark:text-white">التقارير</p>
            <p className="text-[10px] text-slate-500">تحليل الأداء</p>
          </div>
        </Link>
      </div>

      {/* Charts & Widgets Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-7">
        <div className="lg:col-span-2">
          <div className="space-y-6">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">تحليل أداء المبيعات والنمو</h2>
            <DashboardCharts trendData={trendData} topItemsData={topItemsData} />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">أحدث المعاملات المحلية</h2>
          <div className="space-y-4">
            {recentTransactions.length > 0 ? recentTransactions.map((transaction) => (
              <div key={transaction.id} className="flex items-center justify-between p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                <div>
                  <p className="font-bold text-sm">{transaction.patient_name || 'زائر'}</p>
                  <p className="text-xs text-slate-500">{new Date(transaction.created_at).toLocaleTimeString('ar-EG')}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-blue-600 dark:text-blue-400 text-sm">ج.م {transaction.total_amount}</p>
                </div>
              </div>
            )) : (
              <p className="text-center text-slate-400 py-8 text-sm">لا توجد معاملات بعد</p>
            )}
          </div>
          
          {isOwner && activityLogs.length > 0 && (
            <div className="mt-8 pt-8 border-t border-slate-100 dark:border-slate-800">
              <h2 className="text-sm font-bold text-slate-400 mb-3">سجل النشاط المحلي (الأونر)</h2>
              <div className="space-y-3">
                {activityLogs.map((log: any) => (
                  <div key={log.id} className="text-xs flex items-start gap-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                    <span className="font-black text-blue-600 dark:text-blue-400 shrink-0">{log.action}</span>
                    <span className="text-slate-600 dark:text-slate-300">{log.details}</span>
                    <span className="mr-auto text-slate-400 whitespace-nowrap">{format(new Date(log.created_at), 'HH:mm')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

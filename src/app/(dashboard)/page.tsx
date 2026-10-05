'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { subDays, format } from 'date-fns';
import {
  Package,
  Users,
  ShoppingCart,
  DollarSign,
  Calendar,
  ArrowUpLeft,
  ArrowDownLeft,
  Megaphone,
} from 'lucide-react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { dbSelect, dbGet } from '@/lib/db/tauri';
import { isTauri as isTauriRuntime } from '@/lib/env';

const ExpiryWidget = dynamic(() => import('@/components/dashboard/ExpiryWidget'));
const DeadStockWidget = dynamic(() => import('@/components/dashboard/DeadStockWidget'));
const ReorderAlerts = dynamic(() => import('@/components/dashboard/ReorderAlerts'));
const ShiftManagement = dynamic(() => import('@/components/dashboard/ShiftManagement'));
const SubscriptionStatus = dynamic(() => import('@/components/dashboard/SubscriptionStatus'));
const DrugSyncButton = dynamic(() => import('@/components/dashboard/DrugSyncButton'));
const InteractionsSyncButton = dynamic(() => import('@/components/dashboard/InteractionsSyncButton'));
const NewsBar = dynamic(() => import('@/components/dashboard/NewsBar'), { ssr: false });
const DashboardCharts = dynamic(() => import('@/components/dashboard/DashboardCharts').then(mod => mod.DashboardCharts));
const ReceiptDetailsModal = dynamic(() => import('@/components/receipts/ReceiptDetailsModal'), { ssr: false });

import { getInvoiceDetailsAction } from '@/app/actions-client/sales-reports';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { toast } from 'react-hot-toast';

export default function DashboardPage() {
  const [user, setUser] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [kpiData, setKpiData] = useState<any[]>([]);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [topItemsData, setTopItemsData] = useState<any[]>([]);
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [masterDrugCount, setMasterDrugCount] = useState(0);
  const [canManageSettings, setCanManageSettings] = useState(false);
  
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<any[]>([]);
  const [loadingReceipt, setLoadingReceipt] = useState(false);
  const dashboardLoadRequestRef = useRef(0);
  const invoiceDetailsRequestRef = useRef(0);
  const [isPharmacist, setIsPharmacist] = useState(false);
  const [isTauri, setIsTauri] = useState(false);
  const [newsBarEnabled, setNewsBarEnabled] = useState(true);
  const canAccessPos = hasUserPermissionSync(user, 'can_access_pos');
  const canViewShifts = hasUserPermissionSync(user, 'can_view_shifts');
  const canViewAudit = hasUserPermissionSync(user, 'can_view_audit');
  const canViewInventory = hasUserPermissionSync(user, 'can_view_stores');
  const canViewLowStock = hasUserPermissionSync(user, 'can_view_low_stock');
  const canViewRestock = hasUserPermissionSync(user, 'can_view_restock');
  const canViewPurchases = hasUserPermissionSync(user, 'can_view_purchases');
  const canViewPatients = hasUserPermissionSync(user, 'can_view_patients');
  const canViewReports = hasUserPermissionSync(user, 'rep_can_view_sales');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setNewsBarEnabled(localStorage.getItem('news_bar_enabled') !== 'false');
      
      const handleStateChange = () => {
        setNewsBarEnabled(localStorage.getItem('news_bar_enabled') !== 'false');
      };
      window.addEventListener('news-bar-state-changed', handleStateChange);
      return () => {
        window.removeEventListener('news-bar-state-changed', handleStateChange);
      };
    }
  }, []);

  useEffect(() => () => {
    dashboardLoadRequestRef.current += 1;
    invoiceDetailsRequestRef.current += 1;
  }, []);

  const toggleNewsBar = () => {
    const nextState = !newsBarEnabled;
    localStorage.setItem('news_bar_enabled', nextState.toString());
    if (nextState) {
      localStorage.removeItem('news_dismissed_id');
    }
    setNewsBarEnabled(nextState);
    window.dispatchEvent(new Event('news-bar-toggle'));
  };

  const loadDashboardData = useCallback(async () => {
    const requestId = ++dashboardLoadRequestRef.current;
    const log = (m: string) => typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__?.invoke('log_frontend_error', { message: m });
    setLoading(true);
    setLoadError(false);
    try {
        log('PAGE: loadDashboardData start');
        const localUser = await getClientSession();
        if (requestId !== dashboardLoadRequestRef.current) return;
        log('PAGE: loadDashboardData user=' + (localUser ? localUser.username : 'NULL'));
        if (!localUser) {
          setLoadError(true);
          return;
        }

        setUser(localUser);
        const pharmacist = localUser.role === 'pharmacist';
        setCanManageSettings(hasUserPermissionSync(localUser, 'can_view_settings'));
        setIsPharmacist(pharmacist);

        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const yesterdayStr = format(subDays(new Date(), 1), 'yyyy-MM-dd');
        const pharmacyId = localUser.pharmacy_id || 'local_default';

        // 1. Fetch total master drugs
        const drugCountRow = await dbGet('SELECT COUNT(*) as count FROM master_drugs');
        if (requestId !== dashboardLoadRequestRef.current) return;
        setMasterDrugCount(drugCountRow?.count || 0);

        if (!hasUserPermissionSync(localUser, 'rep_can_view_sales')) {
          setStats([]);
          setTrendData([]);
          setTopItemsData([]);
          setRecentTransactions([]);
          return;
        }

        // 2. Fetch KPIs
        // Sales today + COGS today
        const salesTodayRow = await dbGet(`
          SELECT COALESCE(SUM(total_amount), 0) as total,
                 (SELECT COALESCE(SUM(
                    CASE 
                      WHEN (si.unit IN ('medium', 'strip', 'شريط') OR si.unit = md.medium_unit) AND COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1) > 0
                        THEN (si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1)) * si.cost_price
                      WHEN (si.unit = 'small' OR si.unit = md.small_unit) AND (
                        COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1)
                        * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1)
                      ) > 0
                        THEN (
                          si.quantity_sold / (
                            COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1)
                            * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1)
                          )
                        ) * si.cost_price
                      ELSE si.quantity_sold * si.cost_price
                    END
                  ), 0) 
                  FROM sales_items si
                  LEFT JOIN master_drugs md ON si.drug_id = md.id
                  WHERE si.invoice_id IN (
                    SELECT id FROM sales_invoices
                    WHERE date(created_at, 'localtime') = ?
                      AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
                      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
                  )) as total_cogs
          FROM sales_invoices
          WHERE date(created_at, 'localtime') = ?
            AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        `, [todayStr, pharmacyId, pharmacyId, todayStr, pharmacyId, pharmacyId]);
        if (requestId !== dashboardLoadRequestRef.current) return;

        const salesYesterdayRow = await dbGet(`
          SELECT COALESCE(SUM(total_amount), 0) as total
          FROM sales_invoices
          WHERE date(created_at, 'localtime') = ?
            AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        `, [yesterdayStr, pharmacyId, pharmacyId]);
        if (requestId !== dashboardLoadRequestRef.current) return;

        // Current liquidity
        const cashAccRow = await dbGet("SELECT account_id FROM trial_balance_settings WHERE category = 'cash_drawer'");
        if (requestId !== dashboardLoadRequestRef.current) return;
        const cashAccId = cashAccRow?.account_id || 6;
        const liquidityRow = await dbGet(`
          SELECT COALESCE(SUM(CASE WHEN je.type = 'debit' THEN je.amount ELSE -je.amount END), 0) as balance
          FROM journal_entries je
          JOIN daily_journals dj ON dj.id = je.journal_id
          WHERE je.account_id = ?
            AND (dj.pharmacy_id = ? OR (dj.pharmacy_id IS NULL AND ? = 'local_default'))
        `, [cashAccId, pharmacyId, pharmacyId]);
        if (requestId !== dashboardLoadRequestRef.current) return;

        // Pending delivery cash
        const pendingDeliveryRow = await dbGet(`
          SELECT COALESCE(SUM(total_amount), 0) as total
          FROM sales_invoices
          WHERE payment_method = 'delivery' AND status = 'completed'
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        `, [pharmacyId, pharmacyId]);
        if (requestId !== dashboardLoadRequestRef.current) return;

        // Shrinkage today
        const shrinkageRow = await dbGet(`
          SELECT COALESCE(SUM((old_quantity - new_quantity) * i.cost_price), 0) as total_loss
          FROM stock_adjustments sa
          JOIN inventory i ON sa.inventory_id = i.id
          WHERE date(sa.created_at, 'localtime') = ? AND new_quantity < old_quantity
            AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
        `, [todayStr, pharmacyId, pharmacyId]);
        if (requestId !== dashboardLoadRequestRef.current) return;

        // Keep this KPI on the same pharmacy-scoped, expiry-aware source as the
        // reorder widget and low-stock page so all three surfaces stay in sync.
        const lowStockResult = await getLowStockAction(10);
        if (requestId !== dashboardLoadRequestRef.current) return;
        const lowStockRows = lowStockResult.success && Array.isArray(lowStockResult.data)
          ? lowStockResult.data
          : [];
        const stockAlertsCount = lowStockResult.success
          ? ('totalCount' in lowStockResult ? Number(lowStockResult.totalCount) : lowStockRows.length)
          : 0;

        const kpis = {
          sales_today: salesTodayRow?.total || 0,
          pending_delivery_cash: pendingDeliveryRow?.total || 0,
          shrinkage_today: shrinkageRow?.total_loss || 0,
          stock_alerts_count: stockAlertsCount
        };

        const todayRevenue = Number(kpis.sales_today || 0);
        const yesterdayRevenue = Number(salesYesterdayRow?.total || 0);
        const revenueChange = yesterdayRevenue > 0
          ? ((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100
          : null;
        const revenueComparisonText = yesterdayRevenue > 0
          ? null
          : (todayRevenue > 0 ? 'مبيعات أولية اليوم' : 'لا توجد مبيعات اليوم أو أمس');

        setStats([
          {
            title: 'إيرادات اليوم',
            value: `ج.م ${kpis.sales_today.toLocaleString('ar-EG')}`,
            change: revenueChange,
            comparisonText: revenueComparisonText,
            icon: DollarSign,
            color: 'primary',
            trend: revenueChange === null || revenueChange >= 0 ? 'up' : 'down'
          },
          {
            title: 'سيولة المناديب',
            value: `ج.م ${kpis.pending_delivery_cash.toLocaleString('ar-EG')}`,
            change: null,
            icon: ShoppingCart,
            color: 'success',
            trend: 'up'
          },
          {
            title: 'عجز المخزون (اليوم)',
            value: `ج.م ${kpis.shrinkage_today.toLocaleString('ar-EG')}`,
            change: null,
            icon: Package,
            color: 'warning',
            trend: 'down'
          },
          {
            title: 'تنبيهات المخزون',
            value: kpis.stock_alerts_count.toString(),
            change: null,
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
            (SELECT COALESCE(SUM(total_amount), 0) FROM sales_invoices WHERE date(created_at, 'localtime') = d.date AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered')) AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))) as sales,
            (SELECT COALESCE(SUM(total_refund), 0) FROM returns r WHERE date(r.created_at, 'localtime') = d.date AND LOWER(COALESCE(status, '')) IN ('approved', 'completed') AND (r.pharmacy_id = ? OR (r.pharmacy_id IS NULL AND ? = 'local_default'))) as returns,
            (SELECT COALESCE(SUM(
               CASE
                 WHEN (si.unit IN ('medium', 'strip', 'شريط') OR si.unit = m.medium_unit) AND COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1) > 0
                   THEN (
                     si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)
                   ) * COALESCE(NULLIF(si.cost_price, 0), i.cost_price, m.base_price, 0)
                 WHEN (si.unit = 'small' OR si.unit = m.small_unit) AND (
                   COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)
                   * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1)
                 ) > 0
                   THEN (
                     si.quantity_sold / (
                       COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)
                       * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1)
                     )
                   ) * COALESCE(NULLIF(si.cost_price, 0), i.cost_price, m.base_price, 0)
                 ELSE si.quantity_sold * COALESCE(NULLIF(si.cost_price, 0), i.cost_price, m.base_price, 0)
               END
             ), 0)
             FROM sales_items si 
             LEFT JOIN inventory i ON si.inventory_id = i.id
             LEFT JOIN master_drugs m ON COALESCE(si.drug_id, i.drug_id) = m.id
             WHERE si.invoice_id IN (SELECT id FROM sales_invoices WHERE date(created_at, 'localtime') = d.date AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered')) AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default')))
            ) - (
              SELECT COALESCE(SUM(
                COALESCE(NULLIF(si.cost_price, 0), i.cost_price, m.base_price, 0) *
                CASE
                  WHEN COALESCE(NULLIF(TRIM(ri.unit), ''), NULLIF(TRIM(si.unit), ''), 'large') IN ('medium', 'strip', 'شريط')
                    OR COALESCE(NULLIF(TRIM(ri.unit), ''), NULLIF(TRIM(si.unit), ''), 'large') = m.medium_unit
                    THEN ri.quantity_returned / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(i.strips_per_box, 0), NULLIF(m.large_to_medium, 0), 1)
                  WHEN COALESCE(NULLIF(TRIM(ri.unit), ''), NULLIF(TRIM(si.unit), ''), 'large') = 'small'
                    OR COALESCE(NULLIF(TRIM(ri.unit), ''), NULLIF(TRIM(si.unit), ''), 'large') = m.small_unit
                    THEN ri.quantity_returned / (
                      COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(i.strips_per_box, 0), NULLIF(m.large_to_medium, 0), 1)
                      * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(i.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1)
                    )
                  ELSE ri.quantity_returned
                END
              ), 0)
              FROM return_items ri
              JOIN returns rr ON rr.id = ri.return_id
              LEFT JOIN sales_items si ON si.id = ri.sale_item_id
              LEFT JOIN inventory i ON i.id = COALESCE(ri.inventory_id, si.inventory_id)
              LEFT JOIN master_drugs m ON m.id = COALESCE(ri.drug_id, si.drug_id, i.drug_id)
              WHERE date(rr.created_at, 'localtime') = d.date
                AND LOWER(COALESCE(rr.status, '')) IN ('approved', 'completed')
                AND (rr.pharmacy_id = ? OR (rr.pharmacy_id IS NULL AND ? = 'local_default'))
            ) as cogs
          FROM dates d
          ORDER BY d.date ASC
        `, [pharmacyId, pharmacyId, pharmacyId, pharmacyId, pharmacyId, pharmacyId, pharmacyId, pharmacyId]);
        if (requestId !== dashboardLoadRequestRef.current) return;
        setTrendData(trend || []);

        // 3.5 Fetch Top Selling Items (Past 30 days)
        const topItems = await dbSelect(`
          SELECT 
            COALESCE(NULLIF(m.trade_name_en, ''), m.trade_name, 'بدون اسم') as name,
            SUM(
              CASE
                WHEN si.unit IN ('medium', 'strip', 'شريط') OR si.unit = m.medium_unit
                  THEN si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)
                WHEN si.unit = 'small' OR si.unit = m.small_unit
                  THEN si.quantity_sold / (
                    COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)
                    * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1)
                  )
                ELSE si.quantity_sold
              END
            ) as quantity,
            SUM(si.quantity_sold * si.unit_price) as revenue
          FROM sales_items si
          JOIN sales_invoices s ON si.invoice_id = s.id
          JOIN inventory i ON si.inventory_id = i.id
          JOIN master_drugs m ON i.drug_id = m.id
          WHERE date(s.created_at, 'localtime') >= date('now', '-29 days', 'localtime')
            AND (s.status IS NULL OR s.status = '' OR s.status IN ('completed', 'approved', 'delivered'))
            AND (s.pharmacy_id = ? OR (s.pharmacy_id IS NULL AND ? = 'local_default'))
          GROUP BY i.drug_id, name
          ORDER BY quantity DESC
          LIMIT 5
        `, [pharmacyId, pharmacyId]);
        if (requestId !== dashboardLoadRequestRef.current) return;
        setTopItemsData(topItems || []);

        // 4. Fetch Recent Transactions
        const recent = await dbSelect(`
          SELECT s.*, p.full_name as patient_name
          FROM sales_invoices s
          LEFT JOIN patients p ON s.patient_id = p.id
          WHERE (s.pharmacy_id = ? OR (s.pharmacy_id IS NULL AND ? = 'local_default'))
            AND (s.status IS NULL OR s.status = '' OR s.status IN ('completed', 'approved', 'delivered'))
          ORDER BY s.created_at DESC
          LIMIT 5
        `, [pharmacyId, pharmacyId]);
        if (requestId !== dashboardLoadRequestRef.current) return;
        setRecentTransactions(recent || []);

        // 5. Fetch Activity Logs (If Owner)
        if (hasUserPermissionSync(localUser, 'can_view_audit')) {
          const logs = await dbSelect(`
            SELECT a.*, u.full_name 
            FROM activity_log a 
            JOIN users u ON a.user_id = u.id 
            WHERE (a.pharmacy_id = ? OR (a.pharmacy_id IS NULL AND ? = 'local_default'))
            ORDER BY a.created_at DESC 
            LIMIT 5
          `, [pharmacyId, pharmacyId]);
          if (requestId !== dashboardLoadRequestRef.current) return;
          setActivityLogs(logs || []);
        }
    } catch (err: any) {
      if (requestId !== dashboardLoadRequestRef.current) return;
      log('PAGE: loadDashboardData error=' + err.message + ' stack=' + err.stack);
      console.error('Failed to load dashboard data:', err);
      setLoadError(true);
    } finally {
      if (requestId === dashboardLoadRequestRef.current) {
        log('PAGE: loadDashboardData finally');
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const log = (m: string) => typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__?.invoke('log_frontend_error', { message: m });
    log('PAGE: mount');
    setIsTauri(isTauriRuntime);
    void loadDashboardData();
  }, [loadDashboardData]);

  if (loading) {
    return (
      <div className="space-y-12 md:space-y-14 animate-in slide-in-up" dir="rtl">
        <div className="page-header">
          <div className="h-9 w-64 bg-slate-200 dark:bg-slate-700 rounded-lg animate-pulse" />
          <div className="h-5 w-96 mt-2 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-7">
          {[1,2,3,4].map(i => (
            <div key={i} className="bg-slate-100 dark:bg-slate-800 p-6 rounded-3xl animate-pulse">
              <div className="flex justify-between mb-4">
                <div className="h-4 w-24 bg-slate-200 dark:bg-slate-700 rounded" />
                <div className="h-12 w-12 bg-slate-200 dark:bg-slate-700 rounded-2xl" />
              </div>
              <div className="h-8 w-32 bg-slate-200 dark:bg-slate-700 rounded mt-2" />
              <div className="h-4 w-20 bg-slate-200 dark:bg-slate-700 rounded mt-6" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-7">
          {[1,2].map(i => (
            <div key={i} className="bg-slate-100 dark:bg-slate-800 p-6 rounded-3xl animate-pulse h-48" />
          ))}
        </div>
        <div className="bg-slate-100 dark:bg-slate-800 p-6 rounded-3xl animate-pulse h-24" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24" dir="rtl">
        <p className="font-black text-rose-600">تعذر تحميل لوحة التحكم</p>
        <button
          type="button"
          onClick={() => void loadDashboardData()}
          className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-12 md:space-y-14 animate-in slide-in-up" dir="rtl">
      <NewsBar />
      {/* Page Header */}
      <div className="page-header flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">لوحة التحكم الرئيسية (محلي)</h1>
          <p className="text-slate-500 mt-1">نظرة شاملة على أداء صيدليتك من قاعدة البيانات المحلية</p>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 w-full md:w-auto">
          {isTauri && (
            <button 
              type="button"
              onClick={async () => {
                try {
                  const { getCurrentWindow } = await import('@tauri-apps/api/window');
                  await getCurrentWindow().emit('menu-action', 'update');
                } catch (e) {
                  console.error(e);
                }
              }} 
              className="flex items-center gap-2 bg-indigo-600 text-white hover:bg-indigo-700 px-4 py-2.5 rounded-xl font-bold shadow-md transition-all active:scale-95"
            >
               <ArrowUpLeft className="w-4 h-4" />
              تحديث البرنامج
            </button>
          )}
          <div className="px-5 py-3 bg-white/50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-800 backdrop-blur-sm">
            <p className="text-sm font-bold text-slate-600 dark:text-slate-400">
              <Package className="inline w-4 h-4 ml-2 text-blue-500" />
              الأدوية في الدليل: <span className="text-blue-600 dark:text-blue-400 text-lg">{masterDrugCount.toLocaleString()}</span>
            </p>
          </div>
          {user?.role === 'owner' && <DrugSyncButton />}
          {user?.role === 'owner' && <InteractionsSyncButton />}
          <button
            type="button"
            onClick={toggleNewsBar}
            aria-pressed={newsBarEnabled}
            className={`
              flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold shadow-md transition-all active:scale-95 border text-sm
              ${newsBarEnabled 
                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 hover:bg-amber-200' 
                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-200'}
            `}
          >
            <Megaphone className="w-4 h-4" />
            {newsBarEnabled ? 'إخفاء الأخبار' : 'عرض الأخبار'}
          </button>
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
          
          const themeClasses = colorMap[stat.color] || colorMap.info;
          const textIconColor = themeClasses.split(' ').find(c => c.startsWith('text-'));
          const bgIconColor = themeClasses.split(' ').find(c => c.startsWith('bg-'));
          
          const CardContent = (
            <div className="stat-card-interactive group h-full p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
               <div className="flex items-start justify-between">
                <div className="flex-1 col-span-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className={`p-2.5 rounded-lg ${bgIconColor}`}>
                      <Icon className={`w-5 h-5 ${textIconColor}`} />
                    </div>
                  </div>
                  <p className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mt-2 tabular-nums">{stat.value}</p>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400 mt-1">{stat.title}</p>
                  {typeof stat.change === 'number' && (
                    <div className="flex items-center gap-3 mt-3">
                      <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg ${stat.trend === 'up' ? 'text-emerald-700 bg-emerald-100 dark:bg-emerald-500/20 dark:text-emerald-400' : 'text-rose-700 bg-rose-100 dark:bg-rose-500/20 dark:text-rose-400'}`}>
                        {stat.trend === 'up' ? <ArrowUpLeft className="w-4 h-4" /> : <ArrowDownLeft className="w-4 h-4" />}
                        <span className="text-xs font-bold">{stat.change >= 0 ? '+' : ''}{stat.change.toFixed(1)}%</span>
                      </div>
                      <span className="text-xs font-medium text-slate-400">من الأمس</span>
                    </div>
                  )}
                  {typeof stat.change !== 'number' && stat.comparisonText && (
                    <p className="text-xs font-medium text-slate-400 mt-3">{stat.comparisonText}</p>
                  )}
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
      {canViewInventory && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-7">
          <ExpiryWidget />
          <DeadStockWidget />
        </div>
      )}

      {/* Auto-Reorder Alerts */}
      {(canViewLowStock || canViewRestock) && (
        <ReorderAlerts
          canViewLowStock={canViewLowStock}
          canViewRestock={canViewRestock}
          canViewPurchases={canViewPurchases}
          canViewInventory={canViewInventory}
        />
      )}

      {/* Management Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-7">
        {canViewShifts && <ShiftManagement />}
        {canManageSettings && <SubscriptionStatus />}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {canAccessPos && <Link href="/pos" className="flex items-center gap-3 p-4 bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 hover:border-blue-300 dark:hover:border-blue-700 transition-colors group">
          <div className="w-10 h-10 bg-blue-50 dark:bg-blue-950/30 rounded-lg flex items-center justify-center text-blue-600">
            <ShoppingCart className="w-5 h-5" />
          </div>
          <div>
            <p className="font-semibold text-slate-900 dark:text-white">نقطة البيع</p>
            <p className="text-xs text-slate-500">بيع سريع</p>
          </div>
        </Link>}

        {canViewInventory && <Link href="/inventory" className="flex items-center gap-3 p-4 bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 hover:border-emerald-300 dark:hover:border-emerald-700 transition-colors group">
          <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg flex items-center justify-center text-emerald-600">
            <Package className="w-5 h-5" />
          </div>
          <div>
            <p className="font-semibold text-slate-900 dark:text-white">المخزون</p>
            <p className="text-xs text-slate-500">إدارة الأصناف</p>
          </div>
        </Link>}

        {canViewPatients && <Link href="/patients" className="flex items-center gap-3 p-4 bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 hover:border-purple-300 dark:hover:border-purple-700 transition-colors group">
          <div className="w-10 h-10 bg-purple-50 dark:bg-purple-950/30 rounded-lg flex items-center justify-center text-purple-600">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <p className="font-semibold text-slate-900 dark:text-white">المرضى</p>
            <p className="text-xs text-slate-500">سجل العملاء</p>
          </div>
        </Link>}

        {canViewReports && <Link href="/reports" className="flex items-center gap-3 p-4 bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 hover:border-amber-300 dark:hover:border-amber-700 transition-colors group">
          <div className="w-10 h-10 bg-orange-50 dark:bg-orange-950/30 rounded-lg flex items-center justify-center text-orange-600">
            <ArrowUpLeft className="w-5 h-5" />
          </div>
          <div>
            <p className="font-semibold text-slate-900 dark:text-white">التقارير</p>
            <p className="text-xs text-slate-500">تحليل الأداء</p>
          </div>
        </Link>}
      </div>

      {/* Charts & Widgets Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-7">
        <div className="lg:col-span-2">
          <div className="space-y-6">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">تحليل أداء المبيعات والنمو</h2>
            <DashboardCharts trendData={trendData} topItemsData={topItemsData} />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">أحدث المعاملات المحلية</h2>
          <div className="space-y-4">
            {recentTransactions.length > 0 ? recentTransactions.map((transaction) => (
              <div 
                key={transaction.id} 
                onClick={async () => {
                  const requestId = ++invoiceDetailsRequestRef.current;
                  setSelectedInvoiceId(transaction.id);
                  setLoadingReceipt(true);
                  try {
                    const res = await getInvoiceDetailsAction(transaction.id);
                    if (requestId !== invoiceDetailsRequestRef.current) return;
                    if (res.success) {
                      setInvoiceItems(res.data || []);
                    } else {
                      toast.error(res.error || 'فشل تحميل تفاصيل الفاتورة');
                      setSelectedInvoiceId(null);
                    }
                  } catch (error) {
                    if (requestId !== invoiceDetailsRequestRef.current) return;
                    console.error('Failed to load dashboard invoice details:', error);
                    toast.error('فشل تحميل تفاصيل الفاتورة');
                    setSelectedInvoiceId(null);
                  } finally {
                    if (requestId === invoiceDetailsRequestRef.current) {
                      setLoadingReceipt(false);
                    }
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.currentTarget.click();
                }}
                role="button"
                tabIndex={0}
                className="flex items-center justify-between p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
              >
                <div>
                  <p className="font-bold text-sm">{transaction.patient_name || 'زائر'}</p>
                  <p className="text-xs text-slate-500">{new Date(transaction.created_at).toLocaleTimeString('ar-EG')}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-blue-600 dark:text-blue-400 text-sm">ج.م {Number(transaction.total_amount || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                </div>
              </div>
            )) : (
              <p className="text-center text-slate-400 py-8 text-sm">لا توجد معاملات بعد</p>
            )}
          </div>
          
          {canViewAudit && activityLogs.length > 0 && (
            <div className="mt-8 pt-8 border-t border-slate-100 dark:border-slate-800">
              <h2 className="text-sm font-bold text-slate-400 mb-3">سجل النشاط المحلي</h2>
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

      {selectedInvoiceId && !loadingReceipt && (
        <ReceiptDetailsModal 
          invoice={{
            id: selectedInvoiceId,
            total_amount: recentTransactions.find(t => t.id === selectedInvoiceId)?.total_amount || 0,
            created_at: recentTransactions.find(t => t.id === selectedInvoiceId)?.created_at || new Date().toISOString(),
            payment_method: recentTransactions.find(t => t.id === selectedInvoiceId)?.payment_method || 'cash',
            discount_amount: recentTransactions.find(t => t.id === selectedInvoiceId)?.discount_amount || 0,
            additional_fees: recentTransactions.find(t => t.id === selectedInvoiceId)?.additional_fees || 0,
            points_redeemed: recentTransactions.find(t => t.id === selectedInvoiceId)?.points_redeemed || 0,
            loyalty_discount_amount: recentTransactions.find(t => t.id === selectedInvoiceId)?.loyalty_discount_amount || 0,
            profiles: { full_name: 'Cashier' }, // Adjust if you have actual staff names
            patients: recentTransactions.find(t => t.id === selectedInvoiceId)?.patient_name 
              ? { full_name: recentTransactions.find(t => t.id === selectedInvoiceId)?.patient_name, phone: '' } 
              : null,
            sales_items: invoiceItems.map((item: any) => ({
              quantity_sold: item.quantity_sold,
              unit_price: item.unit_price,
              inventory: { master_drugs: { trade_name: item.trade_name, trade_name_en: item.trade_name_en || item.trade_name } },
              trade_name: item.trade_name,
              trade_name_en: item.trade_name_en || item.trade_name,
              active_ingredient: item.active_ingredient,
              unit: item.unit,
            }))
          } as any}
          onClose={() => setSelectedInvoiceId(null)}
        />
      )}
    </div>
  );
}

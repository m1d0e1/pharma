
import { dbSelect, dbExecute, dbGet, dbTransaction, normalizeDatabaseTimestamps } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';

const db = {
  prepare: (sql) => ({
    all: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbSelect(sql, args);
    },
    get: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbGet(sql, args);
    },
    run: async (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      const res = await dbExecute(sql, args);
      return {
        changes: res.rowsAffected,
        lastInsertRowid: res.lastInsertId,
        rowsAffected: res.rowsAffected,
        lastInsertId: res.lastInsertId
      };
    }
  }),
  transaction: (cb) => {
    return (...args) => dbTransaction(async (transactionDb) => await cb(transactionDb, ...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { localDate } from '@/lib/time';
import { getShiftForPharmacy } from './shifts';
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

type NativeSalesReportKey = 'reports.trend' | 'reports.sales_history' |
  'reports.top_drugs' | 'reports.categories' | 'reports.total_units' | 'reports.kpis';

/** A native query ID, bounded day count, and pagination only. Never send SQL,
 * a claimed actor, or pharmacy ID over Tauri IPC for financial reporting. */
async function nativeSalesReportRows(
  queryId: NativeSalesReportKey,
  days: number,
  paginated: boolean,
): Promise<any[]> {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error('Reporting date range must be 1-366 days');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const pageSize = paginated ? 200 : 1;
  const rows: any[] = [];
  // The native policy limits offset to 50,000; fail rather than truncate.
  for (let offset = 0; offset <= 50_000; offset += pageSize) {
    const page = await invoke<any[]>('db_read_scoped', {
      queryId,
      recordId: null,
      limit: pageSize,
      offset,
      search: String(days),
      drugId: null,
    });
    if (!Array.isArray(page) || page.length > pageSize) {
      throw new Error('Invalid native reporting result page');
    }
    rows.push(...page);
    if (!paginated || page.length < pageSize) return rows;
  }
  throw new Error('Reporting history exceeds native paging capacity; streaming export required');
}

async function nativeShiftReportRows(
  queryId: 'reports.shift_header' | 'reports.shift_sales' |
    'reports.shift_returns' | 'reports.shift_movements',
  shiftId: string,
): Promise<any[]> {
  if (!shiftId || shiftId.length > 128 || shiftId.includes('\0')) {
    throw new Error('Invalid shift identifier');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const header = queryId === 'reports.shift_header';
  const pageSize = header ? 1 : 200;
  const rows: any[] = [];
  for (let offset = 0; offset <= 50_000; offset += pageSize) {
    const page = await invoke<any[]>('db_read_scoped', {
      queryId,recordId:shiftId,search:null,drugId:null,
      limit:pageSize,offset,
    });
    if (!Array.isArray(page) || page.length > pageSize || page.some(row =>
      !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Invalid native shift report page');
    }
    rows.push(...page);
    if (header || page.length < pageSize) return rows;
  }
  throw new Error('Native shift report exceeds bounded pagination');
}

export async function getShiftReportAction(shiftId: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_shifts')) return { success: false, error: 'غير مصرح' };
    // Web compatibility reports must bind *every* financial row to a verified
    // tenant, not merely verify the parent shift ID. Legacy NULL owners are
    // unknown provenance, even when the current tenant is `local_default`.
    const pharmacyId = typeof user.pharmacy_id === 'string' ? user.pharmacy_id.trim() : '';
    if (!isTauri && (!pharmacyId || !await getShiftForPharmacy(shiftId, pharmacyId))) {
      return { success: false, error: 'الوردية غير موجودة أو لا تخص هذه الصيدلية' };
    }

    // 1. Shift Basic Info
    const shift = isTauri ? (await nativeShiftReportRows('reports.shift_header',shiftId))[0] : await db.prepare(`
      SELECT s.*, u.full_name as staff_name
      FROM shifts s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.pharmacy_id = ?
    `).get(shiftId, pharmacyId) as any;

    if (!shift) return { success: false, error: 'الوردية غير موجودة' };

    // 2. Sales Summary by Method
    const sales = isTauri ? await nativeShiftReportRows('reports.shift_sales',shiftId) : await db.prepare(`
      SELECT 
        payment_method,
        COUNT(*) as count,
        SUM(total_amount) as total,
        SUM(COALESCE(paid_amount, total_amount)) as paid,
        SUM(COALESCE(remaining_amount, 0)) as remaining
      FROM sales_invoices
      WHERE shift_id = ? AND pharmacy_id = ?
        AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
      GROUP BY payment_method
    `).all(shiftId, pharmacyId) as any[];

    // 3. Returns Summary
    const returns = isTauri ? await nativeShiftReportRows('reports.shift_returns',shiftId) : await db.prepare(`
      SELECT 
        refund_method,
        COUNT(*) as count,
        SUM(total_refund) as total
      FROM returns
      WHERE shift_id = ? AND pharmacy_id = ?
        AND (status IS NULL OR status = '' OR LOWER(status) IN ('approved', 'completed'))
      GROUP BY refund_method
    `).all(shiftId, pharmacyId) as any[];

    // 4. Cash Movements (Manual)
    const movements = isTauri ? await nativeShiftReportRows('reports.shift_movements',shiftId) : await db.prepare(`
      SELECT 
        type,
        category,
        SUM(amount) as total
      FROM cash_movements
      WHERE shift_id = ? AND pharmacy_id = ?
        AND LOWER(COALESCE(source_type, '')) <> 'main_safe'
      GROUP BY type, category
    `).all(shiftId, pharmacyId) as any[];

    // 5. Calculate Expected Cash (Only Cash & Delivery)
    const cashSales = sales.filter(s => s.payment_method === 'cash').reduce((sum, s) => sum + (s.total || 0), 0);
    const cashReturns = returns.find(r => r.refund_method === 'cash')?.total || 0;
    const cashReceipts = movements.filter(m => ['receipt', 'in'].includes(m.type)).reduce((sum, m) => sum + (m.total || 0), 0);
    const cashHandover = movements.filter(m => ['disbursement', 'out'].includes(m.type) && m.category === 'handover').reduce((sum, m) => sum + (m.total || 0), 0);
    const cashDisbursements = movements.filter(m => ['disbursement', 'out'].includes(m.type)).reduce((sum, m) => sum + (m.total || 0), 0);

    const expectedCash = (shift.starting_cash || 0) + cashSales - cashReturns + cashReceipts - cashDisbursements;
    // Closing counts are captured before the handover transfer and reconciliation.
    const hasClosingCount = shift.status !== 'open' && shift.actual_cash != null && shift.cash_difference != null;
    const actualCash = hasClosingCount ? Number(shift.actual_cash) : shift.ending_cash;
    const difference = hasClosingCount ? Number(shift.cash_difference) : (actualCash != null ? actualCash - expectedCash : 0);

    return {
      success: true,
      data: {
        shift,
        sales,
        returns,
        movements,
        summary: {
          cashSales,
          cashReturns,
          cashReceipts,
          cashDisbursements,
          cashHandover,
          expectedCash: hasClosingCount ? actualCash - difference : expectedCash,
          actualCash,
          difference
        }
      }
    };
  } catch (error) {
    console.error('Get shift report error:', error);
    return { success: false, error: 'فشل جلب تقرير الوردية' };
  }
}

// Pre-compiled prepared statements for reports actions
const getSalesTodayStmt = db.prepare(`
  SELECT COALESCE(SUM(inv.total_amount), 0) as total,
         (SELECT COALESCE(SUM(
            CASE 
              WHEN (si.unit IN ('medium', 'strip', 'شريط') OR si.unit = md.medium_unit) AND COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1) > 0
                THEN (si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1)) * si.cost_price
              WHEN (si.unit = 'small' OR si.unit = md.small_unit) AND (COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1) * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1)) > 0
                THEN (si.quantity_sold / (COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1) * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1))) * si.cost_price
              ELSE si.quantity_sold * si.cost_price
            END
          ), 0) 
          FROM sales_items si
          LEFT JOIN master_drugs md ON si.drug_id = md.id
          WHERE si.invoice_id IN (
            SELECT id
            FROM sales_invoices
            WHERE date(created_at, 'localtime') = ?
              AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
              AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          )) as total_cogs
  FROM sales_invoices inv
  WHERE date(inv.created_at, 'localtime') = ?
    AND (inv.status IS NULL OR inv.status = '' OR inv.status IN ('completed', 'approved', 'delivered'))
    AND (inv.pharmacy_id = ? OR (inv.pharmacy_id IS NULL AND ? = 'local_default'))
`);

const getAccountIdStmt = db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?');

const getLiquidityStmt = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN je.type = 'debit' THEN je.amount ELSE -je.amount END), 0) as balance
  FROM journal_entries je
  JOIN daily_journals dj ON dj.id = je.journal_id
  WHERE je.account_id = ?
    AND (dj.pharmacy_id = ? OR (dj.pharmacy_id IS NULL AND ? = 'local_default'))
`);

const getPendingDeliveryStmt = db.prepare(`
  SELECT COALESCE(SUM(total_amount), 0) as total
  FROM sales_invoices
  WHERE payment_method = 'delivery' AND status = 'completed'
    AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
`);

const getShrinkageStmt = db.prepare(`
  SELECT COALESCE(SUM((old_quantity - new_quantity) * i.cost_price), 0) as total_loss
  FROM stock_adjustments sa
  JOIN inventory i ON sa.inventory_id = i.id
  WHERE date(sa.created_at, 'localtime') = ? AND new_quantity < old_quantity
    AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
`);

const getStockAlertsStmt = db.prepare(`
  SELECT COUNT(*) as count
  FROM (
    SELECT i.drug_id
    FROM inventory i
    LEFT JOIN master_drugs m ON i.drug_id = m.id
    WHERE (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
      AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
    GROUP BY i.drug_id
    HAVING SUM(
      CASE
        WHEN COALESCE(m.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL
          THEN COALESCE(i.quantity, 0)
        ELSE 0
      END
    ) <= COALESCE(MAX(m.reorder_point), 5)
  ) low_stock_drugs
`);

const getSalesTrendStmt = db.prepare(`
  WITH RECURSIVE dates(date) AS (
    SELECT date('now', ?, 'localtime')
    UNION ALL
    SELECT date(date, '+1 day')
    FROM dates
    WHERE date < date('now', 'localtime')
  ),
  daily_sales AS (
    SELECT date(created_at, 'localtime') as date, SUM(total_amount) as total
    FROM sales_invoices
    WHERE (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    GROUP BY date(created_at, 'localtime')
  ),
  daily_returns AS (
    SELECT date(r.created_at, 'localtime') as date, SUM(r.total_refund) as total
    FROM returns r
    WHERE LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
      AND (r.pharmacy_id = ? OR (r.pharmacy_id IS NULL AND ? = 'local_default'))
    GROUP BY date(r.created_at, 'localtime')
  )
  SELECT 
    d.date,
    COALESCE(s.total, 0) as sales,
    COALESCE(r.total, 0) as returns,
    (COALESCE(s.total, 0) - COALESCE(r.total, 0)) as net_sales
  FROM dates d
  LEFT JOIN daily_sales s ON s.date = d.date
  LEFT JOIN daily_returns r ON r.date = d.date
  ORDER BY d.date ASC
`);


const _getDashboardKPIs = unstable_cache(
  async (today: string, pharmacyId: string) => {
    // 1. Sales Today
    const salesToday = await getSalesTodayStmt.get(
      today, pharmacyId, pharmacyId,
      today, pharmacyId, pharmacyId
    ) as any;

    // 2. Current Liquidity (Cash Drawer Account Balance)
    const cashAccRow = await getAccountIdStmt.get('cash_drawer') as any;
    const cashAccId = cashAccRow?.account_id || 6;
    const liquidity = await getLiquidityStmt.get(cashAccId, pharmacyId, pharmacyId) as any;

    // 2.5 Pending Delivery Cash
    const pendingDelivery = await getPendingDeliveryStmt.get(pharmacyId, pharmacyId) as any;

    // 3. Inventory Shrinkage (Value of adjustments today)
    const shrinkage = await getShrinkageStmt.get(today, pharmacyId, pharmacyId) as any;

    // 4. Critical Stock Alerts
    const alerts = await getStockAlertsStmt.get(pharmacyId, pharmacyId) as any;

    return {
      sales_today: salesToday.total,
      gross_profit_today: salesToday.total - salesToday.total_cogs,
      liquidity: liquidity.balance,
      pending_delivery_cash: pendingDelivery.total,
      shrinkage_today: shrinkage.total_loss,
      stock_alerts_count: alerts.count
    };
  },
  ['dashboard-kpis'],
  { revalidate: 30 } // Cache for 30 seconds
);

export async function getDashboardKPIsAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };

    const today = localDate();
    const pharmacyId = user.pharmacy_id || 'local_default';
    const data = isTauri
      ? (await nativeSalesReportRows('reports.kpis', 1, false))[0]
      : await _getDashboardKPIs(today, pharmacyId);
    if (!data) throw new Error('Missing native dashboard KPI aggregate');
    return { success: true, data };
  } catch (error) {
    console.error('KPI error:', error);
    return { success: false, error: 'فشل جلب المؤشرات الرئيسية' };
  }
}

const _getSalesTrend = unstable_cache(
  async (dayParam: string, pharmacyId: string) => {
    return await getSalesTrendStmt.all(
      dayParam,
      pharmacyId, pharmacyId,
      pharmacyId, pharmacyId
    ) as any[];
  },
  ['sales-trend'],
  { revalidate: 30 }
);

export async function getSalesTrendAction(days: number = 30) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };

    const pharmacyId = user.pharmacy_id || 'local_default';
    const results = isTauri
      ? await nativeSalesReportRows('reports.trend', days, true)
      : await _getSalesTrend('-' + (days - 1) + ' days', pharmacyId);

    return { success: true, data: results };
  } catch (error) {
    console.error('Sales trend error:', error);
    return { success: false, error: 'فشل جلب اتجاه المبيعات' };
  }
}

type DashboardReadKey = 'dashboard.drug_count' | 'dashboard.trend' | 'dashboard.top_items' |
  'dashboard.recent_sales' | 'dashboard.audit_logs';

export async function getDashboardReadAction(queryId: DashboardReadKey) {
  try {
    const user = await getLocalSession();
    if (!user ||
        (queryId === 'dashboard.audit_logs'
          ? !hasUserPermissionSync(user, 'can_view_audit')
          : queryId !== 'dashboard.drug_count' && !hasUserPermissionSync(user, 'rep_can_view_sales'))) {
      return { success: false, error: 'غير مصرح' };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const limit = queryId === 'dashboard.trend' ? 30 : queryId === 'dashboard.drug_count' ? 1 : 5;
    const rows = await invoke<any[]>('db_read_scoped', {
      queryId, recordId: null, limit, offset: 0, search: null, drugId: null,
    });
    if (!Array.isArray(rows) || rows.length > limit || rows.some(row =>
      !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Invalid native dashboard read result');
    }
    return { success: true, data: rows };
  } catch (error) {
    console.error('Dashboard read error:', error);
    return { success: false, error: 'فشل جلب بيانات لوحة التحكم' };
  }
}

export async function getReportsDataAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };

    if (isTauri) {
      const [salesHistoryRaw, topDrugsRaw, categoryRaw, totalUnits] = await Promise.all([
        nativeSalesReportRows('reports.sales_history', 30, true),
        nativeSalesReportRows('reports.top_drugs', 30, false),
        nativeSalesReportRows('reports.categories', 30, false),
        nativeSalesReportRows('reports.total_units', 30, false),
      ]);
      return { success: true, data: {
        salesHistoryRaw: normalizeDatabaseTimestamps(salesHistoryRaw),
        topDrugsRaw,
        categoryRaw,
        totalUnitsSold: Number(totalUnits[0]?.total || 0),
      } };
    }

    const thirtyDaysAgo = new Date();
    // Inclusive window: today plus the previous 29 calendar days = 30 days.
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    const dateStr = localDate(thirtyDaysAgo);
    const pharmacyId = user.pharmacy_id || 'local_default';
    const pharmacyClause = ` AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))`;
    const pharmacyParams = [pharmacyId, pharmacyId];

    const salesHistoryRaw = await dbSelect(`
      SELECT created_at, date(created_at, 'localtime') as local_date, total_amount
      FROM sales_invoices 
      WHERE date(created_at, 'localtime') >= ? AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))${pharmacyClause}
    `, [dateStr, ...pharmacyParams]) as any[];

    const topDrugsRaw = await dbSelect(`
      SELECT md.trade_name, SUM(
        CASE
          WHEN si.unit IN ('medium', 'strip', 'شريط') OR si.unit = md.medium_unit
            THEN si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1)
          WHEN si.unit = 'small' OR si.unit = md.small_unit
            THEN si.quantity_sold / (
              COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1)
              * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1)
            )
          ELSE si.quantity_sold
        END
      ) as quantity_sold
      FROM sales_items si
      JOIN sales_invoices inv ON inv.id = si.invoice_id
      JOIN master_drugs md ON si.drug_id = md.id
      WHERE date(inv.created_at, 'localtime') >= ?
        AND (inv.pharmacy_id = ? OR (inv.pharmacy_id IS NULL AND ? = 'local_default'))
        AND (inv.status IS NULL OR inv.status = '' OR inv.status IN ('completed', 'approved', 'delivered'))
      GROUP BY md.trade_name 
      ORDER BY quantity_sold DESC 
      LIMIT 5
    `, [dateStr, ...pharmacyParams]) as any[];

    const categoryRaw = await dbSelect(`
      SELECT md.category, SUM(
        CASE
          WHEN si.unit IN ('medium', 'strip', 'شريط') OR si.unit = md.medium_unit
            THEN si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1)
          WHEN si.unit = 'small' OR si.unit = md.small_unit
            THEN si.quantity_sold / (
              COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(md.large_to_medium, 0), 1)
              * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1)
            )
          ELSE si.quantity_sold
        END
      ) as quantity_sold
      FROM sales_items si
      JOIN sales_invoices inv ON inv.id = si.invoice_id
      JOIN master_drugs md ON si.drug_id = md.id
      WHERE date(inv.created_at, 'localtime') >= ?
        AND (inv.pharmacy_id = ? OR (inv.pharmacy_id IS NULL AND ? = 'local_default'))
        AND (inv.status IS NULL OR inv.status = '' OR inv.status IN ('completed', 'approved', 'delivered'))
      GROUP BY md.category 
      ORDER BY quantity_sold DESC 
      LIMIT 6
    `, [dateStr, ...pharmacyParams]) as any[];

    const totalUnitsRow = await dbGet(`
      SELECT COALESCE(SUM(si.quantity_sold), 0) as total
      FROM sales_items si
      JOIN sales_invoices inv ON inv.id = si.invoice_id
      WHERE date(inv.created_at, 'localtime') >= ?
        AND (inv.pharmacy_id = ? OR (inv.pharmacy_id IS NULL AND ? = 'local_default'))
        AND (inv.status IS NULL OR inv.status = '' OR inv.status IN ('completed', 'approved', 'delivered'))
    `, [dateStr, ...pharmacyParams]) as any;

    return { 
      success: true, 
      data: {
        salesHistoryRaw,
        topDrugsRaw,
        categoryRaw,
        totalUnitsSold: Number(totalUnitsRow?.total || 0),
      } 
    };
  } catch (error) {
    console.error('getReportsDataAction error:', error);
    return { success: false, error: 'فشل جلب التقارير' };
  }
}

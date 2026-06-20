
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};
const initLocalDb = () => {};
const clearAuditLogs = async () => {
  try {
    await dbExecute('DELETE FROM activity_log');
    return true;
  } catch (e) {
    console.error('Failed to clear activity logs:', e);
    return false;
  }
};

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
    return (...args) => dbTransaction(async () => await cb(...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function getShiftReportAction(shiftId: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_shifts')) return { success: false, error: 'غير مصرح' };

    // 1. Shift Basic Info
    const shift = await db.prepare(`
      SELECT s.*, u.full_name as staff_name
      FROM shifts s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ?
    `).get(shiftId) as any;

    if (!shift) return { success: false, error: 'الوردية غير موجودة' };

    // 2. Sales Summary by Method
    const sales = await db.prepare(`
      SELECT 
        payment_method,
        COUNT(*) as count,
        SUM(total_amount) as total,
        SUM(COALESCE(paid_amount, total_amount)) as paid,
        SUM(COALESCE(remaining_amount, 0)) as remaining
      FROM sales_invoices
      WHERE shift_id = ?
      GROUP BY payment_method
    `).all(shiftId) as any[];

    // 3. Returns Summary
    const returns = await db.prepare(`
      SELECT 
        refund_method,
        COUNT(*) as count,
        SUM(total_refund) as total
      FROM returns
      WHERE shift_id = ?
      GROUP BY refund_method
    `).all(shiftId) as any[];

    // 4. Cash Movements (Manual)
    const movements = await db.prepare(`
      SELECT 
        type,
        category,
        SUM(amount) as total
      FROM cash_movements
      WHERE shift_id = ?
      GROUP BY type, category
    `).all(shiftId) as any[];

    // 5. Calculate Expected Cash (Only Cash & Delivery)
    const cashSales = sales.filter(s => ['cash', 'delivery'].includes(s.payment_method)).reduce((sum, s) => sum + (s.paid || s.total || 0), 0);
    const cashReturns = returns.find(r => r.refund_method === 'cash')?.total || 0;
    const cashReceipts = movements.filter(m => m.type === 'receipt').reduce((sum, m) => sum + m.total, 0);
    const cashDisbursements = movements.filter(m => m.type === 'disbursement').reduce((sum, m) => sum + m.total, 0);

    const expectedCash = (shift.starting_cash || 0) + cashSales - cashReturns + cashReceipts - cashDisbursements;

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
          expectedCash,
          actualCash: shift.ending_cash,
          difference: shift.ending_cash ? (shift.ending_cash - expectedCash) : 0
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
  SELECT COALESCE(SUM(total_amount), 0) as total,
         (SELECT COALESCE(SUM(quantity_sold * cost_price), 0) 
          FROM sales_items 
          WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE created_at >= ? AND created_at <= ? AND status = 'completed')) as total_cogs
  FROM sales_invoices
  WHERE created_at >= ? AND created_at <= ? AND status = 'completed'
`);

const getAccountIdStmt = db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?');

const getLiquidityStmt = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE -amount END), 0) as balance
  FROM journal_entries
  WHERE account_id = ?
`);

const getPendingDeliveryStmt = db.prepare(`
  SELECT COALESCE(SUM(total_amount), 0) as total
  FROM sales_invoices
  WHERE payment_method = 'delivery' AND status = 'completed'
`);

const getShrinkageStmt = db.prepare(`
  SELECT COALESCE(SUM((old_quantity - new_quantity) * i.cost_price), 0) as total_loss
  FROM stock_adjustments sa
  JOIN inventory i ON sa.inventory_id = i.id
  WHERE sa.created_at >= ? AND sa.created_at <= ? AND new_quantity < old_quantity
`);

const getStockAlertsStmt = db.prepare(`
  SELECT COUNT(*) as count
  FROM inventory i
  LEFT JOIN master_drugs m ON i.drug_id = m.id
  WHERE i.quantity <= COALESCE(m.reorder_point, 5)
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
    SELECT date(created_at) as date, SUM(total_amount) as total
    FROM sales_invoices
    WHERE status = 'completed'
    GROUP BY date(created_at)
  ),
  daily_returns AS (
    SELECT date(created_at) as date, SUM(total_refund) as total
    FROM returns
    WHERE status = 'approved'
    GROUP BY date(created_at)
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
  async (today: string, startOfDay: string, endOfDay: string) => {
    // 1. Sales Today
    const salesToday = await getSalesTodayStmt.get(startOfDay, endOfDay, startOfDay, endOfDay) as any;

    // 2. Current Liquidity (Cash Drawer Account Balance)
    const cashAccRow = await getAccountIdStmt.get('cash_drawer') as any;
    const cashAccId = cashAccRow?.account_id || 6;
    const liquidity = await getLiquidityStmt.get(cashAccId) as any;

    // 2.5 Pending Delivery Cash
    const pendingDelivery = await getPendingDeliveryStmt.get() as any;

    // 3. Inventory Shrinkage (Value of adjustments today)
    const shrinkage = await getShrinkageStmt.get(startOfDay, endOfDay) as any;

    // 4. Critical Stock Alerts
    const alerts = await getStockAlertsStmt.get() as any;

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

    const today = new Date().toISOString().split('T')[0];
    const startOfDay = today + ' 00:00:00';
    const endOfDay = today + ' 23:59:59';

    const data = await _getDashboardKPIs(today, startOfDay, endOfDay);
    return { success: true, data };
  } catch (error) {
    console.error('KPI error:', error);
    return { success: false, error: 'فشل جلب المؤشرات الرئيسية' };
  }
}

const _getSalesTrend = unstable_cache(
  async (dayParam: string) => {
    return await getSalesTrendStmt.all(dayParam) as any[];
  },
  ['sales-trend'],
  { revalidate: 30 }
);

export async function getSalesTrendAction(days: number = 30) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };

    const results = await _getSalesTrend('-' + (days - 1) + ' days');

    return { success: true, data: results };
  } catch (error) {
    console.error('Sales trend error:', error);
    return { success: false, error: 'فشل جلب اتجاه المبيعات' };
  }
}

export async function getReportsDataAction() { return { success: false, data: {} }; }

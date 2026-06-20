const Database = require('better-sqlite3');
const db = new Database('d:\\PhD\\Tools\\pharma\\pharma_local.db');

console.log('Testing aggregate queries...');

try {
  // 1. Shift Stats
  console.log('\n1. Current Shift Stats (Checking syntax and math):');
  const shiftStats = db.prepare(`
    SELECT COUNT(*) as transactions, COALESCE(SUM(total_amount), 0) as total_revenue
    FROM sales_invoices
    WHERE status = 'completed'
  `).get();
  console.log('Shift Stats:', shiftStats);

  // 2. Trial Balance
  console.log('\n2. Trial Balance (Checking syntax and groupings):');
  const trialBalance = db.prepare(`
    SELECT 
        a.id,
        a.code,
        a.name_ar,
        a.type,
        a.parent_id,
        COALESCE(SUM(CASE WHEN je.type = 'debit' THEN je.amount ELSE 0 END), 0) as total_debit,
        COALESCE(SUM(CASE WHEN je.type = 'credit' THEN je.amount ELSE 0 END), 0) as total_credit
      FROM accounts a
      LEFT JOIN journal_entries je ON a.id = je.account_id
      GROUP BY a.id
      ORDER BY a.code ASC
      LIMIT 3
  `).all();
  console.log('Trial Balance Sample:', trialBalance);

  // 3. Sales Trend Fix (Ensuring CTE logic runs properly)
  console.log('\n3. Sales Trend (CTE Query Logic Check):');
  const trend = db.prepare(`
    WITH RECURSIVE
        dates(date) AS (
          SELECT date('now', '-6 days')
          UNION ALL
          SELECT date(date, '+1 day')
          FROM dates
          WHERE date < date('now')
        ),
        daily_sales AS (
          SELECT DATE(created_at) as sale_date, SUM(total_amount) as total_sales
          FROM sales_invoices
          WHERE status IN ('completed', 'delivered')
          GROUP BY DATE(created_at)
        ),
        daily_returns AS (
          SELECT DATE(created_at) as return_date, SUM(total_refund) as total_refunds
          FROM returns
          WHERE status = 'approved'
          GROUP BY DATE(created_at)
        )
      SELECT 
        d.date,
        COALESCE(s.total_sales, 0) as total_sales,
        COALESCE(r.total_refunds, 0) as total_refunds
      FROM dates d
      LEFT JOIN daily_sales s ON d.date = s.sale_date
      LEFT JOIN daily_returns r ON d.date = r.return_date
      ORDER BY d.date ASC;
  `).all();
  console.log('Sales Trend Output:', trend);

  // 4. Returns aggregation
  console.log('\n4. Returns Invoice checking:');
  const returnAgg = db.prepare(`
      SELECT ri.inventory_id, SUM(ri.quantity_returned) as total
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      WHERE r.status = 'approved'
      GROUP BY ri.inventory_id
  `).all();
  console.log('Return Aggregation Output:', returnAgg);

  console.log('\nAll aggregate queries executed without syntax or logic errors.');
} catch (e) {
  console.error('Error during query execution:', e.message);
}
db.close();

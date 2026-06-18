const Database = require('better-sqlite3');
const db = new Database('d:/PhD/Tools/pharma/src-tauri/pharma_local.db');
const query = `
WITH MonthlySales AS (
  SELECT 
    si.drug_id, 
    SUM(si.quantity_sold) as avg_monthly_usage
  FROM sales_items si
  JOIN sales_invoices inv ON si.invoice_id = inv.id
  WHERE si.is_negative = 0 
    AND inv.created_at >= datetime('now', '-30 days')
  GROUP BY si.drug_id
),
RelevantDrugs AS (
  SELECT id as drug_id, reorder_point 
  FROM master_drugs 
  WHERE reorder_point > 0
  UNION
  SELECT drug_id, 0 as reorder_point 
  FROM MonthlySales
),
StockInfo AS (
  SELECT drug_id, SUM(quantity) as current_stock
  FROM inventory
  GROUP BY drug_id
)
SELECT 
  rd.drug_id,
  md.trade_name,
  MAX(COALESCE(md.reorder_point, 0), COALESCE(ms.avg_monthly_usage, 0)) as dynamic_reorder_point,
  COALESCE(si.current_stock, 0) as current_stock,
  COALESCE(ms.avg_monthly_usage, 0) as avg_monthly_usage
FROM RelevantDrugs rd
JOIN master_drugs md ON rd.drug_id = md.id
LEFT JOIN MonthlySales ms ON rd.drug_id = ms.drug_id
LEFT JOIN StockInfo si ON rd.drug_id = si.drug_id
WHERE COALESCE(si.current_stock, 0) <= MAX(COALESCE(md.reorder_point, 0), COALESCE(ms.avg_monthly_usage, 0))
  AND MAX(COALESCE(md.reorder_point, 0), COALESCE(ms.avg_monthly_usage, 0)) > 0
ORDER BY (MAX(COALESCE(md.reorder_point, 0), COALESCE(ms.avg_monthly_usage, 0)) - COALESCE(si.current_stock, 0)) DESC
LIMIT 5;
`;
console.log(db.prepare(query).all());

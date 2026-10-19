-- The original owner can retain NULL pharmacy_id after enrollment. Native
-- transactions interpret that owner as local_default, but the immutable 043
-- sale/COGS triggers correctly demand an explicit tenant on the source actor.
-- Assign the original owner the already-authorized local_default scope only
-- when no other explicit pharmacy is present. Never infer cross-branch owner
-- rights or rewrite another owner's tenant, source rows, or existing receipts.
UPDATE users
SET pharmacy_id='local_default'
WHERE id='admin'
  AND LOWER(COALESCE(role,''))='owner'
  AND COALESCE(is_active,1)=1
  AND NULLIF(TRIM(pharmacy_id),'') IS NULL
  AND NOT EXISTS (SELECT 1 FROM users
                  WHERE NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                    AND TRIM(pharmacy_id)<>'local_default')
  AND NOT EXISTS (SELECT 1 FROM inventory
                  WHERE NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                    AND TRIM(pharmacy_id)<>'local_default')
  AND NOT EXISTS (SELECT 1 FROM sales_invoices
                  WHERE NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                    AND TRIM(pharmacy_id)<>'local_default')
  AND NOT EXISTS (SELECT 1 FROM purchase_invoices
                  WHERE NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                    AND TRIM(pharmacy_id)<>'local_default')
  AND NOT EXISTS (SELECT 1 FROM returns
                  WHERE NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                    AND TRIM(pharmacy_id)<>'local_default')
  AND NOT EXISTS (SELECT 1 FROM shifts
                  WHERE NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                    AND TRIM(pharmacy_id)<>'local_default')
  AND NOT EXISTS (SELECT 1 FROM daily_journals
                  WHERE NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                    AND TRIM(pharmacy_id)<>'local_default')
  AND NOT EXISTS (SELECT 1 FROM cash_movements
                  WHERE NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                    AND TRIM(pharmacy_id)<>'local_default');

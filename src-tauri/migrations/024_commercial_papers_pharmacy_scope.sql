-- Commercial papers are branch-owned finance records. Legacy rows had no
-- trustworthy actor/branch link, so compatibility assigns them to local_default.
-- This migration also introduces explicit GL destinations for the manual cash
-- categories that previously fell through to COGS.
INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group) VALUES
  ('3.2', 'إيرادات نقدية أخرى', 'Other Cash Income', 'revenue', 0),
  ('3.3', 'تسويات نقدية للموردين', 'Supplier Cash Adjustments', 'revenue', 0),
  ('3.8', 'مسحوبات المالك', 'Owner Drawings', 'equity', 0),
  ('4.4', 'مصروفات تشغيلية عامة', 'General Operating Expenses', 'expense', 0);

WITH required(category, code) AS (VALUES
  ('other_cash_income', '3.2'),
  ('supplier_cash_adjustments', '3.3'),
  ('owner_drawings', '3.8'),
  ('general_operating_expenses', '4.4')
)
INSERT OR IGNORE INTO trial_balance_settings (category, target_type, account_id)
SELECT r.category, 'account', a.id
FROM required r JOIN accounts a ON a.code = r.code;

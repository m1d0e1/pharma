-- Migration 1 is not rerun on upgraded installations; seed rows added to it later need their own migration.
INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group) VALUES
  ('1.1.1', 'الصندوق', 'Cash Drawer', 'asset', 0),
  ('2.1', 'دائنون', 'Accounts Payable', 'liability', 0),
  ('1.1.2', 'حسابات العملاء', 'Accounts Receivable', 'asset', 0),
  ('3.1', 'إيرادات المبيعات', 'Sales Revenue', 'revenue', 0),
  ('1.1.3', 'المخزون السلعي', 'Inventory Asset', 'asset', 0),
  ('4.1', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'expense', 0);

INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'cash_drawer', 'account', id FROM accounts
WHERE code = '1.1.1' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'cash_drawer');
INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'accounts_payable', 'account', id FROM accounts
WHERE code = '2.1' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'accounts_payable');
INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'accounts_receivable', 'account', id FROM accounts
WHERE code = '1.1.2' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'accounts_receivable');
INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'sales_revenue', 'account', id FROM accounts
WHERE code = '3.1' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'sales_revenue');
INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'inventory_asset', 'account', id FROM accounts
WHERE code = '1.1.3' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'inventory_asset');
INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'cogs_expense', 'account', id FROM accounts
WHERE code = '4.1' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'cogs_expense');

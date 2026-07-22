-- Accounts required by patient collections, wallet sales, notices, and opening balances.
INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group) VALUES
  ('1.1.4', 'تسويات البنوك', 'Bank Clearing', 'asset', 0),
  ('2.2', 'أرصدة محافظ العملاء', 'Patient Wallet Liability', 'liability', 0),
  ('4.2', 'تسويات حسابات العملاء', 'Customer Adjustments', 'expense', 0),
  ('3.9', 'حقوق ملكية الأرصدة الافتتاحية', 'Opening Balance Equity', 'equity', 0);

INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'bank_clearing', 'account', id FROM accounts
WHERE code = '1.1.4' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'bank_clearing');

INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'patient_wallet_liability', 'account', id FROM accounts
WHERE code = '2.2' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'patient_wallet_liability');

INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'customer_adjustments', 'account', id FROM accounts
WHERE code = '4.2' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'customer_adjustments');

INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'opening_balance_equity', 'account', id FROM accounts
WHERE code = '3.9' AND NOT EXISTS (SELECT 1 FROM trial_balance_settings WHERE category = 'opening_balance_equity');
